import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import {
  products,
  categories,
  customers,
  suppliers,
  orders,
  orderItems,
  returns,
  returnItems,
  shifts,
  shiftMovements,
  expenses,
  employees,
  settings,
  attendance,
  loyaltyTransactions,
  branches,
  payrolls,
  offers,
  purchases,
  purchaseItems,
  purchaseReturns,
  purchaseReturnItems,
  customerPayments,
  supplierPayments,
  auditLogs,
  stocktakingSessions,
  stocktakingEntries,
  inventoryBatches,
  inventoryAlerts,
  processedOperations,
  serviceRecipes,
  exchangeRateHistory,
  fiscalPeriods,
} from '../drizzle/schema.js';
import {
  postJournalEntry,
  reverseJournalEntriesByReference,
  consumeInventoryFIFO,
  restoreInventoryFIFO,
  recalculateProductWeightedCost,
  recordInventoryMovement,
  BatchAllocation,
} from './accounting.js';
import { hashSecret, sanitizeEmployee } from './auth.js';

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function roundQty(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function getSettingValue(tx: any, key: string, fallback = ''): string {
  const row = tx.select().from(settings).where(eq(settings.key, key)).get();
  return row && row.value !== undefined && row.value !== null ? String(row.value) : fallback;
}

function getStockPolicy(tx: any, payload: any, userRole?: string): { allowNegative: boolean; policy: string } {
  const policy = getSettingValue(tx, 'offlineStockPolicy', '');
  const legacyAllow = getSettingValue(tx, 'allowNegativeStock', 'true');
  const effectivePolicy = policy || (legacyAllow === 'false' ? 'block' : 'allow_with_alert');
  const isPrivilegedOverride =
    (Boolean(payload?.managerOverride) || Boolean(payload?.allowNegativeOverride)) &&
    (userRole === 'admin' || userRole === 'manager');

  if (effectivePolicy === 'block' && !isPrivilegedOverride) {
    return { allowNegative: false, policy: effectivePolicy };
  }
  if (effectivePolicy === 'manager_override' && !isPrivilegedOverride) {
    return { allowNegative: false, policy: effectivePolicy };
  }
  return { allowNegative: true, policy: effectivePolicy };
}

function getValuationMethod(tx: any): 'fifo' | 'weighted_average' {
  const val = getSettingValue(tx, 'inventoryValuationMethod', 'fifo');
  return val === 'weighted_average' ? 'weighted_average' : 'fifo';
}

function assertOpenFiscalPeriod(
  tx: any,
  dateIso: string,
  payload?: any,
  userRole?: string
) {
  const allPeriods = tx.select().from(fiscalPeriods).all();
  if (!allPeriods || allPeriods.length === 0) return;

  const targetDay = String(dateIso || new Date().toISOString()).slice(0, 10);
  const closedMatch = allPeriods.find((p: any) => {
    if (p.status !== 'closed') return false;
    const start = String(p.startDate || '').slice(0, 10);
    const end = String(p.endDate || '').slice(0, 10);
    return start && end && targetDay >= start && targetDay <= end;
  });

  if (closedMatch) {
    const isAdminOverride =
      Boolean(payload?.allowClosedPeriodOverride) &&
      (userRole === 'admin' || userRole === 'manager');
    if (!isAdminOverride) {
      throw new OperationError(
        `الفترة المالية (${closedMatch.name}) مغلقة ولا يمكن ترحيل عمليات بتاريخ ${targetDay}`,
        403
      );
    }
  }
}

export class OperationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface OperationMeta {
  operationId?: string;
  deviceId?: string;
  userName?: string;
  userRole?: string;
  branchId?: number;
}

export function executeBusinessOperation(
  dbInstance: any,
  type: string,
  payload: any,
  meta: OperationMeta = {}
) {
  const operationId = meta.operationId || payload?.operationId || crypto.randomUUID();
  const deviceId = meta.deviceId || payload?.deviceId || 'server';
  const actor = meta.userName || payload?.createdBy || 'System';
  const userRole = meta.userRole;
  const now = new Date().toISOString();

  return dbInstance.transaction((tx: any) => {
    // Idempotency guard
    const existingOp = tx
      .select()
      .from(processedOperations)
      .where(eq(processedOperations.operationId, operationId))
      .get();

    if (existingOp) {
      let cachedResult = null;
      try {
        cachedResult = existingOp.resultJson ? JSON.parse(existingOp.resultJson) : null;
      } catch {}
      return { duplicate: true, operationId, result: cachedResult };
    }

    let result: any = null;

    switch (type) {
      case 'sale': {
        result = handleSale(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'return': {
        result = handleReturn(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'order_void': {
        result = handleOrderVoid(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'purchase': {
        result = handlePurchaseCreate(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'purchase_update': {
        result = handlePurchaseUpdate(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'purchase_delete': {
        result = handlePurchaseDelete(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'purchase_return': {
        result = handlePurchaseReturn(tx, payload, { operationId, deviceId, actor, userRole, now });
        break;
      }
      case 'expense': {
        assertOpenFiscalPeriod(tx, payload?.date || now, payload, userRole);
        result = handleExpenseCreate(tx, payload, { actor, now });
        break;
      }
      case 'expense_delete': {
        const expId = Number(payload.id);
        const existing = tx.select().from(expenses).where(eq(expenses.id, expId)).get();
        if (existing) {
          assertOpenFiscalPeriod(tx, existing.date || now, payload, userRole);
          tx.delete(expenses).where(eq(expenses.id, expId)).run();
          reverseJournalEntriesByReference(tx, String(expId), 'حذف مصروف', actor);
          tx.insert(auditLogs)
            .values({
              id: crypto.randomUUID(),
              date: now,
              type: 'expense_delete',
              userName: actor,
              action: 'حذف',
              operationName: 'حذف مصروف',
              details: existing.description,
              quantity: 1,
              value: Number(existing.amount || 0),
              branchId: existing.branchId || null,
              entityId: String(expId),
              entityName: existing.category,
            })
            .run();
        }
        result = { deleted: expId };
        break;
      }
      case 'customer_payment': {
        assertOpenFiscalPeriod(tx, now, payload, userRole);
        result = handleCustomerPayment(tx, payload, { operationId, actor, now });
        break;
      }
      case 'supplier_payment': {
        assertOpenFiscalPeriod(tx, now, payload, userRole);
        result = handleSupplierPayment(tx, payload, { operationId, actor, now });
        break;
      }
      case 'payroll': {
        assertOpenFiscalPeriod(tx, payload?.paymentDate || now, payload, userRole);
        result = handlePayrollCreate(tx, payload, { actor, now });
        break;
      }
      case 'shift_open': {
        const shiftData = payload;
        tx.insert(shifts)
          .values({
            ...shiftData,
            startTime: shiftData.startTime || now,
            status: 'open',
            isSynced: 0,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        result = tx.select().from(shifts).where(eq(shifts.id, shiftData.id)).get();
        break;
      }
      case 'shift_close': {
        const { id, actualCash, expectedCash, endTime } = payload;
        tx.update(shifts)
          .set({
            actualCash: Number(actualCash),
            expectedCash: Number(expectedCash),
            endTime: endTime || now,
            status: 'closed',
            updatedAt: now,
            isSynced: 0,
          })
          .where(eq(shifts.id, id))
          .run();
        result = tx.select().from(shifts).where(eq(shifts.id, id)).get();
        break;
      }
      case 'shift_movement': {
        assertOpenFiscalPeriod(tx, now, payload, userRole);
        result = handleShiftMovement(tx, payload, { operationId, actor, now });
        break;
      }
      case 'stocktake_approve': {
        assertOpenFiscalPeriod(tx, now, payload, userRole);
        result = handleStocktakeApprove(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'entity_upsert': {
        result = handleEntityUpsert(tx, payload, now);
        break;
      }
      case 'entity_delete': {
        result = handleEntityDelete(tx, payload);
        break;
      }
      default:
        throw new OperationError(`Unsupported operation type: ${type}`, 400);
    }

    tx.insert(processedOperations)
      .values({
        operationId,
        deviceId,
        operationType: type,
        status: 'completed',
        resultJson: JSON.stringify(result),
        createdAt: now,
      })
      .run();

    return { duplicate: false, operationId, result };
  });
}

function resolveProductUnitFactor(product: any, item: any): number {
  if (Number(item.conversionFactor) > 0 && item.unit && item.unit !== 'piece') {
    return Number(item.conversionFactor);
  }
  const unitName = String(item.unit || item.selectedUnit || 'piece');
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
    return Number(item.conversionFactor || product?.conversionFactor || 1);
  }
  return Number(item.conversionFactor || 1) || 1;
}

function handleSale(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  const { order, items = [], pointsEarned = 0, pointsRedeemed = 0 } = payload;
  if (!order || !order.id) {
    throw new OperationError('Invalid sale payload: missing order.id', 400);
  }

  const existingOrder = tx.select().from(orders).where(eq(orders.id, order.id)).get();
  if (existingOrder) {
    return { order: existingOrder, alreadyExists: true };
  }

  const createdAt = order.createdAt ? new Date(order.createdAt).toISOString() : ctx.now;
  assertOpenFiscalPeriod(tx, createdAt, payload, ctx.userRole);

  const { allowNegative } = getStockPolicy(tx, payload, ctx.userRole);
  const valuationMethod = getValuationMethod(tx);

  let totalCogs = 0;
  const savedItems: any[] = [];

  for (const item of items) {
    const qty = roundQty(Number(item.quantity || 0));
    if (qty <= 0) continue;

    const prod = tx.select().from(products).where(eq(products.id, Number(item.productId))).get();
    if (!prod) {
      throw new OperationError(`الصنف غير موجود (ID: ${item.productId})`, 404);
    }

    const factor = resolveProductUnitFactor(prod, item);
    const baseQty = roundQty(qty * factor);
    const itemType = String(item.itemType || prod.itemType || 'stock');

    let unitCostForSale = 0;
    let batchAllocJson = JSON.stringify([]);

    if (itemType === 'service') {
      unitCostForSale = 0;
      batchAllocJson = JSON.stringify({ kind: 'service' });
    } else if (itemType === 'service_with_materials' || itemType === 'bundle') {
      const recipes = tx
        .select()
        .from(serviceRecipes)
        .where(eq(serviceRecipes.parentProductId, Number(prod.id)))
        .all();

      if (recipes.length > 0) {
        let recipeTotalCost = 0;
        const ingredientAllocations: Array<{
          ingredientProductId: number;
          ingredientName?: string;
          quantityConsumed: number;
          allocations: BatchAllocation[];
        }> = [];

        for (const rec of recipes) {
          const ingQty = roundQty(baseQty * Number(rec.quantity || 0));
          if (ingQty <= 0) continue;
          const ingFifo = consumeInventoryFIFO(tx, {
            productId: Number(rec.ingredientProductId),
            quantityInBaseUnits: ingQty,
            operationId: ctx.operationId,
            deviceId: ctx.deviceId,
            productName: rec.ingredientName || item.productName,
            allowNegative,
            valuationMethod,
            movementType: 'service_consumption',
            sourceType: 'order',
            sourceId: order.id,
            movementKeySuffix: `rec-${savedItems.length}-${rec.id || rec.ingredientProductId}`,
            branchId: order.branchId || null,
            createdBy: ctx.actor,
            createdAt,
          });
          recipeTotalCost += ingFifo.totalCost;
          ingredientAllocations.push({
            ingredientProductId: Number(rec.ingredientProductId),
            ingredientName: rec.ingredientName,
            quantityConsumed: ingQty,
            allocations: ingFifo.allocations,
          });
        }

        unitCostForSale = roundQty(qty > 0 ? recipeTotalCost / qty : 0);
        totalCogs = roundMoney(totalCogs + recipeTotalCost);
        batchAllocJson = JSON.stringify({
          kind: 'recipe',
          ingredients: ingredientAllocations,
        });
      } else if (itemType === 'bundle') {
        const fifo = consumeInventoryFIFO(tx, {
          productId: Number(prod.id),
          quantityInBaseUnits: baseQty,
          operationId: ctx.operationId,
          deviceId: ctx.deviceId,
          productName: item.productName || prod.name,
          allowNegative,
          valuationMethod,
          movementType: 'sale',
          sourceType: 'order',
          sourceId: order.id,
          movementKeySuffix: String(savedItems.length),
          branchId: order.branchId || null,
          createdBy: ctx.actor,
          createdAt,
        });
        unitCostForSale = roundQty(fifo.averageUnitCost * factor);
        totalCogs = roundMoney(totalCogs + fifo.totalCost);
        batchAllocJson = JSON.stringify(fifo.allocations);
      } else {
        unitCostForSale = 0;
        batchAllocJson = JSON.stringify({ kind: 'service' });
      }
    } else {
      const fifo = consumeInventoryFIFO(tx, {
        productId: Number(prod.id),
        quantityInBaseUnits: baseQty,
        operationId: ctx.operationId,
        deviceId: ctx.deviceId,
        productName: item.productName || prod.name,
        allowNegative,
        valuationMethod,
        movementType: 'sale',
        sourceType: 'order',
        sourceId: order.id,
        movementKeySuffix: String(savedItems.length),
        branchId: order.branchId || null,
        createdBy: ctx.actor,
        createdAt,
      });
      unitCostForSale = roundQty(fifo.averageUnitCost * factor);
      totalCogs = roundMoney(totalCogs + fifo.totalCost);
      batchAllocJson = JSON.stringify(fifo.allocations);
    }

    const insertedItem = tx
      .insert(orderItems)
      .values({
        orderId: order.id,
        productId: Number(prod.id),
        productName: item.productName || prod.name,
        quantity: qty,
        returnedQuantity: 0,
        unit: item.unit || item.selectedUnit || prod.unit || 'piece',
        conversionFactor: factor,
        itemType,
        unitPrice: Number(item.unitPrice || 0),
        costPriceAtTimeOfSale: unitCostForSale,
        discountAmount: Number(item.discountAmount || 0),
        subTotal: Number(item.subTotal || 0),
        taxAmount: Number(item.taxAmount || 0),
        total: Number(item.total || 0),
        batchAllocations: batchAllocJson,
        isSynced: 0,
        createdAt,
      })
      .returning()
      .get();

    savedItems.push(insertedItem);
  }

  const netAmount = roundMoney(Number(order.netAmount || 0));
  const totalAmount = roundMoney(Number(order.totalAmount || 0));
  const taxAmount = roundMoney(Number(order.taxAmount || 0));
  const discountAmount = roundMoney(Math.max(0, totalAmount + taxAmount - netAmount));
  const paymentMethod = String(order.paymentMethod || 'cash');

  let cashAmount = 0;
  let cardAmount = 0;
  let paidAmount = netAmount;

  if (paymentMethod === 'mixed') {
    cashAmount = roundMoney(Number(order.cashAmount || 0));
    cardAmount = roundMoney(Number(order.cardAmount || 0));
    if (cashAmount < 0 || cardAmount < 0 || Math.abs(roundMoney(cashAmount + cardAmount) - netAmount) > 0.02) {
      throw new OperationError('قيمة الدفع المختلط (نقد + شبكة) يجب أن تساوي صافي الفاتورة', 400);
    }
  } else if (paymentMethod === 'cash') {
    cashAmount = netAmount;
  } else if (paymentMethod === 'card') {
    cardAmount = netAmount;
  } else if (paymentMethod === 'credit') {
    paidAmount = 0;
  }

  const savedOrder = tx
    .insert(orders)
    .values({
      id: order.id,
      receiptNumber: order.receiptNumber || `INV-${Date.now()}`,
      totalAmount,
      discountAmount,
      taxAmount,
      netAmount,
      paidAmount,
      cashAmount,
      cardAmount,
      returnedAmount: 0,
      paymentMethod,
      currency: order.currency || getSettingValue(tx, 'currency', 'ر.س'),
      exchangeRate: Number(order.exchangeRate || 1),
      customerId: order.customerId || null,
      customerName: order.customerName || null,
      branchId: order.branchId || null,
      shiftId: order.shiftId || null,
      tableNumber: order.tableNumber || null,
      orderType: order.orderType || null,
      status: order.status || 'completed',
      createdBy: order.createdBy || ctx.actor,
      deviceId: ctx.deviceId,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt,
      updatedAt: ctx.now,
    })
    .returning()
    .get();

  // Customer balance & loyalty points
  if (order.customerId) {
    const balanceDelta = paymentMethod === 'credit' ? netAmount : 0;
    const pointsDelta = Number(pointsEarned || 0) - Number(pointsRedeemed || 0);

    tx.update(customers)
      .set({
        balance: sql`${customers.balance} + ${balanceDelta}`,
        points: sql`${customers.points} + ${pointsDelta}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(customers.id, Number(order.customerId)))
      .run();

    if (pointsEarned > 0) {
      tx.insert(loyaltyTransactions)
        .values({
          id: crypto.randomUUID(),
          customerId: Number(order.customerId),
          orderId: order.id,
          points: Number(pointsEarned),
          type: 'earn',
          date: createdAt,
          isSynced: 0,
          createdAt,
        })
        .run();
    }
    if (pointsRedeemed > 0) {
      tx.insert(loyaltyTransactions)
        .values({
          id: crypto.randomUUID(),
          customerId: Number(order.customerId),
          orderId: order.id,
          points: Number(pointsRedeemed),
          type: 'redeem',
          date: createdAt,
          isSynced: 0,
          createdAt,
        })
        .run();
    }
  }

  // Double-entry Journal 1: Revenue, Discounts, VAT & Payments
  const debitLines: Array<{ accountCode: string; debit: number; credit: number; orderId: string }> = [];
  if (paymentMethod === 'mixed') {
    if (cashAmount > 0) debitLines.push({ accountCode: '1010', debit: cashAmount, credit: 0, orderId: order.id });
    if (cardAmount > 0) debitLines.push({ accountCode: '1020', debit: cardAmount, credit: 0, orderId: order.id });
  } else {
    const debitAccountCode =
      paymentMethod === 'cash' ? '1010' : paymentMethod === 'card' ? '1020' : '1100';
    debitLines.push({ accountCode: debitAccountCode, debit: netAmount, credit: 0, orderId: order.id });
  }

  const saleLines = [
    ...debitLines,
    ...(discountAmount > 0
      ? [{ accountCode: '4300', debit: discountAmount, credit: 0, orderId: order.id }]
      : []),
    { accountCode: '4100', debit: 0, credit: totalAmount, orderId: order.id },
    ...(taxAmount > 0
      ? [{ accountCode: '2200', debit: 0, credit: taxAmount, orderId: order.id }]
      : []),
  ];

  postJournalEntry(tx, {
    date: createdAt,
    referenceId: order.id,
    referenceType: 'order',
    description: `فاتورة مبيعات رقم ${savedOrder.receiptNumber}`,
    lines: saleLines,
    createdBy: ctx.actor,
    branchId: order.branchId,
  });

  // Double-entry Journal 2: COGS & Inventory
  if (totalCogs > 0) {
    postJournalEntry(tx, {
      date: createdAt,
      referenceId: order.id,
      referenceType: 'order',
      description: `تكلفة مبيعات فاتورة رقم ${savedOrder.receiptNumber}`,
      lines: [
        { accountCode: '5100', debit: totalCogs, credit: 0, orderId: order.id },
        { accountCode: '1200', debit: 0, credit: totalCogs, orderId: order.id },
      ],
      createdBy: ctx.actor,
      branchId: order.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: createdAt,
      type: 'sale',
      userName: ctx.actor,
      action: 'بيع',
      operationName: 'فاتورة مبيعات',
      details: `فاتورة رقم ${savedOrder.receiptNumber} (${paymentMethod})`,
      quantity: roundQty(savedItems.reduce((s, i) => s + Number(i.quantity), 0)),
      value: netAmount,
      branchId: order.branchId || null,
      entityId: order.id,
      entityName: savedOrder.receiptNumber,
    })
    .run();

  return { order: savedOrder, items: savedItems };
}

function handleReturn(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  const {
    id,
    returnNumber,
    originalOrderId,
    items = [],
    refundMethod,
    reason,
    shiftId,
    branchId,
    returnDate,
  } = payload;

  if (!originalOrderId || !Array.isArray(items) || items.length === 0) {
    throw new OperationError('Invalid return payload: missing originalOrderId or items', 400);
  }

  const effectiveReturnDate = returnDate ? new Date(returnDate).toISOString() : ctx.now;
  // Cross-period return protection: validates return posting date (current period),
  // never touches closed-period original sales journal entries.
  assertOpenFiscalPeriod(tx, effectiveReturnDate, payload, ctx.userRole);

  const origOrder = tx.select().from(orders).where(eq(orders.id, originalOrderId)).get();
  if (!origOrder) {
    throw new OperationError('Original order not found', 404);
  }
  if (origOrder.status === 'void') {
    throw new OperationError('لا يمكن إرجاع أصناف من فاتورة ملغاة', 400);
  }

  const origItems = tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, originalOrderId))
    .all();

  const returnId = id || crypto.randomUUID();
  const retNum = returnNumber || `RET-${Date.now()}`;
  const effectiveRefundMethod =
    refundMethod ||
    (origOrder.paymentMethod === 'credit'
      ? 'credit_adjustment'
      : origOrder.paymentMethod === 'card'
      ? 'card'
      : 'cash');

  let totalSub = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let totalRefund = 0;
  let totalResalableCostReversed = 0;
  let totalDamagedCostReversed = 0;
  const savedReturnItems: any[] = [];

  for (const reqItem of items) {
    const qtyToReturn = roundQty(Number(reqItem.quantity || 0));
    if (qtyToReturn <= 0) continue;

    // Strict orderItemId matching when provided (prevents duplicate-product line mixups)
    let origItem: any = null;
    if (reqItem.orderItemId !== undefined && reqItem.orderItemId !== null) {
      origItem = origItems.find((oi: any) => oi.id === Number(reqItem.orderItemId));
    } else {
      origItem =
        origItems.find(
          (oi: any) =>
            oi.productId === Number(reqItem.productId) &&
            roundQty(Number(oi.quantity) - Number(oi.returnedQuantity || 0)) >= qtyToReturn - 1e-6
        ) || origItems.find((oi: any) => oi.productId === Number(reqItem.productId));
    }

    if (!origItem) {
      throw new OperationError(
        `Item ${reqItem.productName || reqItem.productId} not found in original order`,
        400
      );
    }

    const alreadyReturned = roundQty(Number(origItem.returnedQuantity || 0));
    const remainingReturnable = roundQty(Number(origItem.quantity) - alreadyReturned);

    if (qtyToReturn > remainingReturnable + 1e-6) {
      throw new OperationError(
        `لا يمكن إرجاع كمية (${qtyToReturn}) أكبر من المتبقي القابل للإرجاع (${remainingReturnable}) للمنتج ${origItem.productName}`,
        400
      );
    }

    const ratio = qtyToReturn / Number(origItem.quantity);
    const lineSub = roundMoney(Number(origItem.subTotal) * ratio);
    const lineTax = roundMoney(Number(origItem.taxAmount) * ratio);
    const lineTotal = roundMoney(Number(origItem.total) * ratio);
    const lineDisc = roundMoney(Math.max(0, lineSub + lineTax - lineTotal));

    const condition: 'resalable' | 'damaged' =
      reqItem.condition === 'damaged' ? 'damaged' : 'resalable';
    const itemType = String(origItem.itemType || 'stock');

    const factor = Number(origItem.conversionFactor || 1);
    const baseQty = roundQty(qtyToReturn * factor);
    let parsedAlloc: any = [];
    try {
      parsedAlloc = origItem.batchAllocations ? JSON.parse(origItem.batchAllocations) : [];
    } catch {}

    const baseCostFallback =
      factor > 0
        ? Number(origItem.costPriceAtTimeOfSale || 0) / factor
        : Number(origItem.costPriceAtTimeOfSale || 0);

    let lineCostReversed = 0;
    let restoredAllocJson = JSON.stringify([]);

    if (itemType === 'service' || (parsedAlloc && parsedAlloc.kind === 'service')) {
      lineCostReversed = 0;
    } else if (condition === 'damaged') {
      // Damaged returns do NOT re-enter sellable stock/batches; cost is written off to 5400
      lineCostReversed = roundMoney(qtyToReturn * Number(origItem.costPriceAtTimeOfSale || 0));
      totalDamagedCostReversed = roundMoney(totalDamagedCostReversed + lineCostReversed);

      const prod = tx.select().from(products).where(eq(products.id, Number(origItem.productId))).get();
      tx.insert(inventoryAlerts)
        .values({
          id: crypto.randomUUID(),
          productId: Number(origItem.productId),
          productName: origItem.productName,
          previousQty: Number(prod?.stockQuantity || 0),
          changeQty: 0,
          resultingQty: Number(prod?.stockQuantity || 0),
          operationId: ctx.operationId,
          deviceId: ctx.deviceId,
          reason: `damaged_return (${qtyToReturn})`,
          resolved: 0,
          createdAt: effectiveReturnDate,
        })
        .run();
    } else if (parsedAlloc && parsedAlloc.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
      const restoredIngredients: any[] = [];
      for (const ing of parsedAlloc.ingredients) {
        const ingRestoreQty = roundQty(Number(ing.quantityConsumed || 0) * ratio);
        if (ingRestoreQty <= 0) continue;
        const ingRestored = restoreInventoryFIFO(tx, {
          productId: Number(ing.ingredientProductId),
          quantityInBaseUnits: ingRestoreQty,
          allocations: Array.isArray(ing.allocations) ? ing.allocations : [],
          fallbackCost: 0,
          branchId: branchId ?? origOrder.branchId,
          operationId: ctx.operationId,
          movementType: 'sale_return',
          sourceType: 'return',
          sourceId: returnId,
          movementKeySuffix: `rec-${savedReturnItems.length}-${ing.ingredientProductId}`,
          reason: reason || 'مرتجع مبيعات',
          createdBy: ctx.actor,
          createdAt: effectiveReturnDate,
        });
        lineCostReversed = roundMoney(lineCostReversed + ingRestored.totalCostRestored);
        restoredIngredients.push({
          ingredientProductId: ing.ingredientProductId,
          restoredAllocations: ingRestored.restoredAllocations,
        });
      }
      totalResalableCostReversed = roundMoney(totalResalableCostReversed + lineCostReversed);
      restoredAllocJson = JSON.stringify({ kind: 'recipe', ingredients: restoredIngredients });
    } else {
      const allocations: BatchAllocation[] = Array.isArray(parsedAlloc) ? parsedAlloc : [];
      const restored = restoreInventoryFIFO(tx, {
        productId: Number(origItem.productId),
        quantityInBaseUnits: baseQty,
        allocations,
        fallbackCost: baseCostFallback,
        branchId: branchId ?? origOrder.branchId,
        operationId: ctx.operationId,
        movementType: 'sale_return',
        sourceType: 'return',
        sourceId: returnId,
        movementKeySuffix: String(savedReturnItems.length),
        reason: reason || 'مرتجع مبيعات',
        createdBy: ctx.actor,
        createdAt: effectiveReturnDate,
      });
      lineCostReversed = restored.totalCostRestored;
      totalResalableCostReversed = roundMoney(totalResalableCostReversed + lineCostReversed);
      restoredAllocJson = JSON.stringify(restored.restoredAllocations);
    }

    totalSub = roundMoney(totalSub + lineSub);
    totalDiscount = roundMoney(totalDiscount + lineDisc);
    totalTax = roundMoney(totalTax + lineTax);
    totalRefund = roundMoney(totalRefund + lineTotal);

    const newReturnedQty = roundQty(alreadyReturned + qtyToReturn);
    origItem.returnedQuantity = newReturnedQty; // keep in-memory copy updated inside loop

    tx.update(orderItems)
      .set({
        returnedQuantity: newReturnedQty,
        isSynced: 0,
      })
      .where(eq(orderItems.id, origItem.id))
      .run();

    const retItem = tx
      .insert(returnItems)
      .values({
        id: crypto.randomUUID(),
        returnId,
        orderItemId: origItem.id,
        productId: Number(origItem.productId),
        productName: origItem.productName,
        quantity: qtyToReturn,
        condition,
        unitPrice: Number(origItem.unitPrice),
        costPrice: Number(origItem.costPriceAtTimeOfSale || 0),
        taxAmount: lineTax,
        total: lineTotal,
        batchAllocations: restoredAllocJson,
        isSynced: 0,
        createdAt: effectiveReturnDate,
      })
      .returning()
      .get();

    savedReturnItems.push(retItem);
  }

  if (savedReturnItems.length === 0) {
    throw new OperationError('No valid return items provided', 400);
  }

  const newReturnedAmount = roundMoney(Number(origOrder.returnedAmount || 0) + totalRefund);
  if (newReturnedAmount > roundMoney(Number(origOrder.netAmount || 0)) + 0.05) {
    throw new OperationError('إجمالي قيمة المرتجع يتجاوز صافي الفاتورة الأصلية', 400);
  }

  const updatedOrigItems = tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, originalOrderId))
    .all();

  const isFullyReturned = updatedOrigItems.every(
    (oi: any) => roundQty(Number(oi.returnedQuantity || 0)) >= roundQty(Number(oi.quantity)) - 1e-6
  );

  tx.update(orders)
    .set({
      status: isFullyReturned ? 'returned' : 'partially_returned',
      returnedAmount: Math.min(newReturnedAmount, roundMoney(Number(origOrder.netAmount || 0))),
      updatedAt: ctx.now,
      isSynced: 0,
    })
    .where(eq(orders.id, originalOrderId))
    .run();

  const totalCostReversed = roundMoney(totalResalableCostReversed + totalDamagedCostReversed);

  const savedReturn = tx
    .insert(returns)
    .values({
      id: returnId,
      returnNumber: retNum,
      originalOrderId,
      originalReceiptNumber: origOrder.receiptNumber,
      customerId: origOrder.customerId || null,
      customerName: origOrder.customerName || null,
      branchId: branchId ?? origOrder.branchId ?? null,
      shiftId: shiftId || origOrder.shiftId || null,
      refundMethod: effectiveRefundMethod,
      currency: origOrder.currency || getSettingValue(tx, 'currency', 'ر.س'),
      exchangeRate: Number(origOrder.exchangeRate || 1),
      subTotal: totalSub,
      discountAmount: totalDiscount,
      taxAmount: totalTax,
      totalRefund,
      totalCostReversed,
      reason: reason || 'مرتجع مبيعات',
      createdBy: ctx.actor,
      deviceId: ctx.deviceId,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt: effectiveReturnDate,
      updatedAt: ctx.now,
    })
    .returning()
    .get();

  if (origOrder.customerId && effectiveRefundMethod === 'credit_adjustment') {
    tx.update(customers)
      .set({
        balance: sql`${customers.balance} - ${totalRefund}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(customers.id, Number(origOrder.customerId)))
      .run();
  }

  const creditAccountCode =
    effectiveRefundMethod === 'cash'
      ? '1010'
      : effectiveRefundMethod === 'card'
      ? '1020'
      : '1100';

  const netExclTax = roundMoney(totalRefund - totalTax);
  postJournalEntry(tx, {
    date: effectiveReturnDate,
    referenceId: returnId,
    referenceType: 'return',
    description: `مرتجع مبيعات ${retNum} للفاتورة ${origOrder.receiptNumber}`,
    lines: [
      { accountCode: '4200', debit: netExclTax, credit: 0, orderId: originalOrderId, returnId },
      ...(totalTax > 0
        ? [{ accountCode: '2200', debit: totalTax, credit: 0, orderId: originalOrderId, returnId }]
        : []),
      { accountCode: creditAccountCode, debit: 0, credit: totalRefund, orderId: originalOrderId, returnId },
    ],
    createdBy: ctx.actor,
    branchId: branchId ?? origOrder.branchId,
  });

  if (totalResalableCostReversed > 0) {
    postJournalEntry(tx, {
      date: effectiveReturnDate,
      referenceId: returnId,
      referenceType: 'return',
      description: `عكس تكلفة مرتجع صالح لإعادة البيع ${retNum}`,
      lines: [
        { accountCode: '1200', debit: totalResalableCostReversed, credit: 0, orderId: originalOrderId, returnId },
        { accountCode: '5100', debit: 0, credit: totalResalableCostReversed, orderId: originalOrderId, returnId },
      ],
      createdBy: ctx.actor,
      branchId: branchId ?? origOrder.branchId,
    });
  }

  if (totalDamagedCostReversed > 0) {
    postJournalEntry(tx, {
      date: effectiveReturnDate,
      referenceId: returnId,
      referenceType: 'return',
      description: `تسوية تكلفة مرتجع تالف ${retNum}`,
      lines: [
        { accountCode: '5400', debit: totalDamagedCostReversed, credit: 0, orderId: originalOrderId, returnId },
        { accountCode: '5100', debit: 0, credit: totalDamagedCostReversed, orderId: originalOrderId, returnId },
      ],
      createdBy: ctx.actor,
      branchId: branchId ?? origOrder.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: effectiveReturnDate,
      type: 'return',
      userName: ctx.actor,
      action: 'مرتجع',
      operationName: 'مرتجع مبيعات',
      details: `مرتجع ${retNum} على الفاتورة ${origOrder.receiptNumber} (${reason || 'بدون سبب'})`,
      quantity: roundQty(savedReturnItems.reduce((s, i) => s + Number(i.quantity), 0)),
      value: totalRefund,
      branchId: branchId ?? origOrder.branchId ?? null,
      entityId: returnId,
      entityName: retNum,
    })
    .run();

  return { returnRecord: savedReturn, items: savedReturnItems };
}

function handleOrderVoid(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  const targetOrderId = String(payload?.orderId || payload?.id || '');
  if (!targetOrderId) {
    throw new OperationError('Missing orderId for void operation', 400);
  }

  const origOrder = tx.select().from(orders).where(eq(orders.id, targetOrderId)).get();
  if (!origOrder) {
    throw new OperationError('Order not found', 404);
  }

  if (origOrder.status === 'void') {
    return { order: origOrder, alreadyVoid: true };
  }

  assertOpenFiscalPeriod(tx, origOrder.createdAt || ctx.now, payload, ctx.userRole);

  if (
    Number(origOrder.returnedAmount || 0) > 0 ||
    origOrder.status === 'returned' ||
    origOrder.status === 'partially_returned'
  ) {
    throw new OperationError('لا يمكن إلغاء فاتورة تم إرجاع أصناف منها مسبقاً', 400);
  }

  const origItems = tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, targetOrderId))
    .all();

  for (const oi of origItems) {
    const itemType = String(oi.itemType || 'stock');
    if (itemType === 'service') continue;

    const factor = Number(oi.conversionFactor || 1);
    const baseQty = roundQty(Number(oi.quantity || 0) * factor);
    if (baseQty <= 0) continue;

    let parsedAlloc: any = [];
    try {
      parsedAlloc = oi.batchAllocations ? JSON.parse(oi.batchAllocations) : [];
    } catch {}

    if (parsedAlloc && parsedAlloc.kind === 'service') continue;

    if (parsedAlloc && parsedAlloc.kind === 'recipe' && Array.isArray(parsedAlloc.ingredients)) {
      for (const ing of parsedAlloc.ingredients) {
        const ingQty = roundQty(Number(ing.quantityConsumed || 0));
        if (ingQty <= 0) continue;
        restoreInventoryFIFO(tx, {
          productId: Number(ing.ingredientProductId),
          quantityInBaseUnits: ingQty,
          allocations: Array.isArray(ing.allocations) ? ing.allocations : [],
          fallbackCost: 0,
          branchId: origOrder.branchId,
          operationId: ctx.operationId,
          movementType: 'sale_void',
          sourceType: 'order_void',
          sourceId: targetOrderId,
          movementKeySuffix: `rec-${oi.id}-${ing.ingredientProductId}`,
          reason: String(payload?.reason || 'إلغاء فاتورة مبيعات'),
          createdBy: ctx.actor,
          createdAt: ctx.now,
        });
      }
      continue;
    }

    const allocations: BatchAllocation[] = Array.isArray(parsedAlloc) ? parsedAlloc : [];
    const baseCostFallback =
      factor > 0 ? Number(oi.costPriceAtTimeOfSale || 0) / factor : Number(oi.costPriceAtTimeOfSale || 0);

    restoreInventoryFIFO(tx, {
      productId: Number(oi.productId),
      quantityInBaseUnits: baseQty,
      allocations,
      fallbackCost: baseCostFallback,
      branchId: origOrder.branchId,
      operationId: ctx.operationId,
      movementType: 'sale_void',
      sourceType: 'order_void',
      sourceId: targetOrderId,
      movementKeySuffix: String(oi.id),
      reason: String(payload?.reason || 'إلغاء فاتورة مبيعات'),
      createdBy: ctx.actor,
      createdAt: ctx.now,
    });
  }

  if (origOrder.customerId) {
    const orderLoyalty = tx
      .select()
      .from(loyaltyTransactions)
      .where(eq(loyaltyTransactions.orderId, targetOrderId))
      .all();

    let pointsRevert = 0;
    for (const lt of orderLoyalty) {
      if (lt.type === 'earn') pointsRevert -= Number(lt.points || 0);
      if (lt.type === 'redeem') pointsRevert += Number(lt.points || 0);
    }

    const balanceRevert = origOrder.paymentMethod === 'credit' ? -Number(origOrder.netAmount || 0) : 0;

    if (balanceRevert !== 0 || pointsRevert !== 0) {
      tx.update(customers)
        .set({
          balance: sql`${customers.balance} + ${balanceRevert}`,
          points: sql`MAX(0, ${customers.points} + ${pointsRevert})`,
          updatedAt: ctx.now,
          isSynced: 0,
        })
        .where(eq(customers.id, Number(origOrder.customerId)))
        .run();
    }
  }

  tx.update(orders)
    .set({
      status: 'void',
      paidAmount: 0,
      updatedAt: ctx.now,
      isSynced: 0,
    })
    .where(eq(orders.id, targetOrderId))
    .run();

  const reason = String(payload?.reason || 'إلغاء فاتورة مبيعات');
  reverseJournalEntriesByReference(tx, targetOrderId, reason, ctx.actor);

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'order_void',
      userName: ctx.actor,
      action: 'إلغاء فاتورة',
      operationName: 'إلغاء فاتورة مبيعات',
      details: `إلغاء فاتورة رقم ${origOrder.receiptNumber} (${reason})`,
      quantity: roundQty(origItems.reduce((s: number, i: any) => s + Number(i.quantity || 0), 0)),
      value: Number(origOrder.netAmount || 0),
      branchId: origOrder.branchId || null,
      entityId: targetOrderId,
      entityName: origOrder.receiptNumber,
    })
    .run();

  const updatedOrder = tx.select().from(orders).where(eq(orders.id, targetOrderId)).get();
  return { order: updatedOrder };
}

function handlePurchaseCreate(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  const { purchase, items = [] } = payload;
  if (!purchase || !purchase.id) {
    throw new OperationError('Invalid purchase payload', 400);
  }

  const purchaseDate = purchase.date ? new Date(purchase.date).toISOString() : ctx.now;
  assertOpenFiscalPeriod(tx, purchaseDate, payload, ctx.userRole);

  const fxRate = Number(purchase.exchangeRate || 1) > 0 ? Number(purchase.exchangeRate || 1) : 1;
  const currency = purchase.currency || getSettingValue(tx, 'currency', 'ر.س');
  const shippingCost = roundMoney(Number(purchase.shippingCost || 0));
  const customsCost = roundMoney(Number(purchase.customsCost || 0));
  const otherCosts = roundMoney(Number(purchase.otherCosts || 0));
  const extraLandedCost = roundMoney(shippingCost + customsCost + otherCosts);
  const extraCostsPaymentMethod = String(purchase.extraCostsPaymentMethod || 'cash');

  const normalizedItems = items
    .map((item: any) => {
      const qty = roundQty(Number(item.quantity || 0));
      const factor = Number(item.conversionFactor || 1) > 0 ? Number(item.conversionFactor || 1) : 1;
      const rawUnitCost = Number(item.costPrice || 0);
      const baseUnitPricePerPurchaseUnit = item.pricesInForeignCurrency
        ? rawUnitCost * fxRate
        : rawUnitCost;
      const lineTotal = roundMoney(qty * baseUnitPricePerPurchaseUnit);
      return {
        ...item,
        qty,
        factor,
        baseUnitPricePerPurchaseUnit,
        lineTotal,
      };
    })
    .filter((i: any) => i.qty > 0);

  const itemsGoodsSum = roundMoney(normalizedItems.reduce((s: number, i: any) => s + i.lineTotal, 0));
  const goodsTotal =
    Number(purchase.totalAmount || 0) > 0 ? roundMoney(Number(purchase.totalAmount)) : itemsGoodsSum;

  const paidAmount = roundMoney(Number(purchase.paidAmount || 0));
  const paymentMethod = purchase.paymentMethod === 'card' ? 'card' : 'cash';
  const invoicePayable =
    extraCostsPaymentMethod === 'supplier' ? roundMoney(goodsTotal + extraLandedCost) : goodsTotal;
  const remaining = roundMoney(invoicePayable - paidAmount);
  const paymentStatus = remaining <= 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';

  const savedPurchase = tx
    .insert(purchases)
    .values({
      id: purchase.id,
      supplierId: purchase.supplierId || null,
      supplierName: purchase.supplierName || null,
      totalAmount: goodsTotal,
      paidAmount,
      returnedAmount: 0,
      paymentStatus,
      paymentMethod,
      currency,
      exchangeRate: fxRate,
      shippingCost,
      customsCost,
      otherCosts,
      date: purchaseDate,
      branchId: purchase.branchId || null,
      deviceId: ctx.deviceId,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning()
    .get();

  // Proportional landed cost allocation with penny reconciliation
  let remainingExtra = extraLandedCost;
  const savedItems: any[] = [];

  for (let idx = 0; idx < normalizedItems.length; idx++) {
    const item = normalizedItems[idx];
    const isLast = idx === normalizedItems.length - 1;
    let allocatedExtra = 0;
    if (extraLandedCost > 0) {
      if (isLast) {
        allocatedExtra = roundMoney(remainingExtra);
      } else if (itemsGoodsSum > 0) {
        allocatedExtra = roundMoney((item.lineTotal / itemsGoodsSum) * extraLandedCost);
        remainingExtra = roundMoney(remainingExtra - allocatedExtra);
      }
    }

    const baseQty = roundQty(item.qty * item.factor);
    const landedTotal = roundMoney(item.lineTotal + allocatedExtra);
    const landedCostPerBaseUnit =
      baseQty > 0 ? Math.round((landedTotal / baseQty) * 10000) / 10000 : 0;

    const pItem = tx
      .insert(purchaseItems)
      .values({
        purchaseId: purchase.id,
        productId: Number(item.productId),
        productName: item.productName,
        quantity: item.qty,
        unit: item.unit || 'piece',
        conversionFactor: item.factor,
        costPrice: item.baseUnitPricePerPurchaseUnit,
        landedCostPerBaseUnit,
        total: item.lineTotal,
        expiryDate: item.expiryDate || null,
        batchNumber: item.batchNumber || null,
        isSynced: 0,
        createdAt: ctx.now,
      })
      .returning()
      .get();
    savedItems.push(pItem);

    tx.insert(inventoryBatches)
      .values({
        id: item.batchId ? String(item.batchId) : crypto.randomUUID(),
        productId: Number(item.productId),
        purchaseId: purchase.id,
        quantity: baseQty,
        remainingQuantity: baseQty,
        costPrice: landedCostPerBaseUnit,
        currency,
        exchangeRate: fxRate,
        purchaseDate,
        expiryDate: item.expiryDate || null,
        batchNumber: item.batchNumber || null,
        branchId: purchase.branchId || null,
        isSynced: 0,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();

    const prodUpdates: any = {
      stockQuantity: sql`${products.stockQuantity} + ${baseQty}`,
      updatedAt: ctx.now,
      isSynced: 0,
    };
    if (item.expiryDate) prodUpdates.expiryDate = item.expiryDate;
    if (item.batchNumber) prodUpdates.batchNumber = item.batchNumber;

    tx.update(products)
      .set(prodUpdates)
      .where(eq(products.id, Number(item.productId)))
      .run();

    recalculateProductWeightedCost(tx, Number(item.productId));

    recordInventoryMovement(tx, {
      movementKey: `purchase:${purchase.id}:${ctx.operationId}:in:${Number(item.productId)}:${idx}`,
      productId: Number(item.productId),
      movementType: 'purchase_receipt',
      sourceType: 'purchase',
      sourceId: purchase.id,
      quantityDeltaBase: baseQty,
      unitCost: landedCostPerBaseUnit,
      totalCost: landedTotal,
      branchId: purchase.branchId || null,
      operationId: ctx.operationId,
      reason: `شراء من ${purchase.supplierName || 'مورد'}`,
      createdBy: ctx.actor,
      createdAt: purchaseDate,
    });
  }

  if (purchase.supplierId && remaining > 0) {
    tx.update(suppliers)
      .set({
        balance: sql`${suppliers.balance} + ${remaining}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(suppliers.id, Number(purchase.supplierId)))
      .run();
  }

  const totalInventoryCapitalized = roundMoney(goodsTotal + extraLandedCost);
  if (totalInventoryCapitalized > 0) {
    const creditLines: Array<{ accountCode: string; debit: number; credit: number; purchaseId: string }> = [];
    if (extraCostsPaymentMethod === 'supplier') {
      creditLines.push({
        accountCode: '2100',
        debit: 0,
        credit: totalInventoryCapitalized,
        purchaseId: purchase.id,
      });
    } else {
      if (goodsTotal > 0) {
        creditLines.push({ accountCode: '2100', debit: 0, credit: goodsTotal, purchaseId: purchase.id });
      }
      if (extraLandedCost > 0) {
        const extraCreditAcc = extraCostsPaymentMethod === 'card' ? '1020' : '1010';
        creditLines.push({
          accountCode: extraCreditAcc,
          debit: 0,
          credit: extraLandedCost,
          purchaseId: purchase.id,
        });
      }
    }

    postJournalEntry(tx, {
      date: purchaseDate,
      referenceId: purchase.id,
      referenceType: 'purchase',
      description: `فاتورة مشتريات من المورد: ${purchase.supplierName || ''}${extraLandedCost > 0 ? ' (شاملة مصاريف الشحن والجمارك)' : ''}`,
      lines: [
        { accountCode: '1200', debit: totalInventoryCapitalized, credit: 0, purchaseId: purchase.id },
        ...creditLines,
      ],
      createdBy: ctx.actor,
      branchId: purchase.branchId,
    });
  }

  if (paidAmount > 0) {
    const creditAcc = paymentMethod === 'card' ? '1020' : '1010';
    postJournalEntry(tx, {
      date: purchaseDate,
      referenceId: purchase.id,
      referenceType: 'payment',
      description: `سداد للمورد عن فاتورة مشتريات: ${purchase.supplierName || ''}`,
      lines: [
        { accountCode: '2100', debit: paidAmount, credit: 0, purchaseId: purchase.id },
        { accountCode: creditAcc, debit: 0, credit: paidAmount, purchaseId: purchase.id },
      ],
      createdBy: ctx.actor,
      branchId: purchase.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'purchase',
      userName: ctx.actor,
      action: 'شراء',
      operationName: 'فاتورة مشتريات',
      details: `فاتورة مشتريات من المورد ${purchase.supplierName || ''}`,
      quantity: roundQty(savedItems.reduce((s, i) => s + Number(i.quantity), 0)),
      value: totalInventoryCapitalized,
      branchId: purchase.branchId || null,
      entityId: purchase.id,
      entityName: purchase.supplierName || purchase.id,
    })
    .run();

  return { purchase: savedPurchase, items: savedItems };
}

function assertPurchaseMutable(tx: any, purchaseId: string) {
  const existingReturns = tx
    .select()
    .from(purchaseReturns)
    .where(eq(purchaseReturns.originalPurchaseId, purchaseId))
    .all();
  if (existingReturns.length > 0) {
    throw new OperationError('لا يمكن تعديل أو حذف فاتورة شراء تم تسجيل مرتجعات عليها', 400);
  }

  const batches = tx
    .select()
    .from(inventoryBatches)
    .where(eq(inventoryBatches.purchaseId, purchaseId))
    .all();

  const hasConsumed = batches.some(
    (b: any) => Number(b.remainingQuantity || 0) < Number(b.quantity || 0)
  );
  if (hasConsumed) {
    throw new OperationError(
      'لا يمكن تعديل أو حذف فاتورة شراء تم بيع جزء من مخزونها، استخدم مرتجع المشتريات بدلاً من ذلك',
      400
    );
  }
}

function handlePurchaseDelete(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  const purchaseId = String(payload.id);
  const existing = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
  if (!existing) {
    return { deleted: purchaseId, notFound: true };
  }

  assertOpenFiscalPeriod(tx, existing.date || ctx.now, payload, ctx.userRole);
  assertPurchaseMutable(tx, purchaseId);

  const oldItems = tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)).all();
  for (let idx = 0; idx < oldItems.length; idx++) {
    const item = oldItems[idx];
    const factor = Number(item.conversionFactor || 1);
    const baseQty = roundQty(Number(item.quantity || 0) * factor);
    const unitCost = Number(item.landedCostPerBaseUnit || item.costPrice || 0);
    tx.update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${baseQty}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(products.id, item.productId))
      .run();

    recordInventoryMovement(tx, {
      movementKey: `purchase_reversal:${purchaseId}:${ctx.operationId}:out:${item.productId}:${idx}`,
      productId: Number(item.productId),
      movementType: 'purchase_reversal',
      sourceType: 'purchase',
      sourceId: purchaseId,
      quantityDeltaBase: -baseQty,
      unitCost,
      totalCost: roundMoney(baseQty * unitCost),
      branchId: existing.branchId || null,
      operationId: ctx.operationId,
      reason: 'عكس / تعديل فاتورة مشتريات',
      createdBy: ctx.actor,
      createdAt: ctx.now,
    });
  }

  tx.delete(inventoryBatches).where(eq(inventoryBatches.purchaseId, purchaseId)).run();
  for (const item of oldItems) {
    recalculateProductWeightedCost(tx, item.productId);
  }

  const extraLandedCost = roundMoney(
    Number(existing.shippingCost || 0) + Number(existing.customsCost || 0) + Number(existing.otherCosts || 0)
  );
  const oldRemaining = roundMoney(Number(existing.totalAmount || 0) - Number(existing.paidAmount || 0));
  if (existing.supplierId && oldRemaining > 0) {
    tx.update(suppliers)
      .set({
        balance: sql`${suppliers.balance} - ${oldRemaining}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(suppliers.id, existing.supplierId))
      .run();
  }

  reverseJournalEntriesByReference(tx, purchaseId, 'حذف فاتورة مشتريات', ctx.actor);
  void extraLandedCost;

  tx.delete(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)).run();
  tx.delete(purchases).where(eq(purchases.id, purchaseId)).run();

  return { deleted: purchaseId };
}

function handlePurchaseUpdate(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  const { purchase } = payload;
  handlePurchaseDelete(tx, { id: purchase.id, allowClosedPeriodOverride: payload.allowClosedPeriodOverride }, ctx);
  return handlePurchaseCreate(tx, payload, ctx);
}

function handlePurchaseReturn(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; userRole?: string; now: string }
) {
  assertOpenFiscalPeriod(tx, ctx.now, payload, ctx.userRole);
  const {
    id,
    returnNumber,
    originalPurchaseId,
    items = [],
    refundMethod = 'credit_adjustment',
    reason,
    shiftId,
    branchId,
  } = payload;

  if (!originalPurchaseId || !Array.isArray(items) || items.length === 0) {
    throw new OperationError('Invalid purchase return payload', 400);
  }

  const origPurchase = tx
    .select()
    .from(purchases)
    .where(eq(purchases.id, String(originalPurchaseId)))
    .get();
  if (!origPurchase) {
    throw new OperationError('Original purchase not found', 404);
  }

  const returnId = id || crypto.randomUUID();
  const retNum = returnNumber || `PRET-${Date.now()}`;
  const purchaseBatches = tx
    .select()
    .from(inventoryBatches)
    .where(eq(inventoryBatches.purchaseId, String(originalPurchaseId)))
    .all();

  let totalReturn = 0;
  const savedItems: any[] = [];

  for (const reqItem of items) {
    const qtyToReturn = Number(reqItem.quantity || 0);
    if (qtyToReturn <= 0) continue;
    const prodId = Number(reqItem.productId);

    const matchingBatch = reqItem.batchId
      ? purchaseBatches.find((b: any) => b.id === String(reqItem.batchId))
      : purchaseBatches.find((b: any) => b.productId === prodId && Number(b.remainingQuantity) >= qtyToReturn) ||
        purchaseBatches.find((b: any) => b.productId === prodId);

    if (matchingBatch) {
      if (Number(matchingBatch.remainingQuantity || 0) < qtyToReturn) {
        throw new OperationError(
          `الكمية المتبقية في دفعة المنتج ${reqItem.productName} (${matchingBatch.remainingQuantity}) أقل من كمية المرتجع (${qtyToReturn})`,
          400
        );
      }
      tx.update(inventoryBatches)
        .set({
          remainingQuantity: Number(matchingBatch.remainingQuantity) - qtyToReturn,
          updatedAt: ctx.now,
          isSynced: 0,
        })
        .where(eq(inventoryBatches.id, matchingBatch.id))
        .run();
    } else {
      const product = tx.select().from(products).where(eq(products.id, prodId)).get();
      if (!product || Number(product.stockQuantity || 0) < qtyToReturn) {
        throw new OperationError(`المخزون المتاح لا يكفي لإرجاع المنتج ${reqItem.productName}`, 400);
      }
    }

    tx.update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${qtyToReturn}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(products.id, prodId))
      .run();

    recalculateProductWeightedCost(tx, prodId);

    const cost = Number(reqItem.costPrice ?? matchingBatch?.costPrice ?? 0);
    const lineTotal = roundMoney(qtyToReturn * cost);
    totalReturn = roundMoney(totalReturn + lineTotal);

    const insertedItem = tx
      .insert(purchaseReturnItems)
      .values({
        id: crypto.randomUUID(),
        purchaseReturnId: returnId,
        productId: prodId,
        productName: reqItem.productName || '',
        quantity: qtyToReturn,
        costPrice: cost,
        total: lineTotal,
        batchId: matchingBatch?.id || null,
        isSynced: 0,
        createdAt: ctx.now,
      })
      .returning()
      .get();

    savedItems.push(insertedItem);

    recordInventoryMovement(tx, {
      movementKey: `purchase_return:${returnId}:out:${prodId}:${savedItems.length}`,
      productId: prodId,
      movementType: 'purchase_return',
      sourceType: 'purchase_return',
      sourceId: returnId,
      quantityDeltaBase: -qtyToReturn,
      unitCost: cost,
      totalCost: lineTotal,
      branchId: branchId ?? origPurchase.branchId ?? null,
      operationId: ctx.operationId,
      reason: reason || 'مرتجع مشتريات للمورد',
      createdBy: ctx.actor,
      createdAt: ctx.now,
    });
  }

  if (savedItems.length === 0) {
    throw new OperationError('No valid purchase return items provided', 400);
  }

  const newReturnedAmount = roundMoney(Number(origPurchase.returnedAmount || 0) + totalReturn);
  if (newReturnedAmount > roundMoney(Number(origPurchase.totalAmount || 0)) + 0.05) {
    throw new OperationError('قيمة مرتجع المشتريات تتجاوز إجمالي فاتورة الشراء', 400);
  }

  const netPayable = Math.max(0, roundMoney(Number(origPurchase.totalAmount || 0) - newReturnedAmount));
  const paid = roundMoney(Number(origPurchase.paidAmount || 0));
  const nextStatus = paid >= netPayable ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  tx.update(purchases)
    .set({
      returnedAmount: newReturnedAmount,
      paymentStatus: nextStatus,
      updatedAt: ctx.now,
      isSynced: 0,
    })
    .where(eq(purchases.id, String(originalPurchaseId)))
    .run();

  if (refundMethod === 'credit_adjustment' && origPurchase.supplierId) {
    tx.update(suppliers)
      .set({
        balance: sql`${suppliers.balance} - ${totalReturn}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(suppliers.id, Number(origPurchase.supplierId)))
      .run();
  }

  const savedReturn = tx
    .insert(purchaseReturns)
    .values({
      id: returnId,
      returnNumber: retNum,
      originalPurchaseId: String(originalPurchaseId),
      supplierId: origPurchase.supplierId || null,
      supplierName: origPurchase.supplierName || null,
      branchId: branchId ?? origPurchase.branchId ?? null,
      shiftId: shiftId || null,
      refundMethod,
      totalReturn,
      reason: reason || 'مرتجع مشتريات للمورد',
      createdBy: ctx.actor,
      deviceId: ctx.deviceId,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning()
    .get();

  const debitAccountCode =
    refundMethod === 'cash' ? '1010' : refundMethod === 'card' ? '1020' : '2100';

  postJournalEntry(tx, {
    date: ctx.now,
    referenceId: returnId,
    referenceType: 'purchase_return',
    description: `مرتجع مشتريات ${retNum} للمورد ${origPurchase.supplierName || ''}`,
    lines: [
      { accountCode: debitAccountCode, debit: totalReturn, credit: 0, purchaseId: String(originalPurchaseId) },
      { accountCode: '1200', debit: 0, credit: totalReturn, purchaseId: String(originalPurchaseId) },
    ],
    createdBy: ctx.actor,
    branchId: branchId ?? origPurchase.branchId,
  });

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'purchase_return',
      userName: ctx.actor,
      action: 'مرتجع مشتريات',
      operationName: 'مرتجع فاتورة شراء',
      details: `مرتجع مشتريات ${retNum} للمورد ${origPurchase.supplierName || ''}`,
      quantity: savedItems.reduce((s, i) => s + Number(i.quantity), 0),
      value: totalReturn,
      branchId: branchId ?? origPurchase.branchId ?? null,
      entityId: returnId,
      entityName: retNum,
    })
    .run();

  return { purchaseReturn: savedReturn, items: savedItems };
}

function handleShiftMovement(
  tx: any,
  payload: any,
  ctx: { operationId: string; actor: string; now: string }
) {
  const { id, shiftId, type, amount, reason, branchId } = payload || {};
  const moveAmount = roundMoney(Number(amount || 0));
  if (!shiftId || (type !== 'deposit' && type !== 'withdrawal') || moveAmount <= 0) {
    throw new OperationError('Invalid shift movement payload', 400);
  }

  const shift = tx.select().from(shifts).where(eq(shifts.id, String(shiftId))).get();
  if (!shift) {
    throw new OperationError('Shift not found', 404);
  }
  if (shift.status !== 'open') {
    throw new OperationError('لا يمكن تسجيل حركة نقدية على وردية مغلقة', 400);
  }

  const movId = id ? String(id) : crypto.randomUUID();
  const saved = tx
    .insert(shiftMovements)
    .values({
      id: movId,
      shiftId: String(shiftId),
      type,
      amount: moveAmount,
      reason: reason || (type === 'deposit' ? 'إيداع نقدي بالصندوق' : 'سحب نقدي من الصندوق'),
      createdBy: ctx.actor,
      branchId: branchId ?? shift.branchId ?? null,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt: ctx.now,
    })
    .returning()
    .get();

  postJournalEntry(tx, {
    date: ctx.now,
    referenceId: movId,
    referenceType: 'shift_movement',
    description: `${type === 'deposit' ? 'إيداع نقدي بالوردية' : 'سحب نقدي من الوردية'}: ${saved.reason}`,
    lines:
      type === 'deposit'
        ? [
            { accountCode: '1010', debit: moveAmount, credit: 0 },
            { accountCode: '3100', debit: 0, credit: moveAmount },
          ]
        : [
            { accountCode: '3100', debit: moveAmount, credit: 0 },
            { accountCode: '1010', debit: 0, credit: moveAmount },
          ],
    createdBy: ctx.actor,
    branchId: branchId ?? shift.branchId,
  });

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'shift_movement',
      userName: ctx.actor,
      action: type === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي',
      operationName: 'حركة صندوق الوردية',
      details: `${saved.reason} (وردية ${shiftId})`,
      quantity: 1,
      value: moveAmount,
      branchId: branchId ?? shift.branchId ?? null,
      entityId: movId,
      entityName: shiftId,
    })
    .run();

  return saved;
}

function handleExpenseCreate(tx: any, payload: any, ctx: { actor: string; now: string }) {
  const expDate = payload.date ? new Date(payload.date).toISOString() : ctx.now;
  const amount = roundMoney(Number(payload.amount || 0));
  const paymentMethod = payload.paymentMethod === 'card' ? 'card' : 'cash';

  const saved = tx
    .insert(expenses)
    .values({
      ...(payload.id ? { id: Number(payload.id) } : {}),
      description: payload.description,
      amount,
      category: payload.category || 'عام',
      paymentMethod,
      shiftId: payload.shiftId || null,
      date: expDate,
      branchId: payload.branchId || null,
      isSynced: 0,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning()
    .get();

  if (amount > 0) {
    const creditAccount = paymentMethod === 'card' ? '1020' : '1010';
    postJournalEntry(tx, {
      date: expDate,
      referenceId: String(saved.id),
      referenceType: 'expense',
      description: `مصروف (${saved.category}): ${saved.description}`,
      lines: [
        { accountCode: '5200', debit: amount, credit: 0 },
        { accountCode: creditAccount, debit: 0, credit: amount },
      ],
      createdBy: ctx.actor,
      branchId: payload.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: expDate,
      type: 'expense',
      userName: ctx.actor,
      action: 'مصروف',
      operationName: 'تسجيل مصروف',
      details: `${saved.category}: ${saved.description}`,
      quantity: 1,
      value: amount,
      branchId: payload.branchId || null,
      entityId: String(saved.id),
      entityName: saved.category,
    })
    .run();

  return saved;
}

function handleCustomerPayment(
  tx: any,
  payload: any,
  ctx: { operationId: string; actor: string; now: string }
) {
  const { customerId, amount, paymentMethod = 'cash', orderId, branchId, shiftId, notes, paymentId } = payload;
  const payAmount = roundMoney(Number(amount || 0));
  if (!customerId || payAmount <= 0) {
    throw new OperationError('Invalid customer payment', 400);
  }

  const cust = tx.select().from(customers).where(eq(customers.id, Number(customerId))).get();
  if (!cust) throw new OperationError('Customer not found', 404);

  tx.update(customers)
    .set({
      balance: sql`${customers.balance} - ${payAmount}`,
      updatedAt: ctx.now,
      isSynced: 0,
    })
    .where(eq(customers.id, Number(customerId)))
    .run();

  if (orderId) {
    tx.update(orders)
      .set({
        paidAmount: sql`${orders.paidAmount} + ${payAmount}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(orders.id, String(orderId)))
      .run();
  }

  const savedPayment = tx
    .insert(customerPayments)
    .values({
      id: paymentId ? String(paymentId) : ctx.operationId,
      customerId: Number(customerId),
      customerName: cust.name,
      orderId: orderId ? String(orderId) : null,
      amount: payAmount,
      paymentMethod: paymentMethod === 'card' ? 'card' : 'cash',
      notes: notes || null,
      shiftId: shiftId || null,
      branchId: branchId ?? cust.branchId ?? null,
      createdBy: ctx.actor,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt: ctx.now,
    })
    .returning()
    .get();

  const debitAccount = paymentMethod === 'card' ? '1020' : '1010';
  postJournalEntry(tx, {
    date: ctx.now,
    referenceId: String(savedPayment.id),
    referenceType: 'payment',
    description: `تحصيل دفعة من العميل: ${cust.name}`,
    lines: [
      { accountCode: debitAccount, debit: payAmount, credit: 0, orderId },
      { accountCode: '1100', debit: 0, credit: payAmount, orderId },
    ],
    createdBy: ctx.actor,
    branchId: branchId ?? cust.branchId ?? null,
  });

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'customer_payment',
      userName: ctx.actor,
      action: 'تحصيل عميل',
      operationName: 'سداد ذمم عميل',
      details: `تحصيل ${payAmount} من العميل ${cust.name}`,
      quantity: 1,
      value: payAmount,
      branchId: branchId ?? cust.branchId ?? null,
      entityId: String(cust.id),
      entityName: cust.name,
    })
    .run();

  const updatedCustomer = tx.select().from(customers).where(eq(customers.id, Number(customerId))).get();
  return { customer: updatedCustomer, payment: savedPayment };
}

function handleSupplierPayment(
  tx: any,
  payload: any,
  ctx: { operationId: string; actor: string; now: string }
) {
  const { supplierId, amount, paymentMethod = 'cash', purchaseId, branchId, shiftId, notes, paymentId } = payload;
  const payAmount = roundMoney(Number(amount || 0));
  if (!supplierId || payAmount <= 0) {
    throw new OperationError('Invalid supplier payment', 400);
  }

  const sup = tx.select().from(suppliers).where(eq(suppliers.id, Number(supplierId))).get();
  if (!sup) throw new OperationError('Supplier not found', 404);

  tx.update(suppliers)
    .set({
      balance: sql`${suppliers.balance} - ${payAmount}`,
      updatedAt: ctx.now,
      isSynced: 0,
    })
    .where(eq(suppliers.id, Number(supplierId)))
    .run();

  if (purchaseId) {
    const p = tx.select().from(purchases).where(eq(purchases.id, String(purchaseId))).get();
    if (p) {
      const newPaid = roundMoney(Number(p.paidAmount || 0) + payAmount);
      const netPayable = Math.max(0, roundMoney(Number(p.totalAmount || 0) - Number(p.returnedAmount || 0)));
      tx.update(purchases)
        .set({
          paidAmount: newPaid,
          paymentStatus: newPaid >= netPayable ? 'paid' : 'partial',
          updatedAt: ctx.now,
          isSynced: 0,
        })
        .where(eq(purchases.id, String(purchaseId)))
        .run();
    }
  }

  const savedPayment = tx
    .insert(supplierPayments)
    .values({
      id: paymentId ? String(paymentId) : ctx.operationId,
      supplierId: Number(supplierId),
      supplierName: sup.name,
      purchaseId: purchaseId ? String(purchaseId) : null,
      amount: payAmount,
      paymentMethod: paymentMethod === 'card' ? 'card' : 'cash',
      notes: notes || null,
      shiftId: shiftId || null,
      branchId: branchId ?? null,
      createdBy: ctx.actor,
      operationId: ctx.operationId,
      isSynced: 0,
      createdAt: ctx.now,
    })
    .returning()
    .get();

  const creditAccount = paymentMethod === 'card' ? '1020' : '1010';
  postJournalEntry(tx, {
    date: ctx.now,
    referenceId: String(savedPayment.id),
    referenceType: 'payment',
    description: `سداد دفعة للمورد: ${sup.name}`,
    lines: [
      { accountCode: '2100', debit: payAmount, credit: 0, purchaseId },
      { accountCode: creditAccount, debit: 0, credit: payAmount, purchaseId },
    ],
    createdBy: ctx.actor,
    branchId,
  });

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'supplier_payment',
      userName: ctx.actor,
      action: 'سداد مورد',
      operationName: 'دفع مستحقات مورد',
      details: `سداد ${payAmount} للمورد ${sup.name}`,
      quantity: 1,
      value: payAmount,
      branchId: branchId ?? null,
      entityId: String(sup.id),
      entityName: sup.name,
    })
    .run();

  const updatedSupplier = tx.select().from(suppliers).where(eq(suppliers.id, Number(supplierId))).get();
  return { supplier: updatedSupplier, payment: savedPayment };
}

function handlePayrollCreate(tx: any, payload: any, ctx: { actor: string; now: string }) {
  const netSalary = roundMoney(Number(payload.netSalary || 0));
  const paymentMethod = payload.paymentMethod === 'card' ? 'card' : 'cash';
  const { id: rawId, syncStatus: _sync, ...rest } = payload;

  const saved = tx
    .insert(payrolls)
    .values({
      ...(rawId && Number.isSafeInteger(Number(rawId)) && Number(rawId) > 0 ? { id: Number(rawId) } : {}),
      employeeId: Number(rest.employeeId),
      employeeName: String(rest.employeeName || ''),
      periodStart: String(rest.periodStart || ctx.now.split('T')[0]),
      periodEnd: String(rest.periodEnd || ctx.now.split('T')[0]),
      salaryType: rest.salaryType === 'hourly' ? 'hourly' : 'monthly',
      totalHours: Number(rest.totalHours || 0),
      hourlyRate: Number(rest.hourlyRate || 0),
      basicSalary: roundMoney(Number(rest.basicSalary || 0)),
      bonuses: roundMoney(Number(rest.bonuses || 0)),
      deductions: roundMoney(Number(rest.deductions || 0)),
      netSalary,
      paymentMethod,
      branchId: rest.branchId || null,
      paymentDate: rest.paymentDate || ctx.now,
      status: rest.status || 'paid',
      isSynced: 0,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning()
    .get();

  if (netSalary > 0 && saved.status === 'paid') {
    const creditAccount = paymentMethod === 'card' ? '1020' : '1010';
    postJournalEntry(tx, {
      date: saved.paymentDate,
      referenceId: String(saved.id),
      referenceType: 'payroll',
      description: `صرف راتب الموظف: ${saved.employeeName}`,
      lines: [
        { accountCode: '5300', debit: netSalary, credit: 0 },
        { accountCode: creditAccount, debit: 0, credit: netSalary },
      ],
      createdBy: ctx.actor,
      branchId: saved.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: saved.paymentDate || ctx.now,
      type: 'payroll',
      userName: ctx.actor,
      action: 'صرف راتب',
      operationName: 'مسير رواتب',
      details: `صرف راتب ${saved.employeeName} (${saved.salaryType === 'hourly' ? 'بالساعة' : 'شهري'})`,
      quantity: 1,
      value: netSalary,
      branchId: saved.branchId || null,
      entityId: String(saved.id),
      entityName: saved.employeeName,
    })
    .run();

  return saved;
}

function handleStocktakeApprove(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
) {
  const { sessionId } = payload;
  const session = tx
    .select()
    .from(stocktakingSessions)
    .where(eq(stocktakingSessions.id, sessionId))
    .get();
  if (!session) throw new OperationError('Stocktaking session not found', 404);
  if (session.status === 'approved') return { session, alreadyApproved: true };

  const entries = tx
    .select()
    .from(stocktakingEntries)
    .where(eq(stocktakingEntries.sessionId, sessionId))
    .all();

  const valuationMethod = getValuationMethod(tx);
  let netAdjustmentValue = 0;

  for (const entry of entries) {
    const product = tx.select().from(products).where(eq(products.id, entry.productId)).get();
    if (!product) continue;

    const diff = roundQty(Number(entry.actualQuantity) - Number(product.stockQuantity));
    if (Math.abs(diff) < 1e-6) continue;

    if (diff > 0) {
      const unitCost = Number(product.costPrice || 0);
      tx.insert(inventoryBatches)
        .values({
          id: crypto.randomUUID(),
          productId: product.id,
          purchaseId: null,
          quantity: diff,
          remainingQuantity: diff,
          costPrice: unitCost,
          purchaseDate: ctx.now,
          branchId: session.branchId || null,
          isSynced: 0,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
      tx.update(products)
        .set({ stockQuantity: Number(entry.actualQuantity), updatedAt: ctx.now, isSynced: 0 })
        .where(eq(products.id, product.id))
        .run();
      recordInventoryMovement(tx, {
        movementKey: `stocktake:${sessionId}:in:${product.id}`,
        productId: product.id,
        movementType: 'stocktake_increase',
        sourceType: 'stocktake',
        sourceId: sessionId,
        quantityDeltaBase: diff,
        baseUnitCode: product.baseUnitCode || product.unit || 'piece',
        unitCost,
        totalCost: roundMoney(diff * unitCost),
        branchId: session.branchId || null,
        operationId: ctx.operationId,
        reason: `زيادة جرد #${sessionId}`,
        createdBy: ctx.actor,
        createdAt: ctx.now,
      });
      netAdjustmentValue = roundMoney(netAdjustmentValue + diff * unitCost);
    } else {
      const fifo = consumeInventoryFIFO(tx, {
        productId: product.id,
        quantityInBaseUnits: Math.abs(diff),
        operationId: ctx.operationId,
        deviceId: ctx.deviceId,
        productName: product.name,
        allowNegative: true,
        valuationMethod,
        movementType: 'stocktake_decrease',
        sourceType: 'stocktake',
        sourceId: sessionId,
        movementKeySuffix: String(product.id),
        branchId: session.branchId || null,
        reason: `عجز جرد #${sessionId}`,
        createdBy: ctx.actor,
        createdAt: ctx.now,
      });
      netAdjustmentValue = roundMoney(netAdjustmentValue - fifo.totalCost);
    }
  }

  tx.update(stocktakingSessions)
    .set({ status: 'approved', isSynced: 0 })
    .where(eq(stocktakingSessions.id, sessionId))
    .run();

  if (netAdjustmentValue !== 0) {
    const absVal = Math.abs(netAdjustmentValue);
    postJournalEntry(tx, {
      date: ctx.now,
      referenceId: sessionId,
      referenceType: 'stocktake',
      description: `تسوية جرد مخزون #${sessionId}`,
      lines:
        netAdjustmentValue > 0
          ? [
              { accountCode: '1200', debit: absVal, credit: 0 },
              { accountCode: '5400', debit: 0, credit: absVal },
            ]
          : [
              { accountCode: '5400', debit: absVal, credit: 0 },
              { accountCode: '1200', debit: 0, credit: absVal },
            ],
      createdBy: ctx.actor,
      branchId: session.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'stocktake_approve',
      userName: ctx.actor,
      action: 'اعتماد جرد',
      operationName: 'تسوية جرد مخزون',
      details: `اعتماد جلسة جرد #${sessionId}`,
      quantity: entries.length,
      value: Math.abs(netAdjustmentValue),
      branchId: session.branchId || null,
      entityId: sessionId,
      entityName: sessionId,
    })
    .run();

  return { sessionId, status: 'approved', netAdjustmentValue };
}

function getEntityTable(tableName: string) {
  const map: Record<string, any> = {
    products,
    categories,
    customers,
    suppliers,
    employees,
    expenses,
    shifts,
    branches,
    offers,
    attendance,
    settings,
    stocktakingSessions,
    stocktakingEntries,
    inventoryBatches,
    serviceRecipes,
    exchangeRateHistory,
    fiscalPeriods,
  };
  return map[tableName];
}

function handleEntityUpsert(tx: any, payload: any, now: string) {
  const { table: tableName, record } = payload;
  const table = getEntityTable(tableName);
  if (!table || !record) {
    throw new OperationError(`Unsupported entity table: ${tableName}`, 400);
  }

  const { syncStatus: _s, ...clean } = record;

  if (tableName === 'settings') {
    if (clean.key === 'authSecret') {
      throw new OperationError('Cannot overwrite authSecret', 403);
    }
    return tx
      .insert(settings)
      .values({ key: clean.key, value: String(clean.value), isSynced: 0, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: String(clean.value), isSynced: 0, updatedAt: now },
      })
      .returning()
      .get();
  }

  if (tableName === 'employees') {
    const empData: any = { ...clean };
    delete empData.hasPin;
    if (Array.isArray(empData.permissions)) {
      empData.permissions = JSON.stringify(empData.permissions);
    }
    if (typeof empData.mustChangePassword === 'boolean') {
      empData.mustChangePassword = empData.mustChangePassword ? 1 : 0;
    }

    const existingEmp = empData.id
      ? tx.select().from(employees).where(eq(employees.id, Number(empData.id))).get()
      : null;

    if (empData.password && String(empData.password).trim() !== '') {
      empData.password = String(empData.password).startsWith('$2')
        ? empData.password
        : hashSecret(String(empData.password));
    } else if (existingEmp) {
      delete empData.password;
    } else {
      empData.password = hashSecret(crypto.randomBytes(12).toString('hex'));
    }

    if (empData.pinCode && String(empData.pinCode).trim() !== '') {
      empData.pinCode = String(empData.pinCode).startsWith('$2')
        ? empData.pinCode
        : hashSecret(String(empData.pinCode));
    } else if (existingEmp) {
      delete empData.pinCode;
    }

    if (existingEmp) {
      const updated = tx
        .update(employees)
        .set({ ...empData, isSynced: 0, updatedAt: now })
        .where(eq(employees.id, existingEmp.id))
        .returning()
        .get();
      return sanitizeEmployee(updated);
    }

    const { id: _tempId, ...insertFields } = empData;
    const inserted = tx
      .insert(employees)
      .values({
        ...(rawTempIdIfValid(empData.id) ? { id: Number(empData.id) } : {}),
        ...insertFields,
        isSynced: 0,
        createdAt: empData.createdAt || now,
        updatedAt: empData.updatedAt || now,
      })
      .returning()
      .get();
    return sanitizeEmployee(inserted);
  }

  if (tableName === 'branches') {
    const brData: any = { ...clean };
    if (typeof brData.isActive === 'boolean') {
      brData.status = brData.isActive ? 'active' : 'inactive';
      brData.isActive = brData.isActive ? 1 : 0;
    }
    if (brData.id && Number(brData.id) >= 1000000) {
      const { id: _tmp, ...restBr } = brData;
      return tx
        .insert(branches)
        .values({ ...restBr, isSynced: 0, createdAt: now, updatedAt: now })
        .returning()
        .get();
    }
    return tx
      .insert(branches)
      .values({ ...brData, isSynced: 0, createdAt: brData.createdAt || now, updatedAt: brData.updatedAt || now })
      .onConflictDoUpdate({
        target: branches.id,
        set: { ...brData, isSynced: 0, updatedAt: now },
      })
      .returning()
      .get();
  }

  if (tableName === 'offers') {
    const offData: any = { ...clean };
    if (Array.isArray(offData.applicableProducts)) {
      offData.applicableProducts = JSON.stringify(offData.applicableProducts);
    }
    if (typeof offData.isActive === 'boolean') {
      offData.status = offData.isActive ? 'active' : 'inactive';
      offData.isActive = offData.isActive ? 1 : 0;
    }
    if (offData.id && Number(offData.id) >= 1000000) {
      const { id: _tmp, ...restOff } = offData;
      return tx
        .insert(offers)
        .values({ ...restOff, isSynced: 0, createdAt: now, updatedAt: now })
        .returning()
        .get();
    }
    return tx
      .insert(offers)
      .values({ ...offData, isSynced: 0, createdAt: offData.createdAt || now, updatedAt: offData.updatedAt || now })
      .onConflictDoUpdate({
        target: offers.id,
        set: { ...offData, isSynced: 0, updatedAt: now },
      })
      .returning()
      .get();
  }

  if (tableName === 'exchangeRateHistory') {
    const idVal = clean.id ? String(clean.id) : crypto.randomUUID();
    return tx
      .insert(exchangeRateHistory)
      .values({
        id: idVal,
        currency: String(clean.currency || 'USD'),
        rate: Number(clean.rate || 1),
        source: clean.source || 'manual',
        effectiveFrom: clean.effectiveFrom || now,
        notes: clean.notes || null,
        createdBy: clean.createdBy || null,
        isSynced: 0,
        createdAt: clean.createdAt || now,
      })
      .onConflictDoUpdate({
        target: exchangeRateHistory.id,
        set: {
          currency: String(clean.currency || 'USD'),
          rate: Number(clean.rate || 1),
          source: clean.source || 'manual',
          effectiveFrom: clean.effectiveFrom || now,
          notes: clean.notes || null,
          isSynced: 0,
        },
      })
      .returning()
      .get();
  }

  // Handle auto-increment integer tables where offline client generated a timestamp temp ID (>= 1000000)
  const autoIncTables = new Set(['products', 'categories', 'customers', 'suppliers', 'expenses']);
  let savedRecord: any;
  const normalizedClean = { ...clean };
  if (tableName === 'products' && typeof normalizedClean.allowFractions === 'boolean') {
    normalizedClean.allowFractions = normalizedClean.allowFractions ? 1 : 0;
  }

  let prevProduct: any = null;
  if (tableName === 'products' && normalizedClean.id && Number(normalizedClean.id) < 1000000) {
    prevProduct = tx.select().from(products).where(eq(products.id, Number(normalizedClean.id))).get();
  }

  if (autoIncTables.has(tableName) && normalizedClean.id && Number(normalizedClean.id) >= 1000000) {
    const { id: _tmp, ...insertValues } = normalizedClean;
    savedRecord = tx
      .insert(table)
      .values({ ...insertValues, isSynced: 0, createdAt: normalizedClean.createdAt || now, updatedAt: normalizedClean.updatedAt || now })
      .returning()
      .get();
  } else {
    savedRecord = tx
      .insert(table)
      .values({ ...normalizedClean, isSynced: 0, createdAt: normalizedClean.createdAt || now, updatedAt: normalizedClean.updatedAt || now })
      .onConflictDoUpdate({
        target: table.id,
        set: { ...normalizedClean, isSynced: 0, updatedAt: now },
      })
      .returning()
      .get();
  }

  if (
    tableName === 'products' &&
    prevProduct &&
    savedRecord &&
    (Number(prevProduct.sellingPrice) !== Number(savedRecord.sellingPrice) ||
      Number(prevProduct.costPrice) !== Number(savedRecord.costPrice))
  ) {
    tx.insert(auditLogs)
      .values({
        id: crypto.randomUUID(),
        date: now,
        type: 'price_change',
        userName: normalizedClean.updatedBy || 'System',
        action: 'تعديل سعر',
        operationName: 'تحديث تسعيرة صنف',
        productName: savedRecord.name,
        details: `تعديل سعر ${savedRecord.name} من ${prevProduct.sellingPrice} إلى ${savedRecord.sellingPrice}`,
        quantity: 1,
        value: Number(savedRecord.sellingPrice || 0),
        branchId: savedRecord.branchId || null,
        previousValue: JSON.stringify({ costPrice: prevProduct.costPrice, sellingPrice: prevProduct.sellingPrice }),
        newValue: JSON.stringify({ costPrice: savedRecord.costPrice, sellingPrice: savedRecord.sellingPrice }),
        entityId: String(savedRecord.id),
        entityName: savedRecord.name,
      })
      .run();
  }

  if (
    tableName === 'products' &&
    savedRecord &&
    Number(savedRecord.stockQuantity) > 0 &&
    (!savedRecord.itemType || savedRecord.itemType === 'stock')
  ) {
    const existingBatches = tx
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.productId, savedRecord.id))
      .all();
    if (existingBatches.length === 0) {
      tx.insert(inventoryBatches)
        .values({
          id: crypto.randomUUID(),
          productId: savedRecord.id,
          purchaseId: null,
          quantity: Number(savedRecord.stockQuantity),
          remainingQuantity: Number(savedRecord.stockQuantity),
          costPrice: Number(savedRecord.costPrice || 0),
          purchaseDate: now,
          branchId: savedRecord.branchId || null,
          isSynced: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const openingTotalCost = roundMoney(
        Number(savedRecord.stockQuantity) * Number(savedRecord.costPrice || 0)
      );
      recordInventoryMovement(tx, {
        movementKey: `opening:${savedRecord.id}`,
        productId: savedRecord.id,
        movementType: 'opening_balance',
        sourceType: 'product',
        sourceId: String(savedRecord.id),
        quantityDeltaBase: Number(savedRecord.stockQuantity),
        baseUnitCode: savedRecord.baseUnitCode || savedRecord.unit || 'piece',
        unitCost: Number(savedRecord.costPrice || 0),
        totalCost: openingTotalCost,
        branchId: savedRecord.branchId || null,
        reason: 'رصيد افتتاحي للصنف',
        createdBy: 'System',
        createdAt: now,
      });
      if (openingTotalCost > 0) {
        postJournalEntry(tx, {
          date: now,
          referenceId: `opening:${savedRecord.id}`,
          referenceType: 'opening',
          description: `رصيد افتتاحي للمخزون: ${savedRecord.name}`,
          lines: [
            { accountCode: '1200', debit: openingTotalCost, credit: 0 },
            { accountCode: '3100', debit: 0, credit: openingTotalCost },
          ],
          createdBy: 'System',
          branchId: savedRecord.branchId || undefined,
        });
      }
    }
  }

  return savedRecord;
}

function rawTempIdIfValid(id: unknown): boolean {
  return typeof id === 'number' && id > 0 && id < 1000000;
}

function handleEntityDelete(tx: any, payload: any) {
  const { table: tableName, id } = payload;
  const table = getEntityTable(tableName);
  if (!table) {
    throw new OperationError(`Unsupported entity table: ${tableName}`, 400);
  }
  tx.delete(table).where(eq(table.id, id)).run();
  return { table: tableName, deleted: id };
}
