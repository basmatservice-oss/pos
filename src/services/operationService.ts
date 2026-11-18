import {
  db,
  SyncOperation,
  ReturnRecord,
  ReturnItem,
  PurchaseReturn,
  PurchaseReturnItem,
} from '../db/db';
import { apiService, getAuthToken } from './apiService';
import { generateUUID } from '../utils/uuid';
import { useSyncStore } from '../store/syncStore';
import { roundQty } from '../utils/format';
import { consumeLocalInventoryFIFO, restoreLocalInventoryFIFO, recordLocalInventoryMovement } from './localInventoryEngine';
import { postLocalJournalEntry, reverseLocalJournalEntriesByReference, setLocalAccountingStandaloneMode } from './localAccountingEngine';
import { reconcileLocalOperationAfterAck } from './localOperationReconciliation';
import { enqueueNativePosOperation, acknowledgeNativePosOperation, markNativePosOperationError, markNativePosOperationConflict, isNativeAndroid } from '../native/posLocalDatabase';
import { flushNativeDatabaseMirrorWrites } from './nativeDatabaseMirror';
import { nativePosRepository, NATIVE_POS_ENTITIES } from '../native/nativePosRepository';

const DEVICE_ID_KEY = 'pos_device_id';
let currentDeviceRole: 'server' | 'client' | 'standalone' = 'server';

export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function getLocalSettingByKey(key: string): Promise<{ key: string; value: any } | undefined> {
  if (isNativeAndroid()) {
    return (await nativePosRepository.firstWhereEquals<{ key: string; value: any }>('settings', 'key', key)) ?? undefined;
  }
  return db.settings.where('key').equals(key).first();
}

async function getLocalRecord<T extends Record<string, any>>(entity: any, key: unknown): Promise<T | undefined> {
  if (isNativeAndroid()) return (await nativePosRepository.get<T>(entity, key)) ?? undefined;
  return (await (db as any)[entity].get(key)) ?? undefined;
}

async function getLocalRecordsByIndex<T extends Record<string, any>>(
  entity: any,
  indexName: string,
  value: string | number | boolean,
): Promise<T[]> {
  if (isNativeAndroid()) return nativePosRepository.whereEquals<T>(entity, indexName, value);
  return (await (db as any)[entity].where(indexName).equals(value).toArray()) as T[];
}

async function getLocalRecords<T extends Record<string, any>>(entity: any): Promise<T[]> {
  if (isNativeAndroid()) return nativePosRepository.getAll<T>(entity);
  return (await (db as any)[entity].toArray()) as T[];
}

async function getDeviceRole(): Promise<'server' | 'client' | 'standalone'> {
  try {
    const setting = await getLocalSettingByKey('deviceRole');
    currentDeviceRole = setting?.value === 'standalone' ? 'standalone' : setting?.value === 'client' ? 'client' : 'server';
    return currentDeviceRole;
  } catch (error) {
    if (isNativeAndroid()) throw error;
    currentDeviceRole = 'server';
    return currentDeviceRole;
  }
}

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function shouldPostLocalAccounting(syncStatus: 'synced' | 'pending'): boolean {
  return syncStatus === 'pending' || currentDeviceRole === 'standalone';
}

function resolveLocalUnitFactor(product: any, item: any): number {
  if (Number(item?.conversionFactor) > 0 && item?.unit && item.unit !== 'piece') {
    return Number(item.conversionFactor);
  }
  const unitName = String(item?.unit || item?.selectedUnit || 'piece');
  if (product?.unitsJson) {
    try {
      const units = JSON.parse(product.unitsJson);
      if (Array.isArray(units)) {
        const matched = units.find((u: any) => u?.name === unitName);
        if (matched && Number(matched.conversionFactor) > 0) {
          return Number(matched.conversionFactor);
        }
      }
    } catch {}
  }
  if (unitName === 'box') {
    return Number(item?.conversionFactor || product?.conversionFactor || 1);
  }
  return Number(item?.conversionFactor || 1) || 1;
}

async function applySaleLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { order, items = [], pointsEarned = 0, pointsRedeemed = 0, _serverItems } = payload;
  const now = order.createdAt || new Date().toISOString();
  const operationId = String(payload.operationId || order.operationId || order.id);
  const deviceId = String(payload.deviceId || 'local-device');
  const policyRow = await getLocalSettingByKey('offlineStockPolicy');
  const legacyPolicy = await getLocalSettingByKey('allowNegativeStock');
  const stockPolicy = policyRow?.value || (legacyPolicy?.value === 'false' || legacyPolicy?.value === false ? 'block' : 'allow_with_alert');
  const actorRole = String(payload.actor?.role || payload.userRole || payload.role || '').toLowerCase();
  const isPrivilegedOverride = Boolean(payload.managerOverride || payload.allowNegativeOverride) && (actorRole === 'admin' || actorRole === 'manager');
  const allowNegative = !['block', 'manager_override'].includes(String(stockPolicy)) || isPrivilegedOverride;
  let totalCogs = 0;
  const netAmount = roundMoney(Number(order.netAmount || 0));
  const totalAmount = roundMoney(Number(order.totalAmount || 0));
  const taxAmount = roundMoney(Number(order.taxAmount || 0));
  const paymentMethod = String(order.paymentMethod || 'cash');
  let paidAmount = netAmount;
  let cashAmount = 0;
  let cardAmount = 0;
  if (paymentMethod === 'mixed') {
    cashAmount = roundMoney(Number(order.cashAmount || 0));
    cardAmount = roundMoney(Number(order.cardAmount || 0));
    if (cashAmount < 0 || cardAmount < 0 || Math.abs(roundMoney(cashAmount + cardAmount) - netAmount) > 0.02) {
      throw new Error('قيمة الدفع المختلط (نقد + شبكة) يجب أن تساوي صافي الفاتورة');
    }
  } else if (paymentMethod === 'cash') cashAmount = netAmount;
  else if (paymentMethod === 'card') cardAmount = netAmount;
  else if (paymentMethod === 'credit') paidAmount = 0;
  const normalizedOrder = {
    ...order, totalAmount, taxAmount, netAmount,
    discountAmount: roundMoney(Math.max(0, totalAmount + taxAmount - netAmount)),
    paidAmount, cashAmount, cardAmount, returnedAmount: 0, paymentMethod,
    status: order.status || 'completed', currency: order.currency || 'ر.س',
    exchangeRate: Number(order.exchangeRate || 1),
  };

  await db.transaction(
    'rw',
    [
      db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions,
      db.inventoryBatches, db.serviceRecipes, db.inventoryMovements, db.inventoryAlerts,
      db.accounts, db.journalEntries, db.transactions,
    ],
    async () => {
      const existingLocalOrder = await db.orders.get(order.id);
      if (existingLocalOrder) return;
      await db.orders.put({ ...normalizedOrder, syncStatus });
      await db.orderItems.where('orderId').equals(order.id).delete();

      const savedServerItems = Array.isArray(_serverItems) ? _serverItems : [];
      let serverItemIndex = 0;
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const quantity = roundQty(Number(item.quantity || 0));
        if (quantity <= 0) continue;
        const serverItem = savedServerItems[serverItemIndex++];
        const product = await db.products.get(Number(item.productId));
        if (!product) throw new Error(`الصنف غير موجود (ID: ${item.productId})`);

        const factor = resolveLocalUnitFactor(product, item);
        const baseQty = roundQty(quantity * factor);
        const itemType = String(item.itemType || product.itemType || 'stock');
        let costTotal = 0;
        let batchAllocations: any = [];

        if (itemType === 'service') {
          batchAllocations = { kind: 'service' };
        } else if (itemType === 'service_with_materials' || itemType === 'bundle') {
          const recipes = await db.serviceRecipes.where('parentProductId').equals(Number(product.id)).toArray();
          if (recipes.length > 0) {
            const ingredientAllocations: any[] = [];
            for (const recipe of recipes) {
              const ingredientQty = roundQty(baseQty * Number(recipe.quantity || 0));
              if (ingredientQty <= 0) continue;
              const consumed = await consumeLocalInventoryFIFO({
                productId: Number(recipe.ingredientProductId),
                quantityInBaseUnits: ingredientQty,
                operationId,
                deviceId,
                sourceId: String(order.id),
                movementKeySuffix: `recipe-${index}-${recipe.id || recipe.ingredientProductId}`,
                movementType: 'service_consumption',
                sourceType: 'order',
                branchId: order.branchId,
                reason: 'استهلاك مواد الخدمة',
                createdBy: order.createdBy,
                createdAt: now,
                allowNegative,
                syncStatus,
              });
              costTotal += consumed.totalCost;
              ingredientAllocations.push({
                ingredientProductId: Number(recipe.ingredientProductId),
                ingredientName: recipe.ingredientName,
                quantityConsumed: ingredientQty,
                allocations: consumed.allocations,
              });
            }
            batchAllocations = { kind: 'recipe', ingredients: ingredientAllocations };
          } else if (itemType === 'bundle') {
            const consumed = await consumeLocalInventoryFIFO({
              productId: Number(product.id),
              quantityInBaseUnits: baseQty,
              operationId,
              deviceId,
              sourceId: String(order.id),
              movementKeySuffix: String(index),
              movementType: 'sale',
              sourceType: 'order',
              branchId: order.branchId,
              createdBy: order.createdBy,
              createdAt: now,
              allowNegative,
              syncStatus,
            });
            costTotal = consumed.totalCost;
            batchAllocations = consumed.allocations;
          } else {
            batchAllocations = { kind: 'service' };
          }
        } else {
          const consumed = await consumeLocalInventoryFIFO({
            productId: Number(product.id),
            quantityInBaseUnits: baseQty,
            operationId,
            deviceId,
            sourceId: String(order.id),
            movementKeySuffix: String(index),
            movementType: 'sale',
            sourceType: 'order',
            branchId: order.branchId,
            createdBy: order.createdBy,
            createdAt: now,
            allowNegative,
            syncStatus,
          });
          costTotal = consumed.totalCost;
          batchAllocations = consumed.allocations;
        }

        totalCogs = roundMoney(totalCogs + costTotal);
        const localItem = {
          ...(serverItem || {}),
          orderId: order.id,
          productId: Number(product.id),
          productName: item.productName || product.name,
          quantity,
          returnedQuantity: Number(serverItem?.returnedQuantity || 0),
          unit: item.unit || item.selectedUnit || product.unit || 'piece',
          conversionFactor: factor,
          itemType: itemType as any,
          unitPrice: Number(item.unitPrice || 0),
          costPriceAtTimeOfSale: serverItem?.costPriceAtTimeOfSale !== undefined
            ? Number(serverItem.costPriceAtTimeOfSale)
            : quantity > 0 ? roundQty((costTotal / quantity)) : 0,
          discountAmount: Number(item.discountAmount || 0),
          subTotal: Number(item.subTotal || 0),
          taxAmount: Number(item.taxAmount || 0),
          total: Number(item.total || 0),
          batchAllocations: serverItem?.batchAllocations || JSON.stringify(batchAllocations),
          syncStatus,
        };
        if (serverItem?.id !== undefined) {
          await db.orderItems.put(localItem);
        } else {
          delete (localItem as any).id;
          await db.orderItems.add(localItem);
        }
      }

      if (order.customerId) {
        const customer = await db.customers.get(order.customerId);
        if (customer) {
          const balanceDelta = paymentMethod === 'credit' ? netAmount : 0;
          const pointsDelta = Number(pointsEarned || 0) - Number(pointsRedeemed || 0);
          await db.customers.update(customer.id!, {
            balance: roundMoney((customer.balance || 0) + balanceDelta),
            points: Math.max(0, (customer.points || 0) + pointsDelta),
            updatedAt: now,
            syncStatus,
          });
        }

        if (pointsEarned > 0) {
          await db.loyaltyTransactions.add({
            customerId: order.customerId,
            orderId: order.id,
            type: 'earn',
            points: pointsEarned,
            date: now,
            syncStatus,
          });
        }
        if (pointsRedeemed > 0) {
          await db.loyaltyTransactions.add({
            customerId: order.customerId,
            orderId: order.id,
            type: 'redeem',
            points: pointsRedeemed,
            date: now,
            syncStatus,
          });
        }
      }

      if (shouldPostLocalAccounting(syncStatus)) {
        const netAmount = roundMoney(Number(order.netAmount || 0));
        const totalAmount = roundMoney(Number(order.totalAmount || 0));
        const taxAmount = roundMoney(Number(order.taxAmount || 0));
        const discountAmount = roundMoney(Math.max(0, totalAmount + taxAmount - netAmount));
        const paymentMethod = String(order.paymentMethod || 'cash');
        const cashAmount = paymentMethod === 'mixed' ? roundMoney(Number(order.cashAmount || 0)) : paymentMethod === 'cash' ? netAmount : 0;
        const cardAmount = paymentMethod === 'mixed' ? roundMoney(Number(order.cardAmount || 0)) : paymentMethod === 'card' ? netAmount : 0;
        const debitLines: any[] = [];
        if (cashAmount > 0) debitLines.push({ accountCode: '1010', debit: cashAmount, credit: 0, orderId: order.id });
        if (cardAmount > 0) debitLines.push({ accountCode: '1020', debit: cardAmount, credit: 0, orderId: order.id });
        if (paymentMethod !== 'mixed' && paymentMethod !== 'cash' && paymentMethod !== 'card' && netAmount > 0) debitLines.push({ accountCode: '1100', debit: netAmount, credit: 0, orderId: order.id });
        const revenueLines = [
          ...debitLines,
          ...(discountAmount > 0 ? [{ accountCode: '4300', debit: discountAmount, credit: 0, orderId: order.id }] : []),
          ...(totalAmount > 0 ? [{ accountCode: '4100', debit: 0, credit: totalAmount, orderId: order.id }] : []),
          ...(taxAmount > 0 ? [{ accountCode: '2200', debit: 0, credit: taxAmount, orderId: order.id }] : []),
        ];
        await postLocalJournalEntry({
          referenceId: String(order.id), referenceType: 'order', entryKey: 'sale-revenue', date: now,
          description: 'فاتورة مبيعات رقم ' + String(order.receiptNumber || order.id),
          lines: revenueLines, createdBy: order.createdBy, branchId: order.branchId,
        });
        if (totalCogs > 0) {
          await postLocalJournalEntry({
            referenceId: String(order.id), referenceType: 'order', entryKey: 'sale-cogs', date: now,
            description: 'تكلفة مبيعات فاتورة رقم ' + String(order.receiptNumber || order.id),
            lines: [
              { accountCode: '5100', debit: roundMoney(totalCogs), credit: 0, orderId: order.id },
              { accountCode: '1200', debit: 0, credit: roundMoney(totalCogs), orderId: order.id },
            ], createdBy: order.createdBy, branchId: order.branchId,
          });
        }
      }
    }
  );
}

