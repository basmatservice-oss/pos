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
import { getBasePerDocumentUnit } from '../utils/currencyConversion.js';

const DEVICE_ID_KEY = 'pos_device_id';

export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function getDeviceRole(): Promise<'server' | 'client'> {
  try {
    const setting = await db.settings.where('key').equals('deviceRole').first();
    return setting?.value === 'client' ? 'client' : 'server';
  } catch {
    return 'server';
  }
}

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getBaseMovementQuantity(item: any, quantity = Number(item?.quantity || 0)): number {
  const originalQuantity = Number(item?.quantity || 0);
  const hasStoredBaseQuantity = item?.baseQuantity !== null && item?.baseQuantity !== undefined;
  const storedBaseQuantity = Number(item?.baseQuantity);
  if (hasStoredBaseQuantity && originalQuantity > 0 && Number.isFinite(storedBaseQuantity) && storedBaseQuantity >= 0) {
    return storedBaseQuantity * (quantity / originalQuantity);
  }
  const factor = Number(item?.conversionToBase ?? item?.selectedConversionToBase ??
    (item?.unit === 'box' || item?.selectedUnit === 'box' ? item?.conversionFactor : 1) ?? 1);
  return quantity * (Number.isFinite(factor) && factor > 0 ? factor : 1);
}

type LocalBatchAllocation = { batchId: string | null; quantity: number; costPrice: number };

function parseLocalBatchAllocations(value: unknown): LocalBatchAllocation[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row: any) => row && Number(row.quantity) > 0)
      .map((row: any) => ({
        batchId: row.batchId == null ? null : String(row.batchId),
        quantity: Number(row.quantity),
        costPrice: Number(row.costPrice || 0),
      }));
  } catch {
    return [];
  }
}

async function consumeLocalInventoryFIFO(
  productId: number,
  quantityInBaseUnits: number,
  fallbackCost: number,
  syncStatus: 'synced' | 'pending'
): Promise<{ allocations: LocalBatchAllocation[]; totalCost: number; averageUnitCost: number }> {
  const now = new Date().toISOString();
  const batches = await db.inventoryBatches.where('productId').equals(productId).toArray();
  batches.sort((a, b) =>
    String(a.purchaseDate || a.createdAt || '').localeCompare(String(b.purchaseDate || b.createdAt || '')) ||
    String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  );

  let remaining = quantityInBaseUnits;
  let totalCost = 0;
  const allocations: LocalBatchAllocation[] = [];
  for (const batch of batches) {
    if (remaining <= 1e-9) break;
    const available = Math.max(0, Number(batch.remainingQuantity ?? batch.quantity ?? 0));
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    const costPrice = Number(batch.costPrice ?? fallbackCost);
    await db.inventoryBatches.update(batch.id!, {
      remainingQuantity: available - take,
      updatedAt: now,
      syncStatus,
    });
    allocations.push({ batchId: String(batch.id), quantity: take, costPrice });
    totalCost += take * costPrice;
    remaining -= take;
  }

  if (remaining > 1e-9) {
    const costPrice = Number(fallbackCost || 0);
    allocations.push({ batchId: null, quantity: remaining, costPrice });
    totalCost += remaining * costPrice;
  }

  return {
    allocations,
    totalCost: roundMoney(totalCost),
    averageUnitCost: quantityInBaseUnits > 0 ? totalCost / quantityInBaseUnits : Number(fallbackCost || 0),
  };
}

