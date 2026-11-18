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
import { consumeLocalInventoryFIFO, restoreLocalInventoryFIFO } from './localInventoryEngine';
import { enqueueNativePosOperation, acknowledgeNativePosOperation, markNativePosOperationError, markNativePosOperationConflict, isNativeAndroid } from '../native/posLocalDatabase';

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
  const policyRow = await db.settings.where('key').equals('offlineStockPolicy').first();
  const legacyPolicy = await db.settings.where('key').equals('allowNegativeStock').first();
  const stockPolicy = policyRow?.value || (legacyPolicy?.value === 'false' || legacyPolicy?.value === false ? 'block' : 'allow_with_alert');
  const allowNegative = stockPolicy !== 'block' || Boolean(payload.managerOverride || payload.allowNegativeOverride);

  await db.transaction(
    'rw',
    [
      db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions,
      db.inventoryBatches, db.serviceRecipes, db.inventoryMovements, db.inventoryAlerts,
    ],
    async () => {
      await db.orders.put({ ...order, syncStatus });
      await db.orderItems.where('orderId').equals(order.id).delete();

      const savedServerItems = Array.isArray(_serverItems) ? _serverItems : [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const product = await db.products.get(Number(item.productId));
        if (!product) throw new Error(`الصنف غير موجود (ID: ${item.productId})`);

        const factor = resolveLocalUnitFactor(product, item);
        const quantity = roundQty(Number(item.quantity || 0));
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
          });
          costTotal = consumed.totalCost;
          batchAllocations = consumed.allocations;
        }

        const serverItem = savedServerItems[index];
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
    [db.orders, db.orderItems, db.products, db.customers, db.loyaltyTransactions, db.serviceRecipes],
    async () => {
      const origOrder = await db.orders.get(targetOrderId);
      if (!origOrder || origOrder.status === 'void') return;

      const origItems = await db.orderItems.where('orderId').equals(targetOrderId).toArray();
      for (const oi of origItems) {
        const itemType = String(oi.itemType || 'stock');
        if (itemType === 'service') continue;
        const factor = Number(oi.conversionFactor || 1);
        const baseQty = roundQty(Number(oi.quantity || 0) * factor);
        const product = await db.products.get(oi.productId);
        if (product) {
          if (itemType === 'service_with_materials' || itemType === 'bundle') {
            const recipes = await db.serviceRecipes
              .where('parentProductId')
              .equals(Number(product.id))
              .toArray();
            if (recipes.length > 0) {
              for (const rec of recipes) {
                const ingQty = roundQty(baseQty * Number(rec.quantity || 0));
                const ingProd = await db.products.get(Number(rec.ingredientProductId));
                if (ingProd && ingQty > 0) {
                  await db.products.update(ingProd.id!, {
                    stockQuantity: roundQty(ingProd.stockQuantity + ingQty),
                    updatedAt: now,
                    syncStatus,
                  });
                }
              }
              continue;
            }
            if (itemType === 'service_with_materials') continue;
          }

          await db.products.update(product.id!, {
            stockQuantity: roundQty(product.stockQuantity + baseQty),
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
    [db.returns, db.returnItems, db.orders, db.orderItems, db.products, db.customers, db.serviceRecipes],
    async () => {
      const origOrder = await db.orders.get(originalOrderId);
      const origItems = await db.orderItems.where('orderId').equals(originalOrderId).toArray();

      let totalRefund = 0;
      let totalTax = 0;
      let totalSub = 0;
      let totalCostReversed = 0;
      const operationId = String(payload.operationId || id);
      const deviceId = String(payload.deviceId || 'local-device');

      for (const reqItem of items) {
        const origItem = reqItem.orderItemId
          ? origItems.find((oi) => oi.id === reqItem.orderItemId)
          : origItems.find(
              (oi) =>
                oi.productId === reqItem.productId &&
                Number(oi.quantity || 0) - Number(oi.returnedQuantity || 0) > 0
            ) || origItems.find((oi) => oi.productId === reqItem.productId);
        if (!origItem) continue;

        const qty = roundQty(Number(reqItem.quantity));
        if (qty <= 0) continue;

        const ratio = qty / Number(origItem.quantity);
        const lineSub = roundMoney(Number(origItem.subTotal) * ratio);
        const lineTax = roundMoney(Number(origItem.taxAmount) * ratio);
        const lineTotal = roundMoney(Number(origItem.total) * ratio);
        let lineCost = 0;
        const condition: 'resalable' | 'damaged' =
          reqItem.condition === 'damaged' ? 'damaged' : 'resalable';

        totalSub += lineSub;
        totalTax += lineTax;
        totalRefund += lineTotal;

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
                movementKeySuffix: `recipe-${recipeIndex}-${ingredient.ingredientProductId}`,
                branchId: branchId ?? origOrder?.branchId,
                reason: reason || 'مرتجع مبيعات',
                createdBy,
                createdAt: now,
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
              movementKeySuffix: String(index),
              branchId: branchId ?? origOrder?.branchId,
              reason: reason || 'مرتجع مبيعات',
              createdBy,
              createdAt: now,
            });
          }
        } else if (condition === 'damaged') {
          lineCost = roundMoney(Number(origItem.costPriceAtTimeOfSale || 0) * qty);
        }
        totalCostReversed = roundMoney(totalCostReversed + lineCost);

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

  await db.transaction(
    'rw',
    [db.purchases, db.purchaseItems, db.products, db.suppliers, db.inventoryBatches],
    async () => {
      if (type === 'purchase_delete' || type === 'purchase_update') {
        const pid = type === 'purchase_delete' ? payload.id : payload.purchase.id;
        const oldPurchase = await db.purchases.get(pid);
        const oldItems = await db.purchaseItems.where('purchaseId').equals(pid).toArray();
        for (const item of oldItems) {
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
        }
        await db.purchaseItems.where('purchaseId').equals(pid).delete();
        await db.inventoryBatches.where('purchaseId').equals(pid).delete();
        if (oldPurchase && oldPurchase.supplierId) {
          const oldExtra =
            Number(oldPurchase.shippingCost || 0) +
            Number(oldPurchase.customsCost || 0) +
            Number(oldPurchase.otherCosts || 0);
          const oldRemaining = oldPurchase.totalAmount - oldPurchase.paidAmount;
          const sup = await db.suppliers.get(oldPurchase.supplierId);
          if (sup && oldRemaining > 0) {
            await db.suppliers.update(sup.id!, {
              balance: roundMoney(sup.balance - oldRemaining),
              updatedAt: now,
              syncStatus,
            });
          }
          void oldExtra;
        }
        if (type === 'purchase_delete') {
          await db.purchases.delete(pid);
          return;
        }
      }

      const { purchase, items = [], _serverItems } = payload;
      await db.purchases.put({ ...purchase, returnedAmount: purchase.returnedAmount || 0, syncStatus });
      await db.purchaseItems.where('purchaseId').equals(purchase.id).delete();

      if (Array.isArray(_serverItems) && _serverItems.length > 0) {
        await db.purchaseItems.bulkPut(_serverItems.map((si: any) => ({ ...si, syncStatus })));
      }

      const fxRate = Number(purchase.exchangeRate || 1) > 0 ? Number(purchase.exchangeRate || 1) : 1;
      const extraCost =
        Number(purchase.shippingCost || 0) +
        Number(purchase.customsCost || 0) +
        Number(purchase.otherCosts || 0);
      const goodsTotal = items.reduce((s: number, it: any) => {
        const c = it.pricesInForeignCurrency ? Number(it.costPrice || 0) * fxRate : Number(it.costPrice || 0);
        return s + Number(it.quantity || 0) * c;
      }, 0);

      for (const item of items) {
        const qty = roundQty(Number(item.quantity || 0));
        const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor || 1) : 1;
        const baseQty = roundQty(qty * factor);
        const unitPurchaseCost = item.pricesInForeignCurrency
          ? Number(item.costPrice || 0) * fxRate
          : Number(item.costPrice || 0);
        const lineTotal = roundMoney(qty * unitPurchaseCost);
        const share = goodsTotal > 0 ? (lineTotal / goodsTotal) * extraCost : 0;
        const landedCostPerBaseUnit =
          item.landedCostPerBaseUnit !== undefined
            ? Number(item.landedCostPerBaseUnit)
            : baseQty > 0
            ? Math.round(((lineTotal + share) / baseQty) * 10000) / 10000
            : unitPurchaseCost;

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
          await db.products.update(prod.id!, {
            stockQuantity: roundQty(prod.stockQuantity + baseQty),
            costPrice: landedCostPerBaseUnit,
            expiryDate: item.expiryDate || prod.expiryDate,
            batchNumber: item.batchNumber || prod.batchNumber,
            updatedAt: now,
            syncStatus,
          });
        }
      }

      const invoicePayable =
        purchase.extraCostsPaymentMethod === 'supplier'
          ? roundMoney(Number(purchase.totalAmount || 0) + extraCost)
          : Number(purchase.totalAmount || 0);
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
        const cost = Number(reqItem.costPrice || 0);
        const lineTotal = roundMoney(qty * cost);
        totalReturn = roundMoney(totalReturn + lineTotal);

        const batch = reqItem.batchId
          ? batches.find((b) => b.id === reqItem.batchId)
          : batches.find((b) => b.productId === reqItem.productId && (b.remainingQuantity ?? b.quantity) >= qty) ||
            batches.find((b) => b.productId === reqItem.productId);

        if (batch && batch.id) {
          const curRem = Number(batch.remainingQuantity ?? batch.quantity);
          await db.inventoryBatches.update(batch.id, {
            remainingQuantity: Math.max(0, curRem - qty),
            updatedAt: now,
            syncStatus,
          });
        }

        const prod = await db.products.get(Number(reqItem.productId));
        if (prod) {
          await db.products.update(prod.id!, {
            stockQuantity: Math.max(0, prod.stockQuantity - qty),
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

  // Enforce local stock policy before queueing offline sale when offlineStockPolicy is 'block'
  if (type === 'sale' && !payload?.allowNegativeOverride && !payload?.managerOverride) {
    try {
      const policyRow = await db.settings.where('key').equals('offlineStockPolicy').first();
      const allowNegRow = await db.settings.where('key').equals('allowNegativeStock').first();
      const policy = policyRow?.value || (allowNegRow?.value === 'false' || allowNegRow?.value === false ? 'block' : 'allow_with_alert');
      if (policy === 'block') {
        for (const item of payload?.items || []) {
          const prod = await db.products.get(Number(item.productId));
          if (!prod) continue;
          const itemType = String(item.itemType || prod.itemType || 'stock');
          if (itemType === 'service') continue;
          const factor = resolveLocalUnitFactor(prod, item);
          const baseQty = roundQty(Number(item.quantity || 0) * factor);
          if (itemType === 'service_with_materials' || itemType === 'bundle') {
            const recipes = await db.serviceRecipes.where('parentProductId').equals(Number(prod.id)).toArray();
            if (recipes.length > 0) {
              for (const rec of recipes) {
                const ing = await db.products.get(Number(rec.ingredientProductId));
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
  await applyOperationLocally(type, opRecord.payload, 'pending');

  // Android keeps a second, durable copy of every business operation in native
  // SQLite so the outbox survives WebView/IndexedDB lifecycle failures.
  if (isNativeAndroid()) {
    try {
      await enqueueNativePosOperation({
        operationId,
        type,
        payload: opRecord.payload,
        deviceId,
        branchId: branchId === undefined ? undefined : String(branchId),
        schemaVersion: 1,
      });
    } catch (error) {
      // Keep the existing Dexie queue as a recovery path if native storage fails.
      console.error('Android SQLite outbox write failed; retaining Dexie queue:', error);
    }
  }

  if (token) {
    const reachable = await apiService.checkServerReachability(2000);
    if (reachable) {
      try {
        const response = await apiService.executeOperation(type, opRecord.payload, operationId, deviceId);
        // The operation was already applied to the local Dexie database before
        // it was sent. Reapplying the business mutation here would deduct stock,
        // restore returns, or change balances a second time. Mark it acknowledged
        // and let pullAll reconcile the authoritative server records.
        await db.syncOperations.update(operationId, {
          status: 'synced',
          lastError: undefined,
          updatedAt: new Date().toISOString(),
        });
        if (isNativeAndroid()) {
          await acknowledgeNativePosOperation(operationId).catch((error) =>
            console.error('Could not acknowledge Android SQLite outbox item:', error)
          );
        }
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