async function applyOrderVoidLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const targetOrderId = String(payload?.orderId || payload?.id || '');
  if (!targetOrderId) throw new Error('Missing orderId for void operation');
  const now = new Date().toISOString();
  const operationId = String(payload.operationId || targetOrderId);
  const deviceId = String(payload.deviceId || 'local-device');
  await db.transaction('rw', [
    db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions, db.serviceRecipes,
    db.inventoryBatches, db.inventoryMovements, db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions, db.auditLogs,
  ], async () => {
    const order = await db.orders.get(targetOrderId);
    if (!order || order.status === 'void') return;
    if (Number(order.returnedAmount || 0) > 0 || order.status === 'returned' || order.status === 'partially_returned') {
      throw new Error('لا يمكن إلغاء فاتورة تم إرجاع أصناف منها مسبقاً');
    }
    const orderItems = await db.orderItems.where('orderId').equals(targetOrderId).toArray();
    for (const item of orderItems) {
      const itemType = String(item.itemType || 'stock');
      if (itemType === 'service') continue;
      const factor = Number(item.conversionFactor || 1);
      const baseQty = roundQty(Number(item.quantity || 0) * factor);
      if (baseQty <= 0) continue;
      let parsedAlloc: any = [];
      try { parsedAlloc = typeof item.batchAllocations === 'string' ? JSON.parse(item.batchAllocations) : item.batchAllocations || []; } catch { parsedAlloc = []; }
      if (parsedAlloc?.kind === 'service') continue;
      if (parsedAlloc?.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
        for (const ingredient of parsedAlloc.ingredients) {
          const ingredientQty = roundQty(Number(ingredient.quantityConsumed || 0));
          if (ingredientQty <= 0) continue;
          await restoreLocalInventoryFIFO({
            productId: Number(ingredient.ingredientProductId), quantityInBaseUnits: ingredientQty,
            allocations: Array.isArray(ingredient.allocations) ? ingredient.allocations : [], fallbackCost: 0,
            operationId, deviceId, sourceId: targetOrderId,
            movementKeySuffix: 'rec-' + String(item.id) + '-' + String(ingredient.ingredientProductId),
            movementType: 'sale_void', sourceType: 'order_void', branchId: order.branchId,
            reason: String(payload.reason || 'إلغاء فاتورة مبيعات'), createdBy: payload.createdBy, createdAt: now, syncStatus,
          });
        }
        continue;
      }
      const allocations = Array.isArray(parsedAlloc) ? parsedAlloc : [];
      const fallbackCost = factor > 0 ? Number(item.costPriceAtTimeOfSale || 0) / factor : Number(item.costPriceAtTimeOfSale || 0);
      await restoreLocalInventoryFIFO({
        productId: Number(item.productId), quantityInBaseUnits: baseQty, allocations, fallbackCost,
        operationId, deviceId, sourceId: targetOrderId, movementKeySuffix: String(item.id),
        movementType: 'sale_void', sourceType: 'order_void', branchId: order.branchId,
        reason: String(payload.reason || 'إلغاء فاتورة مبيعات'), createdBy: payload.createdBy, createdAt: now, syncStatus,
      });
    }
    if (order.customerId) {
      const loyalty = await db.loyaltyTransactions.where('orderId').equals(targetOrderId).toArray();
      let pointsDelta = 0;
      for (const entry of loyalty) {
        if (entry.type === 'earn') pointsDelta -= Number(entry.points || 0);
        if (entry.type === 'redeem') pointsDelta += Number(entry.points || 0);
      }
      const balanceDelta = order.paymentMethod === 'credit' ? -Number(order.netAmount || 0) : 0;
      const customer = await db.customers.get(order.customerId);
      if (customer) await db.customers.update(customer.id!, {
        balance: roundMoney(Number(customer.balance || 0) + balanceDelta),
        points: Math.max(0, Number(customer.points || 0) + pointsDelta), updatedAt: now, syncStatus,
      });
    }
    await db.orders.update(targetOrderId, { status: 'void', paidAmount: 0, updatedAt: now, syncStatus });
    if (shouldPostLocalAccounting(syncStatus)) {
      await reverseLocalJournalEntriesByReference(targetOrderId, String(payload.reason || 'إلغاء فاتورة مبيعات'), payload.createdBy);
    }
  });
}
async function applyReturnLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { id, returnNumber, originalOrderId, items = [], refundMethod, reason, branchId, shiftId, createdBy } =
    payload;
  const now = new Date().toISOString();
  const effectiveReturnDate = payload.returnDate ? new Date(payload.returnDate).toISOString() : now;

  await db.transaction(
    'rw',
    [db.returns, db.returnItems, db.orders, db.orderItems, db.products, db.customers, db.serviceRecipes, db.inventoryBatches, db.inventoryMovements, db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions],
    async () => {
      if (await db.returns.get(id)) return;
      const origOrder = await db.orders.get(originalOrderId);
      if (!origOrder || origOrder.status === 'void') throw new Error('لا يمكن إرجاع فاتورة غير موجودة أو ملغاة');
      const effectiveRefundMethod = refundMethod || (origOrder.paymentMethod === 'credit' ? 'credit_adjustment' : origOrder.paymentMethod === 'card' ? 'card' : 'cash');
      const origItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();

      let totalRefund = 0;
      let totalTax = 0;
      let totalSub = 0;
      let totalCostReversed = 0;
      let totalDiscount = 0;
      let totalResalableCostReversed = 0;
      let totalDamagedCostReversed = 0;
      let processedItems = 0;
      const operationId = String(payload.operationId || id);
      const deviceId = String(payload.deviceId || 'local-device');

      for (const reqItem of items) {
        const requestedQuantity = roundQty(Number(reqItem.quantity || 0));
        if (requestedQuantity <= 0) continue;
        const origItem = reqItem.orderItemId !== undefined && reqItem.orderItemId !== null
          ? origItems.find((oi) => Number(oi.id) === Number(reqItem.orderItemId))
          : origItems.find((oi) => Number(oi.productId) === Number(reqItem.productId) &&
              roundQty(Number(oi.quantity || 0) - Number(oi.returnedQuantity || 0)) >= requestedQuantity - 1e-6)
            || origItems.find((oi) => Number(oi.productId) === Number(reqItem.productId));
        if (!origItem) throw new Error('الصنف غير موجود في الفاتورة الأصلية: ' + String(reqItem.productName || reqItem.productId));

        const qty = requestedQuantity;
        const remainingReturnable = roundQty(Number(origItem.quantity || 0) - Number(origItem.returnedQuantity || 0));
        if (qty > remainingReturnable + 1e-6) throw new Error('الكمية المرتجعة تتجاوز الكمية المتبقية القابلة للإرجاع للمنتج ' + origItem.productName);

        const ratio = qty / Number(origItem.quantity);
        const lineSub = roundMoney(Number(origItem.subTotal) * ratio);
        const lineTax = roundMoney(Number(origItem.taxAmount) * ratio);
        const lineTotal = roundMoney(Number(origItem.total) * ratio);
        const lineDiscount = roundMoney(Math.max(0, lineSub + lineTax - lineTotal));
        let lineCost = 0;
        const condition: 'resalable' | 'damaged' =
          reqItem.condition === 'damaged' ? 'damaged' : 'resalable';

        totalSub = roundMoney(totalSub + lineSub);
        totalDiscount = roundMoney(totalDiscount + lineDiscount);
        totalTax = roundMoney(totalTax + lineTax);
        totalRefund = roundMoney(totalRefund + lineTotal);

        const nextReturned = roundQty(Number(origItem.returnedQuantity || 0) + qty);
        origItem.returnedQuantity = nextReturned;
        if (origItem.id) {
          await db.orderItems.update(origItem.id, {
            returnedQuantity: nextReturned,
            syncStatus,
          });
        }

        const itemType = String(origItem.itemType || 'stock');
        const factor = Number(origItem.conversionFactor || 1);
        const baseQty = roundQty(qty * factor);

        if (condition === 'resalable' && itemType !== 'service') {
          let parsedAlloc: any = [];
          try {
            parsedAlloc = typeof origItem.batchAllocations === 'string'
              ? JSON.parse(origItem.batchAllocations)
              : origItem.batchAllocations || [];
          } catch {
            parsedAlloc = [];
          }

          const fallbackCostPerBase = factor > 0
            ? Number(origItem.costPriceAtTimeOfSale || 0) / factor
            : Number(origItem.costPriceAtTimeOfSale || 0);

          if (parsedAlloc?.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
            for (let recipeIndex = 0; recipeIndex < parsedAlloc.ingredients.length; recipeIndex++) {
              const ingredient = parsedAlloc.ingredients[recipeIndex];
              const ingredientQty = roundQty(Number(ingredient.quantityConsumed || 0) * (qty / Number(origItem.quantity || 1)));
              if (ingredientQty <= 0) continue;
              const restoredCost = await restoreLocalInventoryFIFO({
                productId: Number(ingredient.ingredientProductId),
                quantityInBaseUnits: ingredientQty,
                allocations: Array.isArray(ingredient.allocations) ? ingredient.allocations : [],
                fallbackCost: 0,
                operationId,
                deviceId,
                sourceId: String(id),
                movementKeySuffix: `rec-${processedItems}-${ingredient.ingredientProductId}`,
                branchId: branchId ?? origOrder?.branchId,
                reason: reason || 'مرتجع مبيعات',
                createdBy,
                createdAt: effectiveReturnDate,
                syncStatus,
              });
              lineCost = roundMoney(lineCost + restoredCost);
            }
          } else if (parsedAlloc?.kind !== 'service') {
            const allocations = Array.isArray(parsedAlloc) ? parsedAlloc : [];
            lineCost = await restoreLocalInventoryFIFO({
              productId: Number(origItem.productId),
              quantityInBaseUnits: baseQty,
              allocations,
              fallbackCost: fallbackCostPerBase,
              operationId,
              deviceId,
              sourceId: String(id),
              movementKeySuffix: String(processedItems),
              branchId: branchId ?? origOrder?.branchId,
              reason: reason || 'مرتجع مبيعات',
              createdBy,
              createdAt: effectiveReturnDate,
              syncStatus,
            });
          }
          totalResalableCostReversed = roundMoney(totalResalableCostReversed + lineCost);
        } else if (condition === 'damaged' && itemType !== 'service') {
          lineCost = roundMoney(Number(origItem.costPriceAtTimeOfSale || 0) * qty);
          totalDamagedCostReversed = roundMoney(totalDamagedCostReversed + lineCost);
          const damagedProduct = await db.products.get(Number(origItem.productId));
          await db.inventoryAlerts.put({
            id: 'damaged-return:' + operationId + ':' + String(processedItems),
            productId: Number(origItem.productId), productName: origItem.productName,
            previousQty: Number(damagedProduct?.stockQuantity || 0), changeQty: 0,
            resultingQty: Number(damagedProduct?.stockQuantity || 0), operationId, deviceId,
            reason: 'damaged_return (' + qty + ')', resolved: 0, createdAt: effectiveReturnDate,
          });
        }
        totalCostReversed = roundMoney(totalCostReversed + lineCost);
        processedItems += 1;

        const retItem: ReturnItem = {
          id: generateUUID(),
          returnId: id,
          orderItemId: origItem.id,
          productId: origItem.productId,
          productName: origItem.productName,
          quantity: qty,
          condition,
          unitPrice: origItem.unitPrice,
          costPrice: origItem.costPriceAtTimeOfSale || 0,
          taxAmount: lineTax,
          total: lineTotal,
          syncStatus,
          createdAt: effectiveReturnDate,
        };
        await db.returnItems.put(retItem);
      }

      if (origOrder) {
        const updatedItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();
        const fullReturn = updatedItems.every((i) => roundQty(Number(i.returnedQuantity || 0)) >= roundQty(Number(i.quantity || 0)) - 1e-6);

        await db.orders.update(originalOrderId, {
          status: fullReturn ? 'returned' : 'partially_returned',
          returnedAmount: Math.min(roundMoney((origOrder.returnedAmount || 0) + totalRefund), roundMoney(Number(origOrder.netAmount || 0))),
          updatedAt: now,
          syncStatus,
        });

        if (origOrder.customerId && effectiveRefundMethod === 'credit_adjustment') {
          const customer = await db.customers.get(origOrder.customerId);
          if (customer) {
            await db.customers.update(customer.id!, {
              balance: roundMoney((customer.balance || 0) - totalRefund),
              updatedAt: now,
              syncStatus,
            });
          }
        }
      }

      const retDoc: ReturnRecord = {
        id,
        returnNumber,
        originalOrderId,
        originalReceiptNumber: origOrder?.receiptNumber,
        customerId: origOrder?.customerId,
        customerName: origOrder?.customerName,
        branchId: branchId ?? origOrder?.branchId,
        shiftId: shiftId ?? origOrder?.shiftId,
        refundMethod: effectiveRefundMethod,
        subTotal: roundMoney(totalSub),
        discountAmount: roundMoney(totalDiscount),
        taxAmount: roundMoney(totalTax),
        totalRefund: roundMoney(totalRefund),
        totalCostReversed: roundMoney(totalCostReversed),
        reason,
        createdBy,
        createdAt: effectiveReturnDate,
        updatedAt: now,
        syncStatus,
      };
      await db.returns.put(retDoc);
      if (processedItems === 0) throw new Error('لا توجد أصناف صالحة للإرجاع');
      if (roundMoney(totalRefund) > roundMoney(Number(origOrder.netAmount || 0) - Number(origOrder.returnedAmount || 0)) + 0.05) throw new Error('إجمالي المرتجع يتجاوز المتبقي من الفاتورة الأصلية');
      if (shouldPostLocalAccounting(syncStatus) && totalRefund > 0) {
        const creditAccountCode = effectiveRefundMethod === 'cash' ? '1010' : effectiveRefundMethod === 'card' ? '1020' : '1100';
        await postLocalJournalEntry({
          referenceId: String(id), referenceType: 'return', entryKey: 'return-refund', date: effectiveReturnDate,
          description: 'مرتجع مبيعات ' + String(returnNumber || id),
          lines: [
            { accountCode: '4200', debit: roundMoney(totalRefund - totalTax), credit: 0, orderId: originalOrderId, returnId: id },
            ...(totalTax > 0 ? [{ accountCode: '2200', debit: roundMoney(totalTax), credit: 0, orderId: originalOrderId, returnId: id }] : []),
            { accountCode: creditAccountCode, debit: 0, credit: roundMoney(totalRefund), orderId: originalOrderId, returnId: id },
          ], createdBy, branchId: branchId ?? origOrder.branchId,
        });
        if (totalResalableCostReversed > 0) await postLocalJournalEntry({
          referenceId: String(id), referenceType: 'return', entryKey: 'return-resalable-cogs', date: effectiveReturnDate,
          description: 'عكس تكلفة مرتجع صالح لإعادة البيع ' + String(returnNumber || id),
          lines: [
            { accountCode: '1200', debit: totalResalableCostReversed, credit: 0, orderId: originalOrderId, returnId: id },
            { accountCode: '5100', debit: 0, credit: totalResalableCostReversed, orderId: originalOrderId, returnId: id },
          ], createdBy, branchId: branchId ?? origOrder.branchId,
        });
        if (totalDamagedCostReversed > 0) await postLocalJournalEntry({
          referenceId: String(id), referenceType: 'return', entryKey: 'return-damaged-cogs', date: effectiveReturnDate,
          description: 'تسوية تكلفة مرتجع تالف ' + String(returnNumber || id),
          lines: [
            { accountCode: '5400', debit: totalDamagedCostReversed, credit: 0, orderId: originalOrderId, returnId: id },
            { accountCode: '5100', debit: 0, credit: totalDamagedCostReversed, orderId: originalOrderId, returnId: id },
          ], createdBy, branchId: branchId ?? origOrder.branchId,
        });
      }    }
  );
}