async function restoreLocalInventoryFIFO(
  productId: number,
  quantityInBaseUnits: number,
  sourceAllocations: LocalBatchAllocation[],
  fallbackCost: number,
  branchId: number | undefined,
  syncStatus: 'synced' | 'pending'
): Promise<{
  restoredAllocations: LocalBatchAllocation[];
  remainingAllocations: LocalBatchAllocation[];
  totalCostRestored: number;
}> {
  const now = new Date().toISOString();
  const product = await db.products.get(productId);
  if (!product) throw new Error(`الصنف رقم ${productId} غير موجود`);

  let remaining = quantityInBaseUnits;
  let totalCostRestored = 0;
  const restoredAllocations: LocalBatchAllocation[] = [];
  const remainingAllocations = sourceAllocations
    .filter((allocation) => allocation && Number(allocation.quantity) > 0)
    .map((allocation) => ({ ...allocation, quantity: Number(allocation.quantity) }));

  const createReturnBatch = async (quantity: number, costPrice: number) => {
    if (quantity <= 0) return;
    const batchId = generateUUID();
    await db.inventoryBatches.put({
      id: batchId,
      productId,
      purchaseId: null,
      quantity,
      remainingQuantity: quantity,
      costPrice,
      unitCode: product.baseUnitCode || null,
      baseUnitCode: product.baseUnitCode || null,
      conversionToBase: 1,
      baseQuantity: quantity,
      purchaseDate: now,
      branchId,
      syncStatus,
      createdAt: now,
      updatedAt: now,
    });
    restoredAllocations.push({ batchId, quantity, costPrice });
  };

  for (let i = remainingAllocations.length - 1; i >= 0 && remaining > 1e-9; i--) {
    const allocation = remainingAllocations[i];
    const take = Math.min(remaining, allocation.quantity);
    if (take <= 0) continue;
    const costPrice = Number(allocation.costPrice ?? fallbackCost);
    let restoredToOriginal = 0;

    if (allocation.batchId) {
      const batch = await db.inventoryBatches.get(allocation.batchId);
      if (batch) {
        const capacity = Math.max(
          0,
          Number(batch.quantity || 0) - Number(batch.remainingQuantity ?? 0)
        );
        restoredToOriginal = Math.min(take, capacity);
        if (restoredToOriginal > 0) {
          await db.inventoryBatches.update(batch.id!, {
            remainingQuantity: Number(batch.remainingQuantity ?? 0) + restoredToOriginal,
            updatedAt: now,
            syncStatus,
          });
          restoredAllocations.push({
            batchId: String(batch.id),
            quantity: restoredToOriginal,
            costPrice,
          });
        }
      }
    }

    const missing = take - restoredToOriginal;
    if (missing > 1e-9) await createReturnBatch(missing, costPrice);
    totalCostRestored += take * costPrice;
    allocation.quantity -= take;
    remaining -= take;
  }

  if (remaining > 1e-9) {
    await createReturnBatch(remaining, Number(fallbackCost || 0));
    totalCostRestored += remaining * Number(fallbackCost || 0);
  }

  return {
    restoredAllocations,
    remainingAllocations: remainingAllocations.filter((allocation) => allocation.quantity > 1e-9),
    totalCostRestored: roundMoney(totalCostRestored),
  };
}

async function recalculateLocalProductWeightedCost(
  productId: number,
  syncStatus: 'synced' | 'pending'
): Promise<void> {
  const batches = await db.inventoryBatches.where('productId').equals(productId).toArray();
  let totalQuantity = 0;
  let totalValue = 0;
  for (const batch of batches) {
    const remaining = Math.max(0, Number(batch.remainingQuantity ?? batch.quantity ?? 0));
    if (remaining <= 0) continue;
    totalQuantity += remaining;
    totalValue += remaining * Number(batch.costPrice || 0);
  }
  if (totalQuantity <= 0) return;
  const product = await db.products.get(productId);
  if (product) {
    await db.products.update(productId, {
      costPrice: roundMoney(totalValue / totalQuantity),
      updatedAt: new Date().toISOString(),
      syncStatus,
    });
  }
}

async function applySaleLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { order, items = [], pointsEarned = 0, pointsRedeemed = 0, _serverItems } = payload;
  const now = order.createdAt || new Date().toISOString();

  await db.transaction(
    'rw',
    [db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions, db.inventoryBatches],
    async () => {
      await db.orders.put({ ...order, syncStatus });
      await db.orderItems.where('orderId').equals(order.id).delete();

      if (Array.isArray(_serverItems) && _serverItems.length > 0) {
        await db.orderItems.bulkPut(
          _serverItems.map((si: any) => ({
            ...si,
            syncStatus,
          }))
        );
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const baseQty = Number(_serverItems[index]?.baseQuantity ?? getBaseMovementQuantity(item));
          const product = await db.products.get(item.productId);
          if (product) {
            await db.products.update(product.id!, {
              stockQuantity: product.stockQuantity - baseQty,
              updatedAt: now,
              syncStatus,
            });
          }
        }
      } else {
        for (const item of items) {
          await db.orderItems.add({
            orderId: order.id,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            returnedQuantity: 0,
            unit: item.unit || item.selectedUnit || 'piece',
            conversionFactor: item.conversionToBase ?? item.selectedConversionToBase ?? item.conversionFactor ?? 1,
            unitCode: item.unitCode || item.selectedUnitCode || null,
            baseUnitCode: item.baseUnitCode || null,
            conversionToBase: item.conversionToBase ?? item.selectedConversionToBase ?? item.conversionFactor ?? 1,
            baseQuantity: getBaseMovementQuantity(item),
            unitPrice: item.unitPrice,
            costPriceAtTimeOfSale: item.costPriceAtTimeOfSale,
            discountAmount: item.discountAmount || 0,
            subTotal: item.subTotal,
            taxAmount: item.taxAmount,
            total: item.total,
            syncStatus,
          });

          const baseQty = getBaseMovementQuantity(item);
          const product = await db.products.get(item.productId);
          if (product) {
            await db.products.update(product.id!, {
              stockQuantity: product.stockQuantity - baseQty,
              updatedAt: now,
              syncStatus,
            });
          }
        }
      }

      if (order.customerId) {
        const customer = await db.customers.get(order.customerId);
        if (customer) {
          const balanceDelta = order.paymentMethod === 'credit' ? Number(order.netAmount || 0) : 0;
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
    }
  );
}

async function applyOrderVoidLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const targetOrderId = String(payload?.orderId || payload?.id || '');
  if (!targetOrderId) return;
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions],
    async () => {
      const origOrder = await db.orders.get(targetOrderId);
      if (!origOrder || origOrder.status === 'void') return;

      if (Number(origOrder.returnedAmount || 0) > 0 || origOrder.status === 'returned' || origOrder.status === 'partially_returned') {
        throw new Error('لا يمكن إلغاء فاتورة تم إرجاع أصناف منها مسبقاً');
      }
      const origItems = await db.orderItems.where('orderId').equals(targetOrderId).toArray();
      for (const oi of origItems) {
        const baseQty = getBaseMovementQuantity(oi);
        const product = await db.products.get(oi.productId);
        if (product) {
          await db.products.update(product.id!, {
            stockQuantity: product.stockQuantity + baseQty,
            updatedAt: now,
            syncStatus,
          });
        }
      }

      if (origOrder.customerId) {
        const customer = await db.customers.get(origOrder.customerId);
        if (customer) {
          const orderLoyalty = await db.loyaltyTransactions
            .where('orderId')
            .equals(targetOrderId)
            .toArray();
          let pointsDelta = 0;
          for (const lt of orderLoyalty) {
            if (lt.type === 'earn') pointsDelta -= Number(lt.points || 0);
            if (lt.type === 'redeem') pointsDelta += Number(lt.points || 0);
          }
          const balanceDelta =
            origOrder.paymentMethod === 'credit' ? -Number(origOrder.netAmount || 0) : 0;

          await db.customers.update(customer.id!, {
            balance: roundMoney((customer.balance || 0) + balanceDelta),
            points: Math.max(0, (customer.points || 0) + pointsDelta),
            updatedAt: now,
            syncStatus,
          });
        }
      }

      await db.orders.update(targetOrderId, {
        status: 'void',
        paidAmount: 0,
        updatedAt: now,
        syncStatus,
      });
    }
  );
}