async function applyPurchaseLocally(
  type: 'purchase' | 'purchase_update' | 'purchase_delete',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.purchases, db.purchaseItems, db.products, db.suppliers, db.inventoryBatches, db.purchaseReturns, db.inventoryMovements, db.accounts, db.journalEntries, db.transactions],
    async () => {
      if (type === 'purchase' && payload?.purchase?.id && await db.purchases.get(String(payload.purchase.id))) return;
      if (type === 'purchase_delete' || type === 'purchase_update') {
        const pid = type === 'purchase_delete' ? payload.id : payload.purchase.id;
        const oldPurchase = await db.purchases.get(pid);
        if (!oldPurchase) throw new Error('فاتورة الشراء غير موجودة');
        const existingReturns = await db.purchaseReturns.where('originalPurchaseId').equals(String(pid)).count();
        if (existingReturns > 0) throw new Error('لا يمكن تعديل أو حذف فاتورة شراء لها مرتجعات مسجلة');
        const oldBatches = await db.inventoryBatches.where('purchaseId').equals(String(pid)).toArray();
        if (oldBatches.some((batch) => Number(batch.remainingQuantity || 0) < Number(batch.quantity || 0))) {
          throw new Error('لا يمكن تعديل أو حذف فاتورة شراء تم بيع جزء من مخزونها؛ استخدم مرتجع المشتريات');
        }
        const oldItems = await db.purchaseItems.where('purchaseId').equals(pid).toArray();
        payload._localAffectedProductIds = oldItems.map((item) => Number(item.productId));
        payload._localAffectedSupplierId = oldPurchase.supplierId;
        const operationId = String(payload.operationId || oldPurchase.operationId || pid);
        await reverseLocalJournalEntriesByReference(String(pid), 'تعديل أو حذف فاتورة مشتريات', payload.createdBy);
        for (let oldIndex = 0; oldIndex < oldItems.length; oldIndex++) {
          const item = oldItems[oldIndex];
          const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor) : 1;
          const baseQty = roundQty(Number(item.quantity || 0) * factor);
          const prod = await db.products.get(item.productId);
          if (prod) {
            await db.products.update(prod.id!, {
              stockQuantity: roundQty(prod.stockQuantity - baseQty),
              updatedAt: now,
              syncStatus,
            });
          }
          await recordLocalInventoryMovement({
            movementKey: 'purchase_reversal:' + String(pid) + ':' + operationId + ':out:' + String(item.productId) + ':' + String(oldIndex),
            productId: Number(item.productId), movementType: 'purchase_reversal', sourceType: 'purchase', sourceId: String(pid),
            quantityDeltaBase: -baseQty, unitCost: Number(item.landedCostPerBaseUnit || item.costPrice || 0),
            totalCost: roundMoney(baseQty * Number(item.landedCostPerBaseUnit || item.costPrice || 0)),
            branchId: oldPurchase.branchId, operationId, reason: 'عكس فاتورة مشتريات', createdBy: payload.createdBy,
            createdAt: now, syncStatus,
          });
        }
        await db.purchaseItems.where('purchaseId').equals(pid).delete();
        await db.inventoryBatches.where('purchaseId').equals(pid).delete();
        for (const productId of new Set(oldItems.map((item) => Number(item.productId)))) {
          const activeBatches = (await db.inventoryBatches.toArray()).filter((batch) => Number(batch.productId) === productId && Number(batch.remainingQuantity || 0) > 0);
          const activeQty = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0), 0);
          const activeValue = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
          if (activeQty > 0) await db.products.update(productId, { costPrice: roundMoney(activeValue / activeQty), updatedAt: now, syncStatus });
        }
        if (oldPurchase && oldPurchase.supplierId) {
          const oldRemaining = roundMoney(Number(oldPurchase.totalAmount || 0) - Number(oldPurchase.paidAmount || 0));
          const sup = await db.suppliers.get(oldPurchase.supplierId);
          if (sup && oldRemaining > 0) {
            await db.suppliers.update(sup.id!, {
              balance: roundMoney(sup.balance - oldRemaining),
              updatedAt: now,
              syncStatus,
            });
          }
        }
        if (type === 'purchase_delete') {
          await db.purchases.delete(pid);
          return;
        }
      }

      const { purchase, items = [], _serverItems } = payload;
      const operationId = String(payload.operationId || purchase.operationId || purchase.id);
      await db.purchases.put({ ...purchase, returnedAmount: purchase.returnedAmount || 0, syncStatus });
      await db.purchaseItems.where('purchaseId').equals(purchase.id).delete();

      if (Array.isArray(_serverItems) && _serverItems.length > 0) {
        await db.purchaseItems.bulkPut(_serverItems.map((si: any) => ({ ...si, syncStatus })));
      }

      const fxRate = Number(purchase.exchangeRate || 1) > 0 ? Number(purchase.exchangeRate || 1) : 1;
      const extraCost = roundMoney(
        roundMoney(Number(purchase.shippingCost || 0)) +
        roundMoney(Number(purchase.customsCost || 0)) +
        roundMoney(Number(purchase.otherCosts || 0))
      );
      const normalizedItems = items.map((item: any) => {
        const qty = roundQty(Number(item.quantity || 0));
        const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor || 1) : 1;
        const unitPurchaseCost = item.pricesInForeignCurrency
          ? Number(item.costPrice || 0) * fxRate
          : Number(item.costPrice || 0);
        return { ...item, qty, factor, unitPurchaseCost, lineTotal: roundMoney(qty * unitPurchaseCost) };
      }).filter((item: any) => item.qty > 0);
      const itemsGoodsSum = roundMoney(normalizedItems.reduce((sum: number, item: any) => sum + item.lineTotal, 0));
      const goodsTotal = Number(purchase.totalAmount || 0) > 0 ? roundMoney(Number(purchase.totalAmount)) : itemsGoodsSum;
      await db.purchases.update(purchase.id, { totalAmount: goodsTotal, updatedAt: now, syncStatus });
      let remainingExtra = extraCost;

      for (let itemIndex = 0; itemIndex < normalizedItems.length; itemIndex++) {
        const item = normalizedItems[itemIndex];
        const qty = item.qty;
        const factor = item.factor;
        const baseQty = roundQty(qty * factor);
        const unitPurchaseCost = item.unitPurchaseCost;
        const lineTotal = item.lineTotal;
        let allocatedExtra = 0;
        if (extraCost > 0) {
          if (itemIndex === normalizedItems.length - 1) {
            allocatedExtra = roundMoney(remainingExtra);
          } else if (itemsGoodsSum > 0) {
            allocatedExtra = roundMoney((lineTotal / itemsGoodsSum) * extraCost);
            remainingExtra = roundMoney(remainingExtra - allocatedExtra);
          }
        }
        const landedTotal = roundMoney(lineTotal + allocatedExtra);
        const landedCostPerBaseUnit =
          baseQty > 0 ? Math.round((landedTotal / baseQty) * 10000) / 10000 : 0;

        if (!Array.isArray(_serverItems) || _serverItems.length === 0) {
          await db.purchaseItems.add({
            purchaseId: purchase.id,
            productId: item.productId,
            productName: item.productName,
            quantity: qty,
            unit: item.unit || 'piece',
            conversionFactor: factor,
            costPrice: unitPurchaseCost,
            landedCostPerBaseUnit,
            total: lineTotal,
            expiryDate: item.expiryDate,
            batchNumber: item.batchNumber,
            syncStatus,
          });
        }
        await db.inventoryBatches.put({
          id: item.batchId || generateUUID(),
          productId: item.productId,
          purchaseId: purchase.id,
          quantity: baseQty,
          remainingQuantity: baseQty,
          costPrice: landedCostPerBaseUnit,
          currency: purchase.currency,
          exchangeRate: fxRate,
          purchaseDate: purchase.date || now,
          expiryDate: item.expiryDate,
          batchNumber: item.batchNumber,
          branchId: purchase.branchId,
          syncStatus,
        });
        const prod = await db.products.get(item.productId);
        if (prod) {
          const activeBatches = (await db.inventoryBatches.toArray()).filter((batch) => Number(batch.productId) === Number(item.productId) && Number(batch.remainingQuantity || 0) > 0);
          const activeQty = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0), 0);
          const activeValue = activeBatches.reduce((sum, batch) => sum + Number(batch.remainingQuantity || 0) * Number(batch.costPrice || 0), 0);
          const weightedCost = activeQty > 0 ? roundMoney(activeValue / activeQty) : landedCostPerBaseUnit;
          await db.products.update(prod.id!, {
            stockQuantity: roundQty(prod.stockQuantity + baseQty),
            costPrice: weightedCost,
            expiryDate: item.expiryDate || prod.expiryDate,
            batchNumber: item.batchNumber || prod.batchNumber,
            updatedAt: now,
            syncStatus,
          });
        }
        await recordLocalInventoryMovement({
          movementKey: 'purchase:' + String(purchase.id) + ':' + operationId + ':in:' + String(item.productId) + ':' + String(itemIndex),
          productId: Number(item.productId), movementType: 'purchase_receipt', sourceType: 'purchase', sourceId: String(purchase.id),
          quantityDeltaBase: baseQty, unitCost: landedCostPerBaseUnit, totalCost: landedTotal,
          branchId: purchase.branchId, operationId, reason: 'استلام مشتريات', createdBy: purchase.createdBy,
          createdAt: purchase.date || now, syncStatus,
        });
      }

      const invoicePayable =
        purchase.extraCostsPaymentMethod === 'supplier'
          ? roundMoney(goodsTotal + extraCost)
          : goodsTotal;
      const remaining = roundMoney(invoicePayable - Number(purchase.paidAmount || 0));
      if (purchase.supplierId && remaining > 0) {
        const sup = await db.suppliers.get(purchase.supplierId);
        if (sup) {
          await db.suppliers.update(sup.id!, {
            balance: roundMoney((sup.balance || 0) + remaining),
            updatedAt: now,
            syncStatus,
          });
        }
      }

      if (shouldPostLocalAccounting(syncStatus)) {
        const extraPaymentMethod = String(purchase.extraCostsPaymentMethod || 'cash');
        const totalCapitalized = roundMoney(goodsTotal + extraCost);
        const credits: any[] = [];
        if (extraPaymentMethod === 'supplier') {
          credits.push({ accountCode: '2100', debit: 0, credit: totalCapitalized, purchaseId: purchase.id });
        } else {
          if (goodsTotal > 0) credits.push({ accountCode: '2100', debit: 0, credit: goodsTotal, purchaseId: purchase.id });
          if (extraCost > 0) credits.push({ accountCode: extraPaymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: extraCost, purchaseId: purchase.id });
        }
        if (totalCapitalized > 0) await postLocalJournalEntry({
          referenceId: String(purchase.id), referenceType: 'purchase', entryKey: 'purchase-inventory-' + operationId, date: purchase.date || now,
          description: 'فاتورة مشتريات من المورد: ' + String(purchase.supplierName || ''),
          lines: [{ accountCode: '1200', debit: totalCapitalized, credit: 0, purchaseId: purchase.id }, ...credits],
          createdBy: purchase.createdBy, branchId: purchase.branchId,
        });
        const paidAmount = roundMoney(Number(purchase.paidAmount || 0));
        if (paidAmount > 0) await postLocalJournalEntry({
          referenceId: String(purchase.id), referenceType: 'payment', entryKey: 'purchase-payment-' + operationId, date: purchase.date || now,
          description: 'سداد للمورد عن فاتورة مشتريات: ' + String(purchase.supplierName || ''),
          lines: [
            { accountCode: '2100', debit: paidAmount, credit: 0, purchaseId: purchase.id },
            { accountCode: purchase.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: paidAmount, purchaseId: purchase.id },
          ], createdBy: purchase.createdBy, branchId: purchase.branchId,
        });
      }
    }
  );
}