async function applyReturnLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { id, returnNumber, originalOrderId, items = [], refundMethod, reason, branchId, shiftId, createdBy } =
    payload;
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.returns, db.returnItems, db.orders, db.orderItems, db.products, db.customers, db.unitDefinitions],
    async () => {
      const origOrder = await db.orders.get(originalOrderId);
      const origItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();

      let totalRefund = 0;
      let totalTax = 0;
      let totalSub = 0;
      let totalCostReversed = 0;

      for (const reqItem of items) {
        const qty = Number(reqItem.quantity);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('كمية المرتجع يجب أن تكون رقماً موجباً');
        const origItem = reqItem.orderItemId
          ? origItems.find((oi) => oi.id === reqItem.orderItemId)
          : origItems.find((oi) =>
              oi.productId === reqItem.productId &&
              Number(oi.quantity || 0) - Number(oi.returnedQuantity || 0) >= qty
            );
        if (!origItem) throw new Error('الصنف غير موجود في الفاتورة الأصلية أو لا توجد كمية كافية للإرجاع');
        const remainingReturnable = Number(origItem.quantity || 0) - Number(origItem.returnedQuantity || 0);
        if (qty > remainingReturnable) throw new Error('كمية المرتجع تتجاوز الكمية المتبقية في الفاتورة الأصلية');
        if (origItem.unitCode) {
          const unitDefinition = await db.unitDefinitions.get(origItem.unitCode);
          const precision = Math.max(0, Math.min(6, Number(unitDefinition?.decimalPlaces ?? 0)));
          const scale = 10 ** precision;
          if (!unitDefinition || Math.abs(qty * scale - Math.round(qty * scale)) > 1e-7) {
            throw new Error('كمية المرتجع لا تتوافق مع دقة وحدة البيع الأصلية');
          }
        }
        const ratio = qty / Number(origItem.quantity);
        const lineSub = roundMoney(Number(origItem.subTotal) * ratio);
        const lineTax = roundMoney(Number(origItem.taxAmount) * ratio);
        const lineTotal = roundMoney(Number(origItem.total) * ratio);
        const lineCost = roundMoney(Number(origItem.costPriceAtTimeOfSale || 0) * qty);

        totalSub += lineSub;
        totalTax += lineTax;
        totalRefund += lineTotal;
        totalCostReversed += lineCost;

        if (origItem.id) {
          await db.orderItems.update(origItem.id, {
            returnedQuantity: Number(origItem.returnedQuantity || 0) + qty,
            syncStatus,
          });
        }

        const baseQty = getBaseMovementQuantity(origItem, qty);
        const product = await db.products.get(origItem.productId);
        if (product) {
          await db.products.update(product.id!, {
            stockQuantity: product.stockQuantity + baseQty,
            updatedAt: now,
            syncStatus,
          });
        }

        const retItem: ReturnItem = {
          id: generateUUID(),
          returnId: id,
          orderItemId: origItem.id,
          productId: origItem.productId,
          productName: origItem.productName,
          quantity: qty,
          unitPrice: origItem.unitPrice,
          unitCode: origItem.unitCode || null,
          baseUnitCode: origItem.baseUnitCode || null,
          conversionToBase: origItem.conversionToBase ?? origItem.conversionFactor ?? 1,
          baseQuantity: baseQty,
          costPrice: origItem.costPriceAtTimeOfSale || 0,
          taxAmount: lineTax,
          total: lineTotal,
          syncStatus,
          createdAt: now,
        };
        await db.returnItems.put(retItem);
      }

      if (origOrder) {
        const updatedItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();
        const fullReturn = updatedItems.every((i) => Number(i.returnedQuantity || 0) >= Number(i.quantity));

        await db.orders.update(originalOrderId, {
          status: fullReturn ? 'returned' : 'partially_returned',
          returnedAmount: roundMoney((origOrder.returnedAmount || 0) + totalRefund),
          updatedAt: now,
          syncStatus,
        });

        if (origOrder.customerId && refundMethod === 'credit_adjustment') {
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
        refundMethod,
        subTotal: roundMoney(totalSub),
        discountAmount: 0,
        taxAmount: roundMoney(totalTax),
        totalRefund: roundMoney(totalRefund),
        totalCostReversed: roundMoney(totalCostReversed),
        reason,
        createdBy,
        createdAt: now,
        updatedAt: now,
        syncStatus,
      };
      await db.returns.put(retDoc);
    }
  );
}

async function applyPurchaseLocally(
  type: 'purchase' | 'purchase_update' | 'purchase_delete',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();

  let resolvedPurchase = payload.purchase;
  let resolvedItems: any[] = payload.items || [];
  const serverItems: any[] = Array.isArray(payload._serverItems) ? payload._serverItems : [];

  if (type !== 'purchase_delete' && resolvedPurchase?.currencyCode) {
    if (serverItems.length > 0) {
      // Server-returned item costs are authoritative and already converted to base currency.
      resolvedItems = resolvedItems.map((item, index) => {
        const serverItem = serverItems[index] || serverItems.find(
          (candidate) => candidate.productId === item.productId && Number(candidate.quantity) === Number(item.quantity)
        );
        return {
          ...item,
          costPrice: Number(serverItem?.costPrice ?? item.costPrice),
          unitCode: serverItem?.unitCode ?? item.unitCode ?? null,
          baseUnitCode: serverItem?.baseUnitCode ?? item.baseUnitCode ?? null,
          conversionToBase: Number(serverItem?.conversionToBase ?? item.conversionToBase ?? 1),
          baseQuantity: Number(serverItem?.baseQuantity ?? item.baseQuantity ?? getBaseMovementQuantity(item)),
          originalCostPrice: serverItem?.originalCostPrice ?? item.costPrice,
          originalTotal: serverItem?.originalTotal ?? roundMoney(Number(item.quantity) * Number(item.costPrice)),
          currencyCode: serverItem?.currencyCode ?? resolvedPurchase.currencyCode,
          exchangeRate: serverItem?.exchangeRate ?? resolvedPurchase.exchangeRate,
          exchangeRateId: serverItem?.exchangeRateId ?? resolvedPurchase.exchangeRateId,
        };
      });
    } else {
      // Offline optimistic application uses the exact approved rate snapshot selected in the UI.
      const baseSetting = await db.settings.where('key').equals('baseCurrencyCode').first();
      const baseCurrencyCode = String(resolvedPurchase.baseCurrencyCode || baseSetting?.value || '').toUpperCase();
      const currencyCode = String(resolvedPurchase.currencyCode).toUpperCase();
      if (!baseCurrencyCode) throw new Error('لا توجد عملة أساسية محفوظة على هذا الجهاز');

      let conversionRate = 1;
      let exchangeRateId: string | null = null;
      if (currencyCode !== baseCurrencyCode) {
        exchangeRateId = resolvedPurchase.exchangeRateId || null;
        const rate = exchangeRateId ? await db.exchangeRates.get(exchangeRateId) : undefined;
        const invoiceCutoff = new Date(`${String(resolvedPurchase.date || now).slice(0, 10)}T23:59:59.999Z`).getTime();
        const pairMatches = rate && (
          (rate.baseCurrencyCode === currencyCode && rate.quoteCurrencyCode === baseCurrencyCode) ||
          (rate.baseCurrencyCode === baseCurrencyCode && rate.quoteCurrencyCode === currencyCode)
        );
        if (!rate || !rate.approvedAt || !pairMatches || new Date(rate.effectiveAt).getTime() > invoiceCutoff) {
          throw new Error('سعر الصرف المعتمد المحدد غير متوفر في التخزين المحلي؛ أعد المزامنة قبل تسجيل الفاتورة');
        }
        conversionRate = getBasePerDocumentUnit(rate, currencyCode, baseCurrencyCode);
      }

      const originalTotalAmount = roundMoney(Number(resolvedPurchase.totalAmount || 0));
      const originalPaidAmount = roundMoney(Number(resolvedPurchase.paidAmount || 0));
      resolvedPurchase = {
        ...resolvedPurchase,
        currencyCode,
        baseCurrencyCode,
        exchangeRate: conversionRate,
        exchangeRateId,
        originalTotalAmount,
        originalPaidAmount,
        totalAmount: roundMoney(originalTotalAmount * conversionRate),
        paidAmount: roundMoney(originalPaidAmount * conversionRate),
      };
      resolvedItems = resolvedItems.map((item) => ({
        ...item,
        originalCostPrice: Number(item.costPrice || 0),
        originalTotal: roundMoney(Number(item.quantity || 0) * Number(item.costPrice || 0)),
        currencyCode,
        exchangeRate: conversionRate,
        exchangeRateId,
        costPrice: roundMoney(Number(item.costPrice || 0) * conversionRate),
      }));
    }
  }

  if (serverItems.length > 0) {
    resolvedItems = resolvedItems.map((item, index) => {
      const serverItem = serverItems[index] || serverItems.find(
        (candidate) => candidate.productId === item.productId && Number(candidate.quantity) === Number(item.quantity)
      );
      return {
        ...item,
        ...(serverItem || {}),
        batchId: item.batchId || serverItem?.batchId,
      };
    });
  }

  await db.transaction(
    'rw',
    [db.purchases, db.purchaseItems, db.products, db.suppliers, db.inventoryBatches],
    async () => {
      if (type === 'purchase_delete' || type === 'purchase_update') {
        const pid = type === 'purchase_delete' ? payload.id : resolvedPurchase.id;
        const oldPurchase = await db.purchases.get(pid);
        const oldItems = await db.purchaseItems.where('purchaseId').equals(pid).toArray();
        for (const item of oldItems) {
          const prod = await db.products.get(item.productId);
          if (prod) {
            await db.products.update(prod.id!, {
              stockQuantity: prod.stockQuantity - getBaseMovementQuantity(item),
              updatedAt: now,
              syncStatus,
            });
          }
        }
        await db.purchaseItems.where('purchaseId').equals(pid).delete();
        await db.inventoryBatches.where('purchaseId').equals(pid).delete();
        if (oldPurchase && oldPurchase.supplierId) {
          const oldRemaining = oldPurchase.totalAmount - oldPurchase.paidAmount;
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

      await db.purchases.put({ ...resolvedPurchase, returnedAmount: resolvedPurchase.returnedAmount || 0, syncStatus });
      await db.purchaseItems.where('purchaseId').equals(resolvedPurchase.id).delete();

      if (serverItems.length > 0) {
        await db.purchaseItems.bulkPut(serverItems.map((item: any) => ({ ...item, syncStatus })));
      }

      for (const item of resolvedItems) {
        if (serverItems.length === 0) {
          await db.purchaseItems.add({
            purchaseId: resolvedPurchase.id,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            costPrice: item.costPrice,
            unitCode: item.unitCode || null,
            baseUnitCode: item.baseUnitCode || null,
            conversionToBase: item.conversionToBase ?? 1,
            baseQuantity: item.baseQuantity ?? getBaseMovementQuantity(item),
            originalCostPrice: item.originalCostPrice ?? null,
            originalTotal: item.originalTotal ?? null,
            currencyCode: item.currencyCode ?? resolvedPurchase.currencyCode ?? null,
            exchangeRate: item.exchangeRate ?? resolvedPurchase.exchangeRate ?? null,
            exchangeRateId: item.exchangeRateId ?? resolvedPurchase.exchangeRateId ?? null,
            total: roundMoney(item.quantity * item.costPrice),
            syncStatus,
          });
        }
        const conversionToBase = Number(item.conversionToBase || 1);
        const baseQuantity = Number(item.baseQuantity ?? getBaseMovementQuantity(item));
        const baseUnitCost = conversionToBase > 0 ? Number(item.costPrice || 0) / conversionToBase : Number(item.costPrice || 0);
        await db.inventoryBatches.put({
          id: item.batchId || generateUUID(),
          productId: item.productId,
          purchaseId: resolvedPurchase.id,
          quantity: baseQuantity,
          remainingQuantity: baseQuantity,
          costPrice: baseUnitCost,
          originalCostPrice: item.originalCostPrice == null ? null : Number(item.originalCostPrice) / conversionToBase,
          unitCode: item.unitCode || null,
          baseUnitCode: item.baseUnitCode || null,
          conversionToBase,
          baseQuantity,
          currencyCode: item.currencyCode ?? resolvedPurchase.currencyCode ?? null,
          exchangeRate: item.exchangeRate ?? resolvedPurchase.exchangeRate ?? null,
          exchangeRateId: item.exchangeRateId ?? resolvedPurchase.exchangeRateId ?? null,
          purchaseDate: resolvedPurchase.date || now,
          branchId: resolvedPurchase.branchId,
          syncStatus,
        });
        const prod = await db.products.get(item.productId);
        if (prod) {
          await db.products.update(prod.id!, {
            stockQuantity: prod.stockQuantity + baseQuantity,
            costPrice: baseUnitCost,
            updatedAt: now,
            syncStatus,
          });
        }
      }

      const remaining = Number(resolvedPurchase.totalAmount || 0) - Number(resolvedPurchase.paidAmount || 0);
      if (resolvedPurchase.supplierId && remaining > 0) {
        const sup = await db.suppliers.get(resolvedPurchase.supplierId);
        if (sup) {
          await db.suppliers.update(sup.id!, {
            balance: roundMoney((sup.balance || 0) + remaining),
            updatedAt: now,
            syncStatus,
          });
        }
      }
    }
  );
}

async function applyPurchaseReturnLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const { id, returnNumber, originalPurchaseId, items = [], refundMethod = 'credit_adjustment', reason, branchId, shiftId, createdBy } =
    payload;
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.purchaseReturns, db.purchaseReturnItems, db.purchases, db.inventoryBatches, db.products, db.suppliers],
    async () => {
      const origPurchase = await db.purchases.get(String(originalPurchaseId));
      const batches = await db.inventoryBatches.where('purchaseId').equals(String(originalPurchaseId)).toArray();

      let totalReturn = 0;
      for (const reqItem of items) {
        const qty = Number(reqItem.quantity || 0);
        if (qty <= 0) continue;
        const batch = reqItem.batchId
          ? batches.find((b) => b.id === reqItem.batchId && b.productId === Number(reqItem.productId))
          : batches.find((b) =>
              b.productId === Number(reqItem.productId) && (!reqItem.unitCode || b.unitCode === reqItem.unitCode)
            );
        if (reqItem.unitCode && !batch) throw new Error('لا يمكن إرجاع وحدة شراء دون العثور على دفعتها الأصلية');
        const conversionToBase = Number(batch?.conversionToBase || 1);
        const baseQuantity = qty * conversionToBase;
        if (batch && Number(batch.remainingQuantity ?? batch.quantity) < baseQuantity) {
          throw new Error('الكمية المتبقية في دفعة الشراء لا تكفي لتنفيذ المرتجع');
        }
        const cost = Number(reqItem.costPrice || 0);
        const lineTotal = roundMoney(qty * cost);
        totalReturn = roundMoney(totalReturn + lineTotal);

        if (batch && batch.id) {
          const curRem = Number(batch.remainingQuantity ?? batch.quantity);
          await db.inventoryBatches.update(batch.id, {
            remainingQuantity: curRem - baseQuantity,
            updatedAt: now,
            syncStatus,
          });
        }

        const prod = await db.products.get(Number(reqItem.productId));
        if (!batch && (!prod || Number(prod.stockQuantity || 0) < baseQuantity)) {
          throw new Error('المخزون المتاح لا يكفي لتنفيذ مرتجع المشتريات');
        }
        if (prod) {
          await db.products.update(prod.id!, {
            stockQuantity: prod.stockQuantity - baseQuantity,
            updatedAt: now,
            syncStatus,
          });
        }

        const itemDoc: PurchaseReturnItem = {
          id: generateUUID(),
          purchaseReturnId: id,
          productId: Number(reqItem.productId),
          productName: reqItem.productName || '',
          quantity: qty,
          costPrice: cost,
          total: lineTotal,
          unitCode: batch?.unitCode || reqItem.unitCode || null,
          baseUnitCode: batch?.baseUnitCode || reqItem.baseUnitCode || null,
          conversionToBase,
          baseQuantity,
          batchId: batch?.id ? String(batch.id) : undefined,
          syncStatus,
          createdAt: now,
        };
        await db.purchaseReturnItems.put(itemDoc);
      }

      if (origPurchase) {
        const newReturned = roundMoney((origPurchase.returnedAmount || 0) + totalReturn);
        const netPayable = Math.max(0, roundMoney(origPurchase.totalAmount - newReturned));
        await db.purchases.update(origPurchase.id!, {
          returnedAmount: newReturned,
          paymentStatus: origPurchase.paidAmount >= netPayable ? 'paid' : origPurchase.paidAmount > 0 ? 'partial' : 'unpaid',
          syncStatus,
        });

        if (refundMethod === 'credit_adjustment' && origPurchase.supplierId) {
          const sup = await db.suppliers.get(origPurchase.supplierId);
          if (sup) {
            await db.suppliers.update(sup.id!, {
              balance: roundMoney((sup.balance || 0) - totalReturn),
              updatedAt: now,
              syncStatus,
            });
          }
        }
      }

      const retDoc: PurchaseReturn = {
        id,
        returnNumber,
        originalPurchaseId: String(originalPurchaseId),
        supplierId: origPurchase?.supplierId,
        supplierName: origPurchase?.supplierName,
        branchId: branchId ?? origPurchase?.branchId,
        shiftId,
        refundMethod,
        totalReturn,
        reason,
        createdBy,
        createdAt: now,
        updatedAt: now,
        syncStatus,
      };
      await db.purchaseReturns.put(retDoc);
    }
  );
}