async function applyPurchaseReturnLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { id, returnNumber, originalPurchaseId, items = [], refundMethod = 'credit_adjustment', reason, branchId, shiftId, createdBy } = payload;
  const now = new Date().toISOString();
  const operationId = String(payload.operationId || id);
  await db.transaction('rw', [
    db.purchaseReturns, db.purchaseReturnItems, db.purchases, db.inventoryBatches, db.products, db.suppliers,
    db.inventoryMovements, db.accounts, db.journalEntries, db.transactions,
  ], async () => {
    if (await db.purchaseReturns.get(id)) return;
    const origPurchase = await db.purchases.get(String(originalPurchaseId));
    if (!origPurchase) throw new Error('فاتورة الشراء الأصلية غير موجودة');
    const batches = await db.inventoryBatches.where('purchaseId').equals(String(originalPurchaseId)).toArray();
    let totalReturn = 0;
    let processedItems = 0;
    for (const reqItem of items) {
      const qty = roundQty(Number(reqItem.quantity || 0));
      if (qty <= 0) continue;
      const productId = Number(reqItem.productId);
      const batch = reqItem.batchId
        ? batches.find((entry) => String(entry.id) === String(reqItem.batchId))
        : batches.find((entry) => Number(entry.productId) === productId && Number(entry.remainingQuantity || 0) >= qty) || batches.find((entry) => Number(entry.productId) === productId);
      if (batch && batch.id) {
        const remaining = Number(batch.remainingQuantity || 0);
        if (remaining < qty) throw new Error('الكمية المتبقية في الدفعة أقل من كمية مرتجع المشتريات');
        await db.inventoryBatches.update(batch.id, { remainingQuantity: roundQty(remaining - qty), updatedAt: now, syncStatus });
      }
      const product = await db.products.get(productId);
      if (!batch && (!product || Number(product.stockQuantity || 0) < qty)) throw new Error('المخزون المتاح لا يكفي لإرجاع المنتج ' + String(reqItem.productName || productId));
      if (product) {
        const activeBatches = (await db.inventoryBatches.toArray()).filter((entry) => Number(entry.productId) === productId && Number(entry.remainingQuantity || 0) > 0);
        const activeQty = activeBatches.reduce((sum, entry) => sum + Number(entry.remainingQuantity || 0), 0);
        const activeValue = activeBatches.reduce((sum, entry) => sum + Number(entry.remainingQuantity || 0) * Number(entry.costPrice || 0), 0);
        await db.products.update(product.id!, {
          stockQuantity: roundQty(Number(product.stockQuantity || 0) - qty),
          ...(activeQty > 0 ? { costPrice: roundMoney(activeValue / activeQty) } : {}),
          updatedAt: now, syncStatus,
        });
      }
      const cost = Number(reqItem.costPrice ?? batch?.costPrice ?? 0);
      const lineTotal = roundMoney(qty * cost);
      totalReturn = roundMoney(totalReturn + lineTotal);
      const itemDoc: PurchaseReturnItem = {
        id: generateUUID(), purchaseReturnId: id, productId, productName: reqItem.productName || '',
        quantity: qty, costPrice: cost, total: lineTotal, batchId: batch?.id ? String(batch.id) : undefined,
        syncStatus, createdAt: now,
      };
      await db.purchaseReturnItems.put(itemDoc);
      processedItems += 1;
      await recordLocalInventoryMovement({
        movementKey: 'purchase_return:' + String(id) + ':out:' + String(productId) + ':' + String(processedItems),
        productId, movementType: 'purchase_return', sourceType: 'purchase_return', sourceId: String(id),
        quantityDeltaBase: -qty, unitCost: cost, totalCost: lineTotal, branchId: branchId ?? origPurchase.branchId,
        operationId, reason: reason || 'مرتجع مشتريات للمورد', createdBy, createdAt: now, syncStatus,
      });
    }
    if (processedItems === 0) throw new Error('لا توجد أصناف صالحة لمرتجع المشتريات');
    const newReturned = roundMoney(Number(origPurchase.returnedAmount || 0) + totalReturn);
    if (newReturned > roundMoney(Number(origPurchase.totalAmount || 0)) + 0.05) throw new Error('قيمة مرتجع المشتريات تتجاوز إجمالي فاتورة الشراء');
    const netPayable = Math.max(0, roundMoney(Number(origPurchase.totalAmount || 0) - newReturned));
    const paid = roundMoney(Number(origPurchase.paidAmount || 0));
    await db.purchases.update(origPurchase.id!, {
      returnedAmount: newReturned,
      paymentStatus: paid >= netPayable ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
      updatedAt: now, syncStatus,
    });
    if (refundMethod === 'credit_adjustment' && origPurchase.supplierId) {
      const supplier = await db.suppliers.get(origPurchase.supplierId);
      if (supplier) await db.suppliers.update(supplier.id!, { balance: roundMoney(Number(supplier.balance || 0) - totalReturn), updatedAt: now, syncStatus });
    }
    const retDoc: PurchaseReturn = {
      id, returnNumber, originalPurchaseId: String(originalPurchaseId), supplierId: origPurchase.supplierId,
      supplierName: origPurchase.supplierName, branchId: branchId ?? origPurchase.branchId, shiftId,
      refundMethod, totalReturn, reason, createdBy, createdAt: now, updatedAt: now, syncStatus,
    };
    await db.purchaseReturns.put(retDoc);
    if (shouldPostLocalAccounting(syncStatus) && totalReturn > 0) {
      const debitAccount = refundMethod === 'cash' ? '1010' : refundMethod === 'card' ? '1020' : '2100';
      await postLocalJournalEntry({
        referenceId: String(id), referenceType: 'purchase_return', entryKey: 'purchase-return-' + operationId, date: now,
        description: 'مرتجع مشتريات ' + String(returnNumber || id) + ' للمورد ' + String(origPurchase.supplierName || ''),
        lines: [
          { accountCode: debitAccount, debit: totalReturn, credit: 0, purchaseId: String(originalPurchaseId) },
          { accountCode: '1200', debit: 0, credit: totalReturn, purchaseId: String(originalPurchaseId) },
        ], createdBy, branchId: branchId ?? origPurchase.branchId,
      });
    }
  });
}
async function applyExpenseLocally(type: 'expense' | 'expense_delete', payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  await db.transaction('rw', [db.expenses, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    if (type === 'expense_delete') {
      if (payload?.id !== undefined) {
        const existing = await db.expenses.get(Number(payload.id));
        if (existing) {
          await reverseLocalJournalEntriesByReference(String(payload.id), 'حذف مصروف', payload.createdBy);
          await db.expenses.delete(Number(payload.id));
          if (currentDeviceRole === 'standalone') await db.auditLogs.add({
            date: now, userName: payload.createdBy || 'System', type: 'expense_delete',
            operationName: 'حذف مصروف', action: 'حذف', details: existing.description,
            quantity: 1, value: Number(existing.amount || 0), branchId: existing.branchId,
            entityId: String(payload.id), entityName: existing.category, syncStatus,
          });
        }
      }
      return;
    }
    const expenseId = Number(payload.id);
    if (!Number.isFinite(expenseId) || expenseId <= 0) throw new Error('معرّف المصروف غير صالح');
    await db.expenses.put({
      id: expenseId, description: payload.description, amount: Number(payload.amount || 0),
      category: payload.category || 'عام', paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
      shiftId: payload.shiftId, date: payload.date || now, branchId: payload.branchId,
      createdAt: payload.createdAt || now, updatedAt: now, syncStatus,
    });
    const amount = roundMoney(Number(payload.amount || 0));
    if (shouldPostLocalAccounting(syncStatus) && amount > 0) {
      await postLocalJournalEntry({
        referenceId: String(expenseId), referenceType: 'expense', entryKey: 'expense-' + String(payload.operationId || expenseId),
        date: payload.date || now, description: 'مصروف (' + String(payload.category || 'عام') + '): ' + String(payload.description || ''),
        lines: [
          { accountCode: '5200', debit: amount, credit: 0 },
          { accountCode: payload.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: amount },
        ], createdBy: payload.createdBy, branchId: payload.branchId,
      });
    }
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: payload.date || now, userName: payload.createdBy || 'System', type: 'expense',
      operationName: 'تسجيل مصروف', action: 'مصروف',
      details: String(payload.category || 'عام') + ': ' + String(payload.description || ''),
      quantity: 1, value: amount, branchId: payload.branchId,
      entityId: String(expenseId), entityName: String(payload.category || 'عام'), syncStatus,
    });
  });
}
async function applyCustomerPaymentLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payAmount = roundMoney(Number(payload.amount || 0));
  await db.transaction('rw', [db.customers, db.orders, db.customerPayments, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    const paymentId = String(payload.paymentId || payload.operationId || generateUUID());
    if (await db.customerPayments.get(paymentId)) return;
    const cust = await db.customers.get(Number(payload.customerId));
    if (!cust || payAmount <= 0) throw new Error('بيانات تحصيل العميل غير صالحة');
    if (cust) {
      await db.customers.update(cust.id!, {
        balance: roundMoney((cust.balance || 0) - payAmount),
        updatedAt: now,
        syncStatus,
      });
    }
    if (payload.orderId) {
      const ord = await db.orders.get(String(payload.orderId));
      if (ord) {
        await db.orders.update(ord.id!, {
          paidAmount: roundMoney((ord.paidAmount || 0) + payAmount),
          updatedAt: now,
          syncStatus,
        });
      }
    }
    await db.customerPayments.put({
      id: paymentId,
      customerId: Number(payload.customerId),
      customerName: cust?.name || payload.customerName,
      orderId: payload.orderId,
      amount: payAmount,
      paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
      notes: payload.notes,
      shiftId: payload.shiftId,
      branchId: payload.branchId ?? cust.branchId,
      createdBy: payload.createdBy,
      operationId: payload.operationId,
      syncStatus,
      createdAt: now,
    });
    if (shouldPostLocalAccounting(syncStatus) && payAmount > 0) await postLocalJournalEntry({
      referenceId: String(paymentId), referenceType: 'payment', entryKey: 'customer-payment-' + String(payload.operationId || paymentId),
      date: now, description: 'تحصيل دفعة من العميل: ' + String(cust?.name || payload.customerName || ''),
      lines: [
        { accountCode: payload.paymentMethod === 'card' ? '1020' : '1010', debit: payAmount, credit: 0, orderId: payload.orderId },
        { accountCode: '1100', debit: 0, credit: payAmount, orderId: payload.orderId },
      ], createdBy: payload.createdBy, branchId: payload.branchId ?? cust.branchId,
    });
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: now, userName: payload.createdBy || 'System', type: 'customer_payment',
      action: 'تحصيل عميل', operationName: 'سداد ذمم عميل',
      details: 'تحصيل ' + payAmount + ' من العميل ' + String(cust.name || ''),
      quantity: 1, value: payAmount, branchId: payload.branchId ?? cust.branchId ?? undefined,
      entityId: String(cust.id), entityName: cust.name, syncStatus,
    });
  });
}