async function applyExpenseLocally(
  type: 'expense' | 'expense_delete',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();
  if (type === 'expense_delete') {
    if (payload?.id !== undefined) {
      await db.expenses.delete(Number(payload.id));
    }
    return;
  }

  await db.expenses.put({
    id: payload.id,
    description: payload.description,
    amount: Number(payload.amount || 0),
    category: payload.category || 'عام',
    paymentMethod: payload.paymentMethod || 'cash',
    shiftId: payload.shiftId,
    date: payload.date || now,
    branchId: payload.branchId,
    createdAt: payload.createdAt || now,
    updatedAt: now,
    syncStatus,
  });
}

async function applyCustomerPaymentLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payAmount = Number(payload.amount || 0);
  await db.transaction('rw', [db.customers, db.orders, db.customerPayments], async () => {
    const cust = await db.customers.get(Number(payload.customerId));
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
      id: payload.paymentId || payload.operationId || generateUUID(),
      customerId: Number(payload.customerId),
      customerName: cust?.name || payload.customerName,
      orderId: payload.orderId,
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
  });
}

async function applySupplierPaymentLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  const payAmount = Number(payload.amount || 0);
  await db.transaction('rw', [db.suppliers, db.purchases, db.supplierPayments], async () => {
    const sup = await db.suppliers.get(Number(payload.supplierId));
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
      id: payload.paymentId || payload.operationId || generateUUID(),
      supplierId: Number(payload.supplierId),
      supplierName: sup?.name || payload.supplierName,
      purchaseId: payload.purchaseId,
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
  });
}

async function applyPayrollLocally(payload: any, syncStatus: 'synced' | 'pending') {
  const now = new Date().toISOString();
  await db.payroll.put({
    id: payload.id,
    employeeId: Number(payload.employeeId),
    employeeName: payload.employeeName,
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    salaryType: payload.salaryType === 'hourly' ? 'hourly' : 'monthly',
    totalHours: Number(payload.totalHours || 0),
    hourlyRate: Number(payload.hourlyRate || 0),
    basicSalary: Number(payload.basicSalary || 0),
    bonuses: Number(payload.bonuses || 0),
    deductions: Number(payload.deductions || 0),
    netSalary: Number(payload.netSalary || 0),
    paymentMethod: payload.paymentMethod === 'card' ? 'card' : 'cash',
    branchId: payload.branchId,
    paymentDate: payload.paymentDate || now,
    status: payload.status || 'paid',
    syncStatus,
  });
}

async function applyShiftLocally(
  type: 'shift_open' | 'shift_close' | 'shift_movement',
  payload: any,
  syncStatus: 'synced' | 'pending'
) {
  const now = new Date().toISOString();
  if (type === 'shift_open') {
    await db.shifts.put({
      id: payload.id,
      startTime: payload.startTime || now,
      openingCash: Number(payload.openingCash || 0),
      status: 'open',
      branchId: payload.branchId,
      syncStatus,
    });
  } else if (type === 'shift_close') {
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
  const { sessionId } = payload;
  await db.transaction('rw', [db.products, db.stocktakingSessions, db.stocktakingEntries], async () => {
    const entries = await db.stocktakingEntries.where('sessionId').equals(sessionId).toArray();
    for (const entry of entries) {
      await db.products.update(entry.productId, {
        stockQuantity: entry.actualQuantity,
        updatedAt: now,
        syncStatus,
      });
    }
    await db.stocktakingSessions.update(sessionId, {
      status: 'approved',
      syncStatus,
    });
  });
}

async function applyEntityLocally(
  type: 'entity_upsert' | 'entity_delete',
  payload: any,
  syncStatus: 'synced' | 'pending',
  serverResult?: any
) {
  const tableName = payload?.table as keyof typeof db;
  const table = (db as any)[tableName];
  if (!table) return;

  if (type === 'entity_delete') {
    await table.delete(payload.id);
    return;
  }

  if (payload?.record) {
    const finalRecord = serverResult && typeof serverResult === 'object' ? { ...payload.record, ...serverResult } : payload.record;
    if (
      payload.record.id !== undefined &&
      finalRecord.id !== undefined &&
      payload.record.id !== finalRecord.id
    ) {
      await table.delete(payload.record.id).catch(() => {});
    }
    await table.put({ ...finalRecord, syncStatus });
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

export async function dispatchOperation(
  type: SyncOperation['type'],
  rawPayload: any,
  branchId?: number
): Promise<{ synced: boolean; operationId: string; result?: any }> {
  const payload = enrichPayloadWithStableIds(type, rawPayload);
  const operationId = payload?.operationId || generateUUID();
  const deviceId = getDeviceId();
  const role = await getDeviceRole();
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

  if (role === 'server' && token) {
    try {
      const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
      const localPayload = mergeServerResultIntoPayload(type, opRecord.payload, response.result);
      await applyOperationLocally(type, localPayload, 'synced', response.result);
      import('./syncService').then(({ syncService }) => syncService.pullAll().catch(() => {}));
      return { synced: true, operationId, result: response.result };
    } catch (err: any) {
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

  await db.syncOperations.put(opRecord);
  await applyOperationLocally(type, opRecord.payload, 'pending');

  if (token) {
    const reachable = await apiService.checkServerReachability(2000);
    if (reachable) {
      try {
        const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
        const localPayload = mergeServerResultIntoPayload(type, opRecord.payload, response.result);
        await applyOperationLocally(type, localPayload, 'synced', response.result);
        await db.syncOperations.update(operationId, {
          status: 'synced',
          updatedAt: new Date().toISOString(),
        });
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
          await db.syncOperations.update(operationId, {
            status: 'conflict',
            lastError: err.response?.data?.error || err.message,
            updatedAt: new Date().toISOString(),
          });
          throw new Error(err.response?.data?.error || err.message);
        }
      }
    }
  }

  import('./syncService').then(({ syncService }) => syncService.updatePendingCount());
  return { synced: false, operationId };
}