async function applySupplierPaymentLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payAmount = roundMoney(Number(payload.amount || 0));
  await db.transaction('rw', [db.suppliers, db.purchases, db.supplierPayments, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    const paymentId = String(payload.paymentId || payload.operationId || generateUUID());
    if (await db.supplierPayments.get(paymentId)) return;
    const sup = await db.suppliers.get(Number(payload.supplierId));
    if (!sup || payAmount <= 0) throw new Error('بيانات سداد المورد غير صالحة');
    if (sup) {
      await db.suppliers.update(sup.id!, {
        balance: roundMoney((sup.balance || 0) - payAmount),
        updatedAt: now,
        syncStatus,
      });
    }
    if (payload.purchaseId) {
      const p = await db.purchases.get(String(payload.purchaseId));
      if (p) {
        const newPaid = roundMoney((p.paidAmount || 0) + payAmount);
        const netPayable = Math.max(0, roundMoney(p.totalAmount - (p.returnedAmount || 0)));
        await db.purchases.update(p.id!, {
          paidAmount: newPaid,
          paymentStatus: newPaid >= netPayable ? 'paid' : 'partial',
          syncStatus,
        });
      }
    }
    await db.supplierPayments.put({
      id: paymentId,
      supplierId: Number(payload.supplierId),
      supplierName: sup?.name || payload.supplierName,
      purchaseId: payload.purchaseId ? String(payload.purchaseId) : undefined,
      amount: payAmount,
      paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
      notes: payload.notes,
      shiftId: payload.shiftId,
      branchId: payload.branchId,
      createdBy: payload.createdBy,
      operationId: payload.operationId,
      syncStatus,
      createdAt: now,
    });
    if (shouldPostLocalAccounting(syncStatus) && payAmount > 0) await postLocalJournalEntry({
      referenceId: String(paymentId), referenceType: 'payment', entryKey: 'supplier-payment-' + String(payload.operationId || paymentId),
      date: now, description: 'سداد دفعة للمورد: ' + String(sup?.name || payload.supplierName || ''),
      lines: [
        { accountCode: '2100', debit: payAmount, credit: 0, purchaseId: payload.purchaseId },
        { accountCode: payload.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: payAmount, purchaseId: payload.purchaseId },
      ], createdBy: payload.createdBy, branchId: payload.branchId,
    });
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: now, userName: payload.createdBy || 'System', type: 'supplier_payment',
      action: 'سداد مورد', operationName: 'دفع مستحقات مورد',
      details: 'سداد ' + payAmount + ' للمورد ' + String(sup.name || ''),
      quantity: 1, value: payAmount, branchId: payload.branchId,
      entityId: String(sup.id), entityName: sup.name, syncStatus,
    });
  });
}

async function applyPayrollLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payrollId = Number(payload.id);
  if (!Number.isSafeInteger(payrollId) || payrollId <= 0) throw new Error('معرّف مسير الراتب غير صالح');
  await db.transaction('rw', [db.payroll, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
    if (await db.payroll.get(payrollId)) return;
    const record = {
      id: payrollId, employeeId: Number(payload.employeeId), employeeName: payload.employeeName,
      periodStart: payload.periodStart, periodEnd: payload.periodEnd,
      salaryType: payload.salaryType === 'hourly' ? 'hourly' : 'monthly',
      totalHours: Number(payload.totalHours || 0), hourlyRate: Number(payload.hourlyRate || 0),
      basicSalary: Number(payload.basicSalary || 0), bonuses: Number(payload.bonuses || 0),
      deductions: Number(payload.deductions || 0), netSalary: Number(payload.netSalary || 0),
      paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash', branchId: payload.branchId,
      paymentDate: payload.paymentDate || now, status: payload.status || 'paid', syncStatus,
    };
    await db.payroll.put(record);
    if (shouldPostLocalAccounting(syncStatus) && record.netSalary > 0 && record.status === 'paid') {
      await postLocalJournalEntry({
        referenceId: String(payrollId), referenceType: 'payroll', entryKey: 'payroll-' + String(payload.operationId || payrollId),
        date: record.paymentDate, description: 'صرف راتب الموظف: ' + String(record.employeeName || ''),
        lines: [
          { accountCode: '5300', debit: roundMoney(record.netSalary), credit: 0 },
          { accountCode: record.paymentMethod === 'card' ? '1020' : '1010', debit: 0, credit: roundMoney(record.netSalary) },
        ], createdBy: payload.createdBy, branchId: record.branchId,
      });
    }
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: record.paymentDate, userName: payload.createdBy || 'System', type: 'payroll',
      operationName: 'مسير رواتب', action: 'صرف راتب',
      details: 'صرف راتب ' + String(record.employeeName || '') + ' (' + (record.salaryType === 'hourly' ? 'بالساعة' : 'شهري') + ')',
      quantity: 1, value: record.netSalary, branchId: record.branchId,
      entityId: String(payrollId), entityName: record.employeeName, syncStatus,
    });
  });
}
async function applyShiftLocally(
  type: 'shift_open' | 'shift_close' | 'shift_movement',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();
  if (type === 'shift_movement') {
    if (isNativeAndroid()) {
      const shiftId = String(payload.shiftId);
      const shift = await nativePosRepository.get<any>('shifts', shiftId);
      if (!shift || shift.status !== 'open') throw new Error('لا يمكن تسجيل حركة نقدية على وردية غير مفتوحة');
      const movementId = String(payload.id || generateUUID());
      const existingMovement = await nativePosRepository.get<any>('shiftMovements', movementId);
      if (existingMovement) return;
      const amount = roundMoney(Number(payload.amount || 0));
      if (amount <= 0) throw new Error('قيمة حركة الصندوق غير صالحة');
      const movementType = payload.type === 'withdrawal' ? 'withdrawal' : 'deposit';
      const createdAt = payload.createdAt || now;
      const branchId = payload.branchId ?? shift.branchId;
      const movement = {
        id: movementId, shiftId, type: movementType, amount,
        reason: payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق'),
        createdBy: payload.createdBy, branchId,
        operationId: payload.operationId, createdAt, syncStatus,
      };
      const changes: Array<{ action: 'put'; entity: any; record: Record<string, unknown>; syncState: any }> = [
        { action: 'put', entity: 'shiftMovements', record: movement, syncState: syncStatus },
      ];
      let journalEntry: any = null;
      const journalLines: any[] = [];
      const transactionRecords: any[] = [];
      const accountRecords: any[] = [];
      if (shouldPostLocalAccounting(syncStatus)) {
        const entryKey = 'shift-movement-' + String(payload.operationId || movementId);
        const entryId = `local-je:shift_movement:${movementId}:${entryKey}`;
        journalEntry = await nativePosRepository.get<any>('journalEntries', entryId);
        if (!journalEntry) {
          const cash = await nativePosRepository.get<any>('accounts', '1010') || {
            code: '1010', name: 'الصندوق', type: 'asset', balance: 0, isSystem: 1, createdAt, updatedAt: createdAt,
          };
          const equity = await nativePosRepository.get<any>('accounts', '3100') || {
            code: '3100', name: 'رأس المال والأرصدة الافتتاحية', type: 'equity', balance: 0, isSystem: 1, createdAt, updatedAt: createdAt,
          };
          const lines = movementType === 'deposit'
            ? [{ accountCode: '1010', debit: amount, credit: 0 }, { accountCode: '3100', debit: 0, credit: amount }]
            : [{ accountCode: '3100', debit: amount, credit: 0 }, { accountCode: '1010', debit: 0, credit: amount }];
          journalEntry = {
            id: entryId, entryNumber: `LOCAL-${entryKey}-${movementId.slice(0, 8)}`,
            date: createdAt, referenceId: movementId, referenceType: 'shift_movement',
            description: (movementType === 'deposit' ? 'إيداع نقدي بالوردية: ' : 'سحب نقدي من الوردية: ') + String(payload.reason || ''),
            totalDebit: amount, totalCredit: amount, status: 'posted',
            createdBy: payload.createdBy || 'System', branchId, syncStatus,
            createdAt,
          };
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const account = line.accountCode === '1010' ? cash : equity;
            const normalDebit = account.type === 'asset' || account.type === 'expense';
            const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
            accountRecords.push({ ...account, balance: roundMoney(Number(account.balance || 0) + delta), updatedAt: createdAt });
            transactionRecords.push({
              id: `${entryId}:${index}`, journalEntryId: entryId,
              accountId: line.accountCode, accountName: account.name,
              type: line.debit > 0 ? 'debit' : 'credit',
              amount: line.debit > 0 ? line.debit : line.credit,
              debit: line.debit, credit: line.credit,
              description: (movementType === 'deposit' ? 'إيداع نقدي بالوردية: ' : 'سحب نقدي من الوردية: ') + String(payload.reason || ''),
              syncStatus, createdAt,
            });
          }
          changes.push(
            { action: 'put', entity: 'accounts', record: accountRecords[0], syncState: syncStatus },
            { action: 'put', entity: 'accounts', record: accountRecords[1], syncState: syncStatus },
            { action: 'put', entity: 'journalEntries', record: journalEntry, syncState: syncStatus },
            ...transactionRecords.map((record) => ({ action: 'put' as const, entity: 'transactions', record, syncState: syncStatus })),
          );
        }
      }
      let auditRecord: any = null;
      if (currentDeviceRole === 'standalone') {
        auditRecord = {
          id: generateUUID(), date: createdAt, userName: payload.createdBy || 'System', type: 'shift_movement',
          action: movementType === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي',
          operationName: 'حركة صندوق الوردية',
          details: String(payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق')) + ' (وردية ' + shiftId + ')',
          quantity: 1, value: amount, branchId, entityId: movementId, entityName: shiftId, syncStatus,
        };
        changes.push({ action: 'put', entity: 'auditLogs', record: auditRecord, syncState: syncStatus });
      }
      await nativePosRepository.applyChanges(changes);
      await db.transaction('rw', [db.shiftMovements, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
        await db.shiftMovements.put(movement as any);
        if (journalEntry && accountRecords.length) {
          await db.accounts.bulkPut(accountRecords as any);
          await db.journalEntries.put(journalEntry);
          await db.transactions.bulkPut(transactionRecords);
        }
        if (auditRecord) await db.auditLogs.put(auditRecord as any);
      });
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await db.transaction('rw', [db.shifts, db.shiftMovements, db.accounts, db.journalEntries, db.transactions, db.auditLogs], async () => {
      const shift = await db.shifts.get(String(payload.shiftId));
      if (!shift || shift.status !== 'open') throw new Error('لا يمكن تسجيل حركة نقدية على وردية غير مفتوحة');
      const movementId = String(payload.id || generateUUID());
      const amount = roundMoney(Number(payload.amount || 0));
      if (amount <= 0) throw new Error('قيمة حركة الصندوق غير صالحة');
      const movementType = payload.type === 'withdrawal' ? 'withdrawal' : 'deposit';
      await db.shiftMovements.put({
        id: movementId, shiftId: String(payload.shiftId), type: movementType, amount,
        reason: payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق'),
        createdBy: payload.createdBy, branchId: payload.branchId ?? shift.branchId,
        operationId: payload.operationId, createdAt: payload.createdAt || now, syncStatus,
      });
      if (shouldPostLocalAccounting(syncStatus)) await postLocalJournalEntry({
        referenceId: movementId, referenceType: 'shift_movement', entryKey: 'shift-movement-' + String(payload.operationId || movementId),
        date: payload.createdAt || now, description: (movementType === 'deposit' ? 'إيداع نقدي بالوردية: ' : 'سحب نقدي من الوردية: ') + String(payload.reason || ''),
        lines: movementType === 'deposit'
          ? [{ accountCode: '1010', debit: amount, credit: 0 }, { accountCode: '3100', debit: 0, credit: amount }]
          : [{ accountCode: '3100', debit: amount, credit: 0 }, { accountCode: '1010', debit: 0, credit: amount }],
        createdBy: payload.createdBy, branchId: payload.branchId ?? shift.branchId,
      });
      if (currentDeviceRole === 'standalone') await db.auditLogs.add({
        date: payload.createdAt || now, userName: payload.createdBy || 'System', type: 'shift_movement',
        action: movementType === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي',
        operationName: 'حركة صندوق الوردية',
        details: String(payload.reason || (movementType === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق')) + ' (وردية ' + String(payload.shiftId) + ')',
        quantity: 1, value: amount, branchId: payload.branchId ?? shift.branchId,
        entityId: movementId, entityName: String(payload.shiftId), syncStatus,
      });
    });
    return;
  }
  if (type === 'shift_open') {
    const shiftId = String(payload.id);
    // SQLite is the authoritative Android store. Read it first so an existing
    // shift is never recreated from a stale Dexie cache.
    if (isNativeAndroid()) {
      const existing = await nativePosRepository.get<any>('shifts', shiftId);
      if (existing) return;
      const record = {
        id: payload.id,
        startTime: payload.startTime || now,
        openingCash: Number(payload.openingCash || 0),
        status: 'open',
        branchId: payload.branchId,
        syncStatus,
      };
      await nativePosRepository.put('shifts', record, syncStatus);
      await db.shifts.put(record as any);
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    if (await db.shifts.get(shiftId)) return;
    await db.shifts.put({
      id: payload.id,
      startTime: payload.startTime || now,
      openingCash: Number(payload.openingCash || 0),
      status: 'open',
      branchId: payload.branchId,
      syncStatus,
    });
  } else if (type === 'shift_close') {
    if (isNativeAndroid()) {
      const shiftId = String(payload.id);
      const existing = await nativePosRepository.get<any>('shifts', shiftId);
      if (!existing) return;
      const record = {
        ...existing,
        endTime: payload.endTime || now,
        expectedCash: Number(payload.expectedCash || 0),
        actualCash: Number(payload.actualCash || 0),
        status: 'closed',
        syncStatus,
      };
      await nativePosRepository.put('shifts', record, syncStatus);
      await db.shifts.put(record as any);
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await db.shifts.update(payload.id, {
      endTime: payload.endTime || now,
      expectedCash: Number(payload.expectedCash || 0),
      actualCash: Number(payload.actualCash || 0),
      status: 'closed',
      syncStatus,
    });
  } else {
    await db.shiftMovements.put({
      id: payload.id || generateUUID(),
      shiftId: String(payload.shiftId),
      type: payload.type === 'withdrawal' ? 'withdrawal' : 'deposit',
      amount: Number(payload.amount || 0),
      reason: payload.reason,
      createdBy: payload.createdBy,
      branchId: payload.branchId,
      operationId: payload.operationId,
      createdAt: payload.createdAt || now,
      syncStatus,
    });
  }
}

async function applyStocktakeApproveLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const sessionId = String(payload.sessionId);
  const operationId = String(payload.operationId || sessionId);
  const deviceId = String(payload.deviceId || 'local-device');
  await db.transaction('rw', [
    db.products, db.stocktakingSessions, db.stocktakingEntries, db.inventoryBatches, db.inventoryMovements,
    db.inventoryAlerts, db.accounts, db.journalEntries, db.transactions,
  ], async () => {
    const session = await db.stocktakingSessions.get(sessionId);
    if (!session) throw new Error('جلسة الجرد غير موجودة');
    if (session.status === 'approved') return;
    const entries = await db.stocktakingEntries.where('sessionId').equals(sessionId).toArray();
    let netAdjustmentValue = 0;
    for (const entry of entries) {
      const product = await db.products.get(Number(entry.productId));
      if (!product) continue;
      const difference = roundQty(Number(entry.actualQuantity) - Number(product.stockQuantity || 0));
      if (Math.abs(difference) < 1e-6) continue;
      if (difference > 0) {
        const unitCost = Number(product.costPrice || 0);
        const batchId = generateUUID();
        await db.inventoryBatches.put({
          id: batchId, productId: Number(product.id), purchaseId: null, quantity: difference, remainingQuantity: difference,
          costPrice: unitCost, purchaseDate: now, branchId: session.branchId, syncStatus, createdAt: now, updatedAt: now,
        });
        await db.products.update(product.id!, { stockQuantity: Number(entry.actualQuantity), updatedAt: now, syncStatus });
        await recordLocalInventoryMovement({
          movementKey: 'stocktake:' + sessionId + ':in:' + String(product.id), productId: Number(product.id),
          movementType: 'stocktake_increase', sourceType: 'stocktake', sourceId: sessionId, quantityDeltaBase: difference,
          unitCost, totalCost: roundMoney(difference * unitCost), branchId: session.branchId, operationId,
          reason: 'زيادة جرد #' + sessionId, createdBy: payload.createdBy, createdAt: now, syncStatus,
        });
        netAdjustmentValue = roundMoney(netAdjustmentValue + difference * unitCost);
      } else {
        const consumed = await consumeLocalInventoryFIFO({
          productId: Number(product.id), quantityInBaseUnits: Math.abs(difference), operationId, deviceId,
          sourceId: sessionId, movementKeySuffix: String(product.id), movementType: 'stocktake_decrease',
          sourceType: 'stocktake', branchId: session.branchId, reason: 'عجز جرد #' + sessionId,
          createdBy: payload.createdBy, createdAt: now, allowNegative: true, syncStatus,
        });
        netAdjustmentValue = roundMoney(netAdjustmentValue - consumed.totalCost);
      }
    }
    await db.stocktakingSessions.update(sessionId, { status: 'approved', syncStatus });
    if (shouldPostLocalAccounting(syncStatus) && Math.abs(netAdjustmentValue) > 0.001) {
      const amount = Math.abs(netAdjustmentValue);
      await postLocalJournalEntry({
        referenceId: sessionId, referenceType: 'stocktake', entryKey: 'stocktake-' + operationId, date: now,
        description: 'تسوية جرد مخزون #' + sessionId,
        lines: netAdjustmentValue > 0
          ? [{ accountCode: '1200', debit: amount, credit: 0 }, { accountCode: '5400', debit: 0, credit: amount }]
          : [{ accountCode: '5400', debit: amount, credit: 0 }, { accountCode: '1200', debit: 0, credit: amount }],
        createdBy: payload.createdBy, branchId: session.branchId,
      });
    }
    if (currentDeviceRole === 'standalone') await db.auditLogs.add({
      date: now, userName: payload.createdBy || 'System', type: 'stocktake_approve',
      action: 'اعتماد جرد', operationName: 'تسوية جرد مخزون',
      details: 'اعتماد جلسة جرد #' + sessionId,
      quantity: entries.length, value: Math.abs(netAdjustmentValue), branchId: session.branchId,
      entityId: sessionId, entityName: sessionId, syncStatus,
    });
  });
}
async function applyEntityLocally(type: 'entity_upsert' | 'entity_delete', payload: any, syncStatus: 'synced' | 'pending', serverResult?: any) {
  const tableName = payload?.table as keyof typeof db;
  const table = (db as any)[tableName];
  if (!table) return;
  if (type === 'entity_delete') {
    if (isNativeAndroid() && (NATIVE_POS_ENTITIES as readonly string[]).includes(String(tableName))) {
      await nativePosRepository.delete(tableName as any, payload.id);
      await table.delete(payload.id);
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await table.delete(payload.id);
    return;
  }
  if (!payload?.record) return;
  const finalRecord = serverResult && typeof serverResult === 'object' ? { ...payload.record, ...serverResult } : payload.record;
  if (payload.record.id !== undefined && finalRecord.id !== undefined && payload.record.id !== finalRecord.id) {
    await table.delete(payload.record.id).catch(() => {});
  }
  if (tableName !== 'products') {
    if (isNativeAndroid() && (NATIVE_POS_ENTITIES as readonly string[]).includes(String(tableName))) {
      await nativePosRepository.put(tableName as any, { ...finalRecord, syncStatus }, syncStatus);
      await table.put({ ...finalRecord, syncStatus });
      await flushNativeDatabaseMirrorWrites();
      return;
    }
    await table.put({ ...finalRecord, syncStatus });
    return;
  }
  const now = new Date().toISOString();
  const productId = Number(finalRecord.id);
  await db.transaction('rw', [db.products, db.inventoryBatches, db.inventoryMovements, db.accounts, db.journalEntries, db.transactions], async () => {
    await db.products.put({ ...finalRecord, syncStatus });
    if (Number(finalRecord.stockQuantity || 0) <= 0 || (finalRecord.itemType && finalRecord.itemType !== 'stock')) return;
    const existingBatchCount = await db.inventoryBatches.where('productId').equals(productId).count();
    if (existingBatchCount > 0) return;
    const quantity = roundQty(Number(finalRecord.stockQuantity || 0));
    const unitCost = Number(finalRecord.costPrice || 0);
    const batchId = generateUUID();
    await db.inventoryBatches.put({
      id: batchId, productId, purchaseId: null, quantity, remainingQuantity: quantity, costPrice: unitCost,
      purchaseDate: now, branchId: finalRecord.branchId, syncStatus, createdAt: now, updatedAt: now,
    });
    const openingValue = roundMoney(quantity * unitCost);
    await recordLocalInventoryMovement({
      movementKey: 'opening:' + String(productId), productId, movementType: 'opening_balance',
      sourceType: 'product', sourceId: String(productId), quantityDeltaBase: quantity, unitCost, totalCost: openingValue,
      branchId: finalRecord.branchId, operationId: String(payload.operationId || productId), reason: 'رصيد افتتاحي للصنف',
      createdBy: payload.createdBy || 'System', createdAt: now, syncStatus,
    });
    if (shouldPostLocalAccounting(syncStatus) && openingValue > 0) await postLocalJournalEntry({
      referenceId: 'opening:' + String(productId), referenceType: 'opening', entryKey: 'opening-' + String(payload.operationId || productId),
      date: now, description: 'رصيد افتتاحي للمخزون: ' + String(finalRecord.name || productId),
      lines: [
        { accountCode: '1200', debit: openingValue, credit: 0 },
        { accountCode: '3100', debit: 0, credit: openingValue },
      ], createdBy: payload.createdBy || 'System', branchId: finalRecord.branchId,
    });
  });
}
async function assertLocalOpenFiscalPeriod(dateIso: string, payload: any) {
  const periods = await getLocalRecords<any>('fiscalPeriods');
  if (!periods.length) return;
  const targetDay = String(dateIso || new Date().toISOString()).slice(0, 10);
  const closed = periods.find((period: any) => {
    if (period.status !== 'closed') return false;
    const start = String(period.startDate || '').slice(0, 10);
    const end = String(period.endDate || '').slice(0, 10);
    return Boolean(start && end && targetDay >= start && targetDay <= end);
  });
  if (!closed) return;
  const role = String(payload?.userRole || payload?.actor?.role || payload?.role || '').toLowerCase();
  const allowedOverride = Boolean(payload?.allowClosedPeriodOverride) && (role === 'admin' || role === 'manager');
  if (!allowedOverride) throw new Error(`الفترة المالية (${closed.name}) مغلقة ولا يمكن ترحيل عمليات بتاريخ ${targetDay}`);
}

async function validateLocalOperationFiscalPeriod(type: SyncOperation['type'], payload: any) {
  const now = new Date().toISOString();
  let postingDate = now;
  if (type === 'sale') postingDate = payload?.order?.createdAt || now;
  else if (type === 'return') postingDate = payload?.returnDate || now;
  else if (type === 'order_void') {
    const order = await getLocalRecord<any>('orders', String(payload?.orderId || payload?.id || ''));
    if (!order) return;
    postingDate = order.createdAt || now;
  } else if (type === 'purchase') postingDate = payload?.purchase?.date || now;
  else if (type === 'purchase_update' || type === 'purchase_delete') {
    const purchaseId = String(type === 'purchase_delete' ? payload?.id : payload?.purchase?.id || '');
    const purchase = await getLocalRecord<any>('purchases', purchaseId);
    if (!purchase) return;
    postingDate = purchase.date || now;
  } else if (type === 'expense') postingDate = payload?.date || now;
  else if (type === 'expense_delete') {
    const expense = await getLocalRecord<any>('expenses', Number(payload?.id));
    if (!expense) return;
    postingDate = expense.date || now;
  } else if (type === 'payroll') postingDate = payload?.paymentDate || now;
  if (['sale', 'return', 'order_void', 'purchase', 'purchase_update', 'purchase_delete', 'purchase_return', 'expense', 'expense_delete', 'customer_payment', 'supplier_payment', 'payroll', 'shift_movement', 'stocktake_approve'].includes(type)) {
    await assertLocalOpenFiscalPeriod(postingDate, payload);
  }
}
async function applyOperationLocally(
  type: SyncOperation['type'],
  payload: any,
  syncStatus: 'synced' | 'pending',
  serverResult?: any
) {
  (globalThis as any).__posApplyingOperation = true;
  try {
    if (syncStatus === 'pending') await validateLocalOperationFiscalPeriod(type, payload);
    switch (type) {
      case 'sale':
        return await applySaleLocally(payload, syncStatus);
      case 'return':
        return await applyReturnLocally(payload, syncStatus);
      case 'order_void':
        return await applyOrderVoidLocally(payload, syncStatus);
      case 'purchase':
      case 'purchase_update':
      case 'purchase_delete':
        return await applyPurchaseLocally(type, payload, syncStatus);
      case 'purchase_return':
        return await applyPurchaseReturnLocally(payload, syncStatus);
      case 'expense':
      case 'expense_delete':
        return await applyExpenseLocally(type, payload, syncStatus);
      case 'customer_payment':
        return await applyCustomerPaymentLocally(payload, syncStatus);
      case 'supplier_payment':
        return await applySupplierPaymentLocally(payload, syncStatus);
      case 'payroll':
        return await applyPayrollLocally(payload, syncStatus);
      case 'shift_open':
      case 'shift_close':
      case 'shift_movement':
        return await applyShiftLocally(type, payload, syncStatus);
      case 'stocktake_approve':
        return await applyStocktakeApproveLocally(payload, syncStatus);
      case 'entity_upsert':
      case 'entity_delete':
        return await applyEntityLocally(type, payload, syncStatus, serverResult);
    }
  } finally {
    (globalThis as any).__posApplyingOperation = false;
  }
}

function enrichPayloadWithStableIds(type: SyncOperation['type'], payload: any) {
  if (type === 'entity_upsert' && ['products', 'categories', 'customers', 'suppliers', 'expenses'].includes(String(payload?.table)) && payload?.record && !payload.record.id) {
    return { ...payload, record: { ...payload.record, id: Date.now() } };
  }
  if (type === 'payroll' && !payload?.id) {
    return { ...payload, id: Date.now() };
  }
  if (type === 'expense' && !payload?.id) {
    return { ...payload, id: Date.now() };
  }
  if (type === 'return' && !payload?.id) {
    return { ...payload, id: generateUUID() };
  }
  if ((type === 'purchase' || type === 'purchase_update') && Array.isArray(payload?.items)) {
    return {
      ...payload,
      items: payload.items.map((item: any) => ({
        ...item,
        batchId: item.batchId || generateUUID(),
      })),
    };
  }
  if ((type === 'customer_payment' || type === 'supplier_payment') && !payload?.paymentId) {
    return { ...payload, paymentId: generateUUID() };
  }
  if (type === 'shift_movement' && !payload?.id) {
    return { ...payload, id: generateUUID() };
  }
  if (type === 'purchase_return' && !payload?.id) {
    return { ...payload, id: generateUUID() };
  }
  return payload;
}

function mergeServerResultIntoPayload(type: SyncOperation['type'], payload: any, result: any) {
  if (!result) return payload;
  if (type === 'sale' && result.order) {
    return { ...payload, order: result.order, _serverItems: result.items };
  }
  if ((type === 'purchase' || type === 'purchase_update') && result.purchase) {
    return { ...payload, purchase: result.purchase, _serverItems: result.items };
  }
  if ((type === 'expense' || type === 'payroll' || type === 'shift_movement') && result.id) {
    return { ...payload, id: result.id };
  }
  if (type === 'customer_payment' && result.payment?.id) {
    return { ...payload, paymentId: result.payment.id };
  }
  if (type === 'supplier_payment' && result.payment?.id) {
    return { ...payload, paymentId: result.payment.id };
  }
  return payload;
}

async function assertLocalOpenFiscalPeriod(dateValues: Array<string | undefined>, payload: any): Promise<void> {
  const periods = await getLocalRecords<any>('fiscalPeriods');
  if (!periods.length) return;
  let userRole = '';
  try { userRole = JSON.parse(localStorage.getItem('user') || 'null')?.role || ''; } catch {}
  const adminOverride = Boolean(payload?.allowClosedPeriodOverride) && (userRole === 'admin' || userRole === 'manager');
  for (const value of dateValues) {
    const targetDay = String(value || new Date().toISOString()).slice(0, 10);
    const closed = periods.find((period) =>
      period.status === 'closed' &&
      String(period.startDate || '').slice(0, 10) <= targetDay &&
      String(period.endDate || '').slice(0, 10) >= targetDay
    );
    if (closed && !adminOverride) {
      throw new Error(`الفترة المالية (${closed.name}) مغلقة ولا يمكن ترحيل عمليات بتاريخ ${targetDay}`);
    }
  }
}

async function validateStandaloneFiscalPeriod(type: SyncOperation['type'], payload: any): Promise<void> {
  const now = new Date().toISOString();
  const dates: Array<string | undefined> = [];
  switch (type) {
    case 'sale':
      dates.push(payload?.order?.createdAt || now);
      break;
    case 'return':
      dates.push(payload?.returnDate || now);
      break;
    case 'order_void': {
      const order = await getLocalRecord<any>('orders', String(payload?.orderId || payload?.id || ''));
      dates.push(order?.createdAt || now);
      break;
    }
    case 'purchase':
      dates.push(payload?.purchase?.date || now);
      break;
    case 'purchase_update': {
      const oldPurchase = await getLocalRecord<any>('purchases', String(payload?.purchase?.id || ''));
      dates.push(oldPurchase?.date || now, payload?.purchase?.date || now);
      break;
    }
    case 'purchase_delete': {
      const oldPurchase = await getLocalRecord<any>('purchases', String(payload?.id || ''));
      if (oldPurchase) dates.push(oldPurchase.date || now);
      break;
    }
    case 'purchase_return':
    case 'customer_payment':
    case 'supplier_payment':
    case 'shift_movement':
    case 'stocktake_approve':
      dates.push(now);
      break;
    case 'expense':
      dates.push(payload?.date || now);
      break;
    case 'payroll':
      dates.push(payload?.paymentDate || now);
      break;
  }
  if (dates.length) await assertLocalOpenFiscalPeriod(dates, payload);
}

export async function dispatchOperation(
  type: SyncOperation['type'],
  rawPayload: any,
  branchId?: number
): Promise<{ synced: boolean; operationId: string; result?: any }> {
  let payload = { ...enrichPayloadWithStableIds(type, rawPayload) };
  try {
    const localUser = JSON.parse(localStorage.getItem('user') || 'null');
    if (localUser?.role) payload.userRole = payload.userRole || localUser.role;
    if (!payload.actor && localUser?.role) payload.actor = { role: localUser.role, name: localUser.name };
    if (!payload.createdBy && localUser?.name) payload.createdBy = localUser.name;
  } catch {}
  if (type === 'purchase_update' || type === 'purchase_delete') {
    const purchaseId = String(type === 'purchase_delete' ? payload.id : payload.purchase?.id);
    const oldPurchase = await getLocalRecord<any>('purchases', purchaseId);
    const oldItems = await getLocalRecordsByIndex<any>('purchaseItems', 'purchaseId', purchaseId);
    payload = {
      ...payload,
      _localAffectedProductIds: oldItems.map((item) => Number(item.productId)),
      _localAffectedSupplierId: oldPurchase?.supplierId,
    };
  }
  const operationId = payload?.operationId || generateUUID();
  const deviceId = getDeviceId();
  const role = await getDeviceRole();
  setLocalAccountingStandaloneMode(role === 'standalone');
  const now = new Date().toISOString();
  const token = getAuthToken();

  const opRecord: SyncOperation = {
    id: operationId,
    type,
    payload: { ...payload, operationId, deviceId },
    deviceId,
    branchId,
    status: 'pending',
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  if (role === 'standalone') {
    // Apply the same closed-period posting restriction used by the server.
    await validateStandaloneFiscalPeriod(type, opRecord.payload);
    // Standalone transactions are committed locally and are not placed in a
    // server synchronization queue.
    await applyOperationLocally(type, opRecord.payload, 'synced');
    if (isNativeAndroid()) {
      await flushNativeDatabaseMirrorWrites();
    }
    return { synced: true, operationId };
  }

  if (role === 'server' && token) {
    try {
      const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
      const localPayload = mergeServerResultIntoPayload(type, opRecord.payload, response.result);
      await applyOperationLocally(type, localPayload, 'synced', response.result);
      if (isNativeAndroid()) {
        try {
          await flushNativeDatabaseMirrorWrites();
        } catch (mirrorError) {
          throw Object.assign(
            new Error('تم قبول العملية على الخادم لكن تعذر تثبيت نسختها المحلية في SQLite؛ يلزم إصلاح النسخة المحلية قبل متابعة العمل'),
            { nativeSqliteMirrorFailure: true, cause: mirrorError },
          );
        }
      }
      import('./syncService').then(({ syncService }) => syncService.pullAll().catch(() => {}));
      return { synced: true, operationId, result: response.result };
    } catch (err: any) {
      if (err?.nativeSqliteMirrorFailure) throw err;
      if (
        err?.response &&
        err.response.status >= 400 &&
        err.response.status < 500 &&
        err.response.status !== 401
      ) {
        throw new Error(err.response?.data?.error || err.message);
      }
    }
  }

  // Enforce local stock policy before queueing offline sale when offlineStockPolicy is 'block'
  if (type === 'sale' && !payload?.allowNegativeOverride && !payload?.managerOverride) {
    try {
      const policyRow = await getLocalSettingByKey('offlineStockPolicy');
      const allowNegRow = await getLocalSettingByKey('allowNegativeStock');
      const policy = policyRow?.value || (allowNegRow?.value === 'false' || allowNegRow?.value === false ? 'block' : 'allow_with_alert');
      if (policy === 'block') {
        for (const item of payload?.items || []) {
          const prod = await getLocalRecord<any>('products', Number(item.productId));
          if (!prod) continue;
          const itemType = String(item.itemType || prod.itemType || 'stock');
          if (itemType === 'service') continue;
          const factor = resolveLocalUnitFactor(prod, item);
          const baseQty = roundQty(Number(item.quantity || 0) * factor);
          if (itemType === 'service_with_materials' || itemType === 'bundle') {
            const recipes = await getLocalRecordsByIndex<any>('serviceRecipes', 'parentProductId', Number(prod.id));
            if (recipes.length > 0) {
              for (const rec of recipes) {
                const ing = await getLocalRecord<any>('products', Number(rec.ingredientProductId));
                const needed = roundQty(baseQty * Number(rec.quantity || 0));
                if (ing && ing.stockQuantity < needed) {
                  throw new Error(`الرصيد غير كافٍ للمادة الخام: ${ing.name} (المتاح: ${ing.stockQuantity})`);
                }
              }
              continue;
            }
          }
          if (itemType === 'stock' && prod.stockQuantity < baseQty) {
            throw new Error(`الرصيد غير كافٍ للصنف: ${prod.name} (المتاح: ${prod.stockQuantity})`);
          }
        }
      }
    } catch (policyErr: any) {
      throw policyErr;
    }
  }

  await db.syncOperations.put(opRecord);
  // Persist the Android outbox before mutating the local business tables. If the
  // WebView closes during the mutation, the durable operation can still replay.
  if (isNativeAndroid()) {
    try {
      const queued = await enqueueNativePosOperation({
        operationId, type, payload: opRecord.payload, deviceId,
        branchId: branchId === undefined ? undefined : String(branchId), schemaVersion: 1,
      });
      if (!queued) {
        throw new Error('تعذر حفظ العملية في طابور SQLite المحلي؛ أُوقِف تنفيذ العملية لحماية البيانات');
      }
    } catch (error) {
      console.error('Android SQLite outbox write failed; operation was not applied:', error);
      throw error instanceof Error
        ? error
        : new Error('تعذر حفظ العملية في طابور SQLite المحلي؛ أُوقِف تنفيذ العملية لحماية البيانات');
    }
  }
  await applyOperationLocally(type, opRecord.payload, 'pending');
  if (type === 'purchase_update' || type === 'purchase_delete') {
    await db.syncOperations.update(operationId, { payload: opRecord.payload });
  }

  if (isNativeAndroid()) {
    // Every committed Dexie business transaction is mirrored as one atomic
    // SQLite batch before the operation can be reported as accepted locally.
    await flushNativeDatabaseMirrorWrites();
  }

  if (token) {
    const reachable = await apiService.checkServerReachability(2000);
    if (reachable) {
      try {
        const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
        await db.syncOperations.update(operationId, {
          status: 'synced', lastError: undefined, updatedAt: new Date().toISOString(),
        });
        if (isNativeAndroid()) {
          await acknowledgeNativePosOperation(operationId).catch((error) =>
            console.error('Could not acknowledge Android SQLite outbox item:', error)
          );
        }
        await reconcileLocalOperationAfterAck(type, opRecord.payload, operationId, response.result);
        // The local mutation is not replayed after acknowledgement; pullAll applies
        // the authoritative server records without duplicating stock or balances.
        useSyncStore.getState().setLastSynced(new Date());
        import('./syncService').then(({ syncService }) => {
          syncService.updatePendingCount();
          syncService.pullAll().catch(() => {});
        });
        return { synced: true, operationId, result: response.result };
      } catch (err: any) {
        if (
          err?.response &&
          err.response.status >= 400 &&
          err.response.status < 500 &&
          err.response.status !== 401
        ) {
          const message = err.response?.data?.error || err.message;
          await db.syncOperations.update(operationId, {
            status: 'conflict',
            lastError: message,
            updatedAt: new Date().toISOString(),
          });
          if (isNativeAndroid()) {
            await markNativePosOperationConflict(operationId, message).catch(() => {});
          }
          throw new Error(message);
        }
      }
    }
  }

  import('./syncService').then(({ syncService }) => syncService.updatePendingCount());
  return { synced: false, operationId };
}
