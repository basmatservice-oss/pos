import crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
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
  currencies,
  exchangeRates,
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
  inventoryMovements,
  productUnits,
  unitDefinitions,
  processedOperations,
} from '../drizzle/schema.js';
import {
  postJournalEntry,
  reverseJournalEntriesByReference,
  consumeInventoryFIFO,
  restoreInventoryFIFO,
  recalculateProductWeightedCost,
  BatchAllocation,
} from './accounting.js';
import { hashSecret, sanitizeEmployee } from './auth.js';
import { getBasePerDocumentUnit } from '../src/utils/currencyConversion.js';

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function appendInventoryMovement(
  tx: any,
  ctx: { operationId: string; deviceId: string; actor: string; now: string },
  input: {
    productId: number;
    branchId?: number | null;
    movementType: string;
    sourceType: string;
    sourceId: string;
    sourceLineId?: string | number | null;
    inputQuantity?: number | null;
    unitCode?: string | null;
    baseUnitCode?: string | null;
    conversionToBase?: number;
    quantityDeltaBase: number;
    unitCost?: number;
    totalCost?: number;
    batchAllocations?: any[] | string | null;
    reason?: string | null;
  }
) {
  const movementKey = [
    input.movementType,
    input.sourceType,
    input.sourceId,
    input.sourceLineId == null ? input.productId : String(input.sourceLineId),
  ].join(':');
  const id = crypto.createHash('sha256')
    .update(`${ctx.operationId}:${movementKey}`)
    .digest('hex');
  const allocations = typeof input.batchAllocations === 'string'
    ? input.batchAllocations
    : input.batchAllocations ? JSON.stringify(input.batchAllocations) : null;

  tx.insert(inventoryMovements)
    .values({
      id,
      movementKey,
      productId: Number(input.productId),
      branchId: input.branchId ?? null,
      movementType: input.movementType,
      sourceType: input.sourceType,
      sourceId: String(input.sourceId),
      sourceLineId: input.sourceLineId == null ? null : String(input.sourceLineId),
      operationId: ctx.operationId,
      deviceId: ctx.deviceId,
      createdBy: ctx.actor,
      inputQuantity: input.inputQuantity ?? null,
      unitCode: input.unitCode ?? null,
      baseUnitCode: input.baseUnitCode ?? null,
      conversionToBase: Number(input.conversionToBase || 1),
      quantityDeltaBase: Number(input.quantityDeltaBase),
      unitCost: Number(input.unitCost || 0),
      totalCost: Math.abs(Number(input.totalCost || 0)),
      batchAllocations: allocations,
      reason: input.reason ?? null,
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .run();

  return id;
}

type MovementUnitSnapshot = {
  unitCode: string | null;
  baseUnitCode: string | null;
  conversionToBase: number;
  baseQuantity: number;
  legacyUnit: string;
};

function resolveMovementUnit(tx: any, productId: number, item: any, quantity: number): MovementUnitSnapshot {
  const product = tx.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw new OperationError(`الصنف رقم ${productId} غير موجود`, 404);

  const unitCode = String(item?.unitCode || '').trim().toLowerCase();
  if (unitCode) {
    const selectedUnit = tx.select().from(productUnits)
      .where(and(
        eq(productUnits.productId, productId),
        eq(productUnits.unitCode, unitCode),
        eq(productUnits.isActive, 1)
      )).get();
    if (!selectedUnit) throw new OperationError('وحدة الإدخال غير مرتبطة بهذا الصنف أو أنها غير نشطة', 409);

    const baseUnitCode = String(product.baseUnitCode || '').trim().toLowerCase();
    const baseUnit = baseUnitCode ? tx.select().from(productUnits)
      .where(and(
        eq(productUnits.productId, productId),
        eq(productUnits.unitCode, baseUnitCode),
        eq(productUnits.isBaseUnit, 1),
        eq(productUnits.isActive, 1)
      )).get() : null;
    if (!baseUnit) throw new OperationError('يجب ضبط وحدة الأساس للصنف قبل استخدام وحداته البديلة', 409);

    const definition = tx.select().from(unitDefinitions)
      .where(eq(unitDefinitions.code, unitCode)).get();
    const baseDefinition = tx.select().from(unitDefinitions)
      .where(eq(unitDefinitions.code, baseUnitCode)).get();
    if (!definition || !definition.isActive || !baseDefinition || !baseDefinition.isActive) {
      throw new OperationError('تعريف وحدة القياس أو وحدة الأساس غير موجود أو غير نشط', 409);
    }
    if (definition.dimension !== baseDefinition.dimension) {
      throw new OperationError('لا يمكن التحويل بين وحدات ذات أبعاد مختلفة', 409);
    }
    if (Math.abs(Number(baseUnit.conversionToBase) - 1) > 1e-10 ||
        (selectedUnit.isBaseUnit === 1 && unitCode !== baseUnitCode)) {
      throw new OperationError('تعريف وحدة الأساس للصنف غير متسق', 409);
    }

    // Honor the conversion snapshot captured on the terminal. Offline transactions
    // must not be reinterpreted if an administrator updates the unit later.
    const hasSnapshotFactor = item?.conversionToBase !== null && item?.conversionToBase !== undefined;
    const factor = hasSnapshotFactor ? Number(item.conversionToBase) : Number(selectedUnit.conversionToBase);
    if (!Number.isFinite(factor) || factor <= 0 || (selectedUnit.isBaseUnit === 1 && Math.abs(factor - 1) > 1e-10)) {
      throw new OperationError('معامل تحويل وحدة الصنف غير صالح', 409);
    }
    if (item?.baseUnitCode && String(item.baseUnitCode).toLowerCase() !== baseUnitCode) {
      throw new OperationError('تغيرت وحدة الأساس بعد تسجيل الحركة على الجهاز؛ يلزم تسوية الحركة قبل المزامنة', 409);
    }
    const suppliedBaseQuantity = item?.baseQuantity;
    if (suppliedBaseQuantity !== null && suppliedBaseQuantity !== undefined) {
      const expectedBaseQuantity = quantity * factor;
      const tolerance = Math.max(1e-7, Math.abs(expectedBaseQuantity) * 1e-9);
      if (!Number.isFinite(Number(suppliedBaseQuantity)) ||
          Math.abs(Number(suppliedBaseQuantity) - expectedBaseQuantity) > tolerance) {
        throw new OperationError('لقطة كمية الأساس لا تتوافق مع الكمية ومعامل التحويل', 409);
      }
    }

    const precision = Math.max(0, Math.min(6, Number(definition.decimalPlaces || 0)));
    const scale = 10 ** precision;
    if (Math.abs(quantity * scale - Math.round(quantity * scale)) > 1e-7) {
      throw new OperationError(`الكمية لا تتوافق مع دقة وحدة ${definition.name}`, 400);
    }

    return {
      unitCode,
      baseUnitCode,
      conversionToBase: factor,
      baseQuantity: quantity * factor,
      legacyUnit: unitCode,
    };
  }

  // Older terminals still send the legacy piece/box fields. Keep their historical semantics.
  const legacyUnit = String(item?.unit || item?.selectedUnit || 'piece');
  const factor = legacyUnit === 'box' ? Number(item?.conversionFactor || 1) : 1;
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new OperationError('معامل تحويل الوحدة القديمة غير صالح', 400);
  }
  return {
    unitCode: null,
    baseUnitCode: product.baseUnitCode || null,
    conversionToBase: factor,
    baseQuantity: quantity * factor,
    legacyUnit,
  };
}

function getHistoricalBaseQuantity(item: any, quantity: number): number {
  const originalQuantity = Number(item?.quantity || 0);
  const hasStoredBaseQuantity = item?.baseQuantity !== null && item?.baseQuantity !== undefined;
  const storedBaseQuantity = Number(item?.baseQuantity);
  if (hasStoredBaseQuantity && originalQuantity > 0 && Number.isFinite(storedBaseQuantity) && storedBaseQuantity >= 0) {
    return storedBaseQuantity * (quantity / originalQuantity);
  }
  const factor = Number(item?.conversionToBase ?? item?.conversionFactor ?? 1);
  return quantity * (Number.isFinite(factor) && factor > 0 ? factor : 1);
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
        result = handleSale(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'return': {
        result = handleReturn(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'order_void': {
        result = handleOrderVoid(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'purchase': {
        result = handlePurchaseCreate(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'purchase_update': {
        result = handlePurchaseUpdate(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'purchase_delete': {
        result = handlePurchaseDelete(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'purchase_return': {
        result = handlePurchaseReturn(tx, payload, { operationId, deviceId, actor, now });
        break;
      }
      case 'expense': {
        result = handleExpenseCreate(tx, payload, { actor, now });
        break;
      }
      case 'expense_delete': {
        const expId = Number(payload.id);
        const existing = tx.select().from(expenses).where(eq(expenses.id, expId)).get();
        if (existing) {
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
        result = handleCustomerPayment(tx, payload, { operationId, actor, now });
        break;
      }
      case 'supplier_payment': {
        result = handleSupplierPayment(tx, payload, { operationId, actor, now });
        break;
      }
      case 'payroll': {
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
        result = handleShiftMovement(tx, payload, { operationId, actor, now });
        break;
      }
      case 'stocktake_approve': {
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

function handleSale(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
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
  let totalCogs = 0;
  const savedItems: any[] = [];

  for (const item of items) {
    const qty = Number(item.quantity || 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new OperationError('كمية البيع يجب أن تكون رقماً موجباً', 400);
    }
    const unitSnapshot = resolveMovementUnit(tx, Number(item.productId), item, qty);
    const factor = unitSnapshot.conversionToBase;
    const baseQty = unitSnapshot.baseQuantity;
    const fifo = consumeInventoryFIFO(tx, {
      productId: Number(item.productId),
      quantityInBaseUnits: baseQty,
      operationId: ctx.operationId,
      deviceId: ctx.deviceId,
      productName: item.productName,
      allowNegative: true,
    });

    const unitCostForSale = roundMoney(fifo.averageUnitCost * factor);
    totalCogs = roundMoney(totalCogs + fifo.totalCost);

    const insertedItem = tx
      .insert(orderItems)
      .values({
        id: Number(item.id) || undefined,
        orderId: order.id,
        productId: Number(item.productId),
        productName: item.productName,
        quantity: qty,
        returnedQuantity: 0,
        unit: unitSnapshot.legacyUnit,
        conversionFactor: factor,
        unitCode: unitSnapshot.unitCode,
        baseUnitCode: unitSnapshot.baseUnitCode,
        conversionToBase: factor,
        baseQuantity: baseQty,
        unitPrice: Number(item.unitPrice || 0),
        costPriceAtTimeOfSale: unitCostForSale,
        discountAmount: Number(item.discountAmount || 0),
        subTotal: Number(item.subTotal || 0),
        taxAmount: Number(item.taxAmount || 0),
        total: Number(item.total || 0),
        batchAllocations: JSON.stringify(fifo.allocations),
        isSynced: 0,
        createdAt,
      })
      .returning()
      .get();

    appendInventoryMovement(tx, ctx, {
      productId: Number(item.productId),
      branchId: order.branchId ?? null,
      movementType: 'sale',
      sourceType: 'order',
      sourceId: String(order.id),
      sourceLineId: insertedItem.id,
      inputQuantity: qty,
      unitCode: unitSnapshot.unitCode,
      baseUnitCode: unitSnapshot.baseUnitCode,
      conversionToBase: factor,
      quantityDeltaBase: -baseQty,
      unitCost: fifo.averageUnitCost,
      totalCost: fifo.totalCost,
      batchAllocations: fifo.allocations,
    });
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
      quantity: savedItems.reduce((s, i) => s + Number(i.quantity), 0),
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
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
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
  } = payload;

  if (!originalOrderId || !Array.isArray(items) || items.length === 0) {
    throw new OperationError('Invalid return payload: missing originalOrderId or items', 400);
  }

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
  let totalCostReversed = 0;
  const savedReturnItems: any[] = [];

  for (const reqItem of items) {
    const qtyToReturn = Number(reqItem.quantity || 0);
    if (!Number.isFinite(qtyToReturn) || qtyToReturn <= 0) {
      throw new OperationError('كمية المرتجع يجب أن تكون رقماً موجباً', 400);
    }

    const origItem = reqItem.orderItemId
      ? origItems.find((oi: any) => oi.id === Number(reqItem.orderItemId))
      : origItems.find((oi: any) =>
          oi.productId === Number(reqItem.productId) &&
          Number(oi.quantity || 0) - Number(oi.returnedQuantity || 0) >= qtyToReturn
        );

    if (!origItem) {
      throw new OperationError(`Item ${reqItem.productName || reqItem.productId} not found in original order`, 400);
    }

    if (origItem.unitCode) {
      const unitDefinition = tx.select().from(unitDefinitions)
        .where(eq(unitDefinitions.code, origItem.unitCode)).get();
      if (!unitDefinition || !unitDefinition.isActive) {
        throw new OperationError('تعريف وحدة المرتجع الأصلية غير متاح', 409);
      }
      const precision = Math.max(0, Math.min(6, Number(unitDefinition.decimalPlaces || 0)));
      const scale = 10 ** precision;
      if (Math.abs(qtyToReturn * scale - Math.round(qtyToReturn * scale)) > 1e-7) {
        throw new OperationError('كمية المرتجع لا تتوافق مع دقة وحدة البيع الأصلية', 400);
      }
    }

    const alreadyReturned = Number(origItem.returnedQuantity || 0);
    const remainingReturnable = Number(origItem.quantity) - alreadyReturned;

    if (qtyToReturn > remainingReturnable) {
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

    const factor = Number(origItem.conversionToBase ?? origItem.conversionFactor ?? 1);
    const baseQty = getHistoricalBaseQuantity(origItem, qtyToReturn);
    let allocations: BatchAllocation[] = [];
    try {
      allocations = origItem.batchAllocations ? JSON.parse(origItem.batchAllocations) : [];
    } catch {}

    const baseCostFallback =
      factor > 0 ? Number(origItem.costPriceAtTimeOfSale || 0) / factor : Number(origItem.costPriceAtTimeOfSale || 0);

    const restored = restoreInventoryFIFO(tx, {
      productId: Number(origItem.productId),
      quantityInBaseUnits: baseQty,
      allocations,
      fallbackCost: baseCostFallback,
      branchId: branchId ?? origOrder.branchId,
      batchIdPrefix: `return-${id}-${origItem.id}`,
    });

    totalSub = roundMoney(totalSub + lineSub);
    totalDiscount = roundMoney(totalDiscount + lineDisc);
    totalTax = roundMoney(totalTax + lineTax);
    totalRefund = roundMoney(totalRefund + lineTotal);
    totalCostReversed = roundMoney(totalCostReversed + restored.totalCostRestored);

    tx.update(orderItems)
      .set({
        returnedQuantity: alreadyReturned + qtyToReturn,
        batchAllocations: JSON.stringify(restored.remainingAllocations),
        isSynced: 0,
      })
      .where(eq(orderItems.id, origItem.id))
      .run();
    origItem.returnedQuantity = alreadyReturned + qtyToReturn;
    origItem.batchAllocations = JSON.stringify(restored.remainingAllocations);

    const retItem = tx
      .insert(returnItems)
      .values({
        id: crypto.randomUUID(),
        returnId,
        orderItemId: origItem.id,
        productId: Number(origItem.productId),
        productName: origItem.productName,
        quantity: qtyToReturn,
        unitPrice: Number(origItem.unitPrice),
        unitCode: origItem.unitCode || null,
        baseUnitCode: origItem.baseUnitCode || null,
        conversionToBase: factor,
        baseQuantity: baseQty,
        costPrice: Number(origItem.costPriceAtTimeOfSale || 0),
        taxAmount: lineTax,
        total: lineTotal,
        batchAllocations: JSON.stringify(restored.restoredAllocations),
        isSynced: 0,
        createdAt: ctx.now,
      })
      .returning()
      .get();

    appendInventoryMovement(tx, ctx, {
      productId: Number(origItem.productId),
      branchId: branchId ?? origOrder.branchId ?? null,
      movementType: 'sale_return',
      sourceType: 'return',
      sourceId: String(returnId),
      sourceLineId: retItem.id,
      inputQuantity: qtyToReturn,
      unitCode: origItem.unitCode || null,
      baseUnitCode: origItem.baseUnitCode || null,
      conversionToBase: factor,
      quantityDeltaBase: baseQty,
      unitCost: baseQty > 0 ? restored.totalCostRestored / baseQty : 0,
      totalCost: restored.totalCostRestored,
      batchAllocations: restored.restoredAllocations,
      reason: reason || null,
    });
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
    (oi: any) => Number(oi.returnedQuantity || 0) >= Number(oi.quantity)
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
      createdAt: ctx.now,
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
    date: ctx.now,
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

  if (totalCostReversed > 0) {
    postJournalEntry(tx, {
      date: ctx.now,
      referenceId: returnId,
      referenceType: 'return',
      description: `عكس تكلفة مرتجع ${retNum}`,
      lines: [
        { accountCode: '1200', debit: totalCostReversed, credit: 0, orderId: originalOrderId, returnId },
        { accountCode: '5100', debit: 0, credit: totalCostReversed, orderId: originalOrderId, returnId },
      ],
      createdBy: ctx.actor,
      branchId: branchId ?? origOrder.branchId,
    });
  }

  tx.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      date: ctx.now,
      type: 'return',
      userName: ctx.actor,
      action: 'مرتجع',
      operationName: 'مرتجع مبيعات',
      details: `مرتجع ${retNum} على الفاتورة ${origOrder.receiptNumber} (${reason || 'بدون سبب'})`,
      quantity: savedReturnItems.reduce((s, i) => s + Number(i.quantity), 0),
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
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
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
    const factor = Number(oi.conversionToBase ?? oi.conversionFactor ?? 1);
    const baseQty = getHistoricalBaseQuantity(oi, Number(oi.quantity || 0));
    if (baseQty <= 0) continue;

    let allocations: BatchAllocation[] = [];
    try {
      allocations = oi.batchAllocations ? JSON.parse(oi.batchAllocations) : [];
    } catch {}
    const baseCostFallback =
      factor > 0 ? Number(oi.costPriceAtTimeOfSale || 0) / factor : Number(oi.costPriceAtTimeOfSale || 0);

    const restored = restoreInventoryFIFO(tx, {
      productId: Number(oi.productId),
      quantityInBaseUnits: baseQty,
      allocations,
      fallbackCost: baseCostFallback,
      branchId: origOrder.branchId,
      batchIdPrefix: `void-${targetOrderId}-${oi.id}`,
    });
    appendInventoryMovement(tx, ctx, {
      productId: Number(oi.productId),
      branchId: origOrder.branchId ?? null,
      movementType: 'sale_void',
      sourceType: 'order_void',
      sourceId: targetOrderId,
      sourceLineId: oi.id,
      inputQuantity: Number(oi.quantity || 0),
      unitCode: oi.unitCode || null,
      baseUnitCode: oi.baseUnitCode || null,
      conversionToBase: factor,
      quantityDeltaBase: baseQty,
      unitCost: baseQty > 0 ? restored.totalCostRestored / baseQty : 0,
      totalCost: restored.totalCostRestored,
      batchAllocations: restored.restoredAllocations,
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
      quantity: origItems.reduce((s: number, i: any) => s + Number(i.quantity || 0), 0),
      value: Number(origOrder.netAmount || 0),
      branchId: origOrder.branchId || null,
      entityId: targetOrderId,
      entityName: origOrder.receiptNumber,
    })
    .run();

  const updatedOrder = tx.select().from(orders).where(eq(orders.id, targetOrderId)).get();
  return { order: updatedOrder };
}

function resolvePurchaseCurrencySnapshot(tx: any, currencyCodeInput: unknown, purchaseDate: string, exchangeRateIdInput?: unknown) {
  if (currencyCodeInput == null || String(currencyCodeInput).trim() === '') {
    // Backward compatibility: legacy purchases retain their existing base-currency semantics.
    return null;
  }

  const currencyCode = String(currencyCodeInput).trim().toUpperCase();
  const [baseSetting] = tx.select().from(settings).where(eq(settings.key, 'baseCurrencyCode')).all();
  const baseCurrencyCode = String(baseSetting?.value || '').trim().toUpperCase();
  if (!baseCurrencyCode) {
    throw new OperationError('يجب تعيين العملة الأساسية قبل تسجيل فاتورة بعملة أجنبية', 400);
  }

  const currency = tx.select().from(currencies).where(eq(currencies.code, currencyCode)).get();
  const baseCurrency = tx.select().from(currencies).where(eq(currencies.code, baseCurrencyCode)).get();
  if (!currency || !currency.isActive || !baseCurrency || !baseCurrency.isActive) {
    throw new OperationError('عملة الفاتورة أو العملة الأساسية غير مسجلة أو غير نشطة', 400);
  }

  if (currencyCode === baseCurrencyCode) {
    return { currencyCode, baseCurrencyCode, exchangeRate: 1, exchangeRateId: null };
  }

  const purchaseTimestamp = new Date(`${purchaseDate.slice(0, 10)}T23:59:59.999Z`).getTime();
  const matchesPairAndDate = (rate: any) => {
    if (!rate?.approvedAt || !Number.isFinite(Number(rate.rate)) || Number(rate.rate) <= 0) return false;
    const effectiveTimestamp = new Date(rate.effectiveAt).getTime();
    if (!Number.isFinite(effectiveTimestamp) || effectiveTimestamp > purchaseTimestamp) return false;
    return (
      (rate.baseCurrencyCode === currencyCode && rate.quoteCurrencyCode === baseCurrencyCode) ||
      (rate.baseCurrencyCode === baseCurrencyCode && rate.quoteCurrencyCode === currencyCode)
    );
  };

  let selectedRate: any;
  if (exchangeRateIdInput) {
    selectedRate = tx.select().from(exchangeRates).where(eq(exchangeRates.id, String(exchangeRateIdInput))).get();
    if (!matchesPairAndDate(selectedRate)) {
      throw new OperationError('سعر الصرف المحدد غير معتمد أو لا يطابق العملات أو تاريخ الفاتورة', 400);
    }
  } else {
    const eligibleRates = tx.select().from(exchangeRates).all().filter(matchesPairAndDate)
      .sort((a: any, b: any) => {
        const effective = new Date(b.effectiveAt).getTime() - new Date(a.effectiveAt).getTime();
        return effective || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    selectedRate = eligibleRates[0];
  }
  if (!selectedRate) {
    throw new OperationError('لا يوجد سعر صرف معتمد وساري بتاريخ فاتورة الشراء لهذه العملات', 400);
  }

  let basePerDocumentUnit: number;
  try {
    basePerDocumentUnit = getBasePerDocumentUnit(selectedRate, currencyCode, baseCurrencyCode);
  } catch {
    throw new OperationError('سعر الصرف المعتمد غير صالح أو لا يطابق زوج العملات', 400);
  }

  return {
    currencyCode,
    baseCurrencyCode,
    exchangeRate: Math.round(basePerDocumentUnit * 1e10) / 1e10,
    exchangeRateId: selectedRate.id,
  };
}

function handlePurchaseCreate(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
) {
  const { purchase, items = [] } = payload;
  if (!purchase || !purchase.id) {
    throw new OperationError('Invalid purchase payload', 400);
  }

  const purchaseDate = purchase.date ? new Date(purchase.date).toISOString() : ctx.now;
  const currencySnapshot = resolvePurchaseCurrencySnapshot(tx, purchase.currencyCode, purchaseDate, purchase.exchangeRateId);
  const rawOriginalTotalAmount = Number(purchase.totalAmount ?? 0);
  const rawOriginalPaidAmount = Number(purchase.paidAmount ?? 0);
  if (currencySnapshot && (!Number.isFinite(rawOriginalTotalAmount) || rawOriginalTotalAmount < 0 || !Number.isFinite(rawOriginalPaidAmount) || rawOriginalPaidAmount < 0)) {
    throw new OperationError('إجمالي الفاتورة والمدفوع يجب أن يكونا أرقاماً موجبة أو صفراً', 400);
  }
  const originalTotalAmount = roundMoney(rawOriginalTotalAmount);
  const originalPaidAmount = roundMoney(rawOriginalPaidAmount);
  const conversionRate = currencySnapshot?.exchangeRate ?? 1;
  const totalAmount = roundMoney(originalTotalAmount * conversionRate);
  const paidAmount = roundMoney(originalPaidAmount * conversionRate);
  if (currencySnapshot && originalPaidAmount > originalTotalAmount + 0.01) {
    throw new OperationError('المبلغ المدفوع لا يمكن أن يتجاوز إجمالي فاتورة الشراء', 400);
  }
  const paymentMethod = purchase.paymentMethod === 'card' ? 'card' : 'cash';
  const remaining = roundMoney(totalAmount - paidAmount);
  const paymentStatus = remaining <= 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';

  const savedPurchase = tx
    .insert(purchases)
    .values({
      id: purchase.id,
      supplierId: purchase.supplierId || null,
      supplierName: purchase.supplierName || null,
      totalAmount,
      currencyCode: currencySnapshot?.currencyCode || null,
      baseCurrencyCode: currencySnapshot?.baseCurrencyCode || null,
      exchangeRate: currencySnapshot?.exchangeRate ?? null,
      exchangeRateId: currencySnapshot?.exchangeRateId || null,
      originalTotalAmount: currencySnapshot ? originalTotalAmount : null,
      originalPaidAmount: currencySnapshot ? originalPaidAmount : null,
      paidAmount,
      returnedAmount: 0,
      paymentStatus,
      paymentMethod,
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

  const savedItems: any[] = [];
  for (const item of items) {
    const qty = Number(item.quantity || 0);
    const originalCost = Number(item.costPrice || 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new OperationError('كمية الشراء يجب أن تكون رقماً موجباً', 400);
    }
    if (!Number.isFinite(originalCost) || originalCost < 0) {
      throw new OperationError('تكلفة الصنف في فاتورة الشراء غير صالحة', 400);
    }
    const unitSnapshot = resolveMovementUnit(tx, Number(item.productId), item, qty);
    const factor = unitSnapshot.conversionToBase;
    const baseQty = unitSnapshot.baseQuantity;
    const cost = roundMoney(originalCost * conversionRate);
    // Keep fractional base-unit cost precision so multiplying by the conversion factor
    // reproduces the entered purchase-unit cost without rounding loss.
    const baseUnitCost = factor > 0 ? cost / factor : cost;

    const pItem = tx
      .insert(purchaseItems)
      .values({
        purchaseId: purchase.id,
        productId: Number(item.productId),
        productName: item.productName,
        quantity: qty,
        costPrice: cost,
        unitCode: unitSnapshot.unitCode,
        baseUnitCode: unitSnapshot.baseUnitCode,
        conversionToBase: factor,
        baseQuantity: baseQty,
        originalCostPrice: currencySnapshot ? originalCost : null,
        originalTotal: currencySnapshot ? roundMoney(qty * originalCost) : null,
        currencyCode: currencySnapshot?.currencyCode || null,
        exchangeRate: currencySnapshot?.exchangeRate ?? null,
        exchangeRateId: currencySnapshot?.exchangeRateId || null,
        total: roundMoney(qty * cost),
        isSynced: 0,
        createdAt: ctx.now,
      })
      .returning()
      .get();
    savedItems.push(pItem);

    const batchId = item.batchId ? String(item.batchId) : crypto.randomUUID();
    tx.insert(inventoryBatches)
      .values({
        id: batchId,
        productId: Number(item.productId),
        purchaseId: purchase.id,
        quantity: baseQty,
        remainingQuantity: baseQty,
        costPrice: baseUnitCost,
        originalCostPrice: currencySnapshot ? originalCost / factor : null,
        unitCode: unitSnapshot.unitCode,
        baseUnitCode: unitSnapshot.baseUnitCode,
        conversionToBase: factor,
        baseQuantity: baseQty,
        currencyCode: currencySnapshot?.currencyCode || null,
        exchangeRate: currencySnapshot?.exchangeRate ?? null,
        exchangeRateId: currencySnapshot?.exchangeRateId || null,
        purchaseDate,
        branchId: purchase.branchId || null,
        isSynced: 0,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();

    appendInventoryMovement(tx, ctx, {
      productId: Number(item.productId),
      branchId: purchase.branchId || null,
      movementType: 'purchase_receipt',
      sourceType: 'purchase',
      sourceId: String(purchase.id),
      sourceLineId: pItem.id,
      inputQuantity: qty,
      unitCode: unitSnapshot.unitCode,
      baseUnitCode: unitSnapshot.baseUnitCode,
      conversionToBase: factor,
      quantityDeltaBase: baseQty,
      unitCost: baseUnitCost,
      totalCost: baseQty * baseUnitCost,
      batchAllocations: [{ batchId, quantity: baseQty, costPrice: baseUnitCost }],
    });

    tx.update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} + ${baseQty}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(products.id, Number(item.productId)))
      .run();

    recalculateProductWeightedCost(tx, Number(item.productId));
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

  if (totalAmount > 0) {
    postJournalEntry(tx, {
      date: purchaseDate,
      referenceId: purchase.id,
      referenceType: 'purchase',
      description: `فاتورة مشتريات من المورد: ${purchase.supplierName || ''}`,
      lines: [
        { accountCode: '1200', debit: totalAmount, credit: 0, purchaseId: purchase.id },
        { accountCode: '2100', debit: 0, credit: totalAmount, purchaseId: purchase.id },
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
      quantity: savedItems.reduce((s, i) => s + Number(i.quantity), 0),
      value: totalAmount,
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
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
) {
  const purchaseId = String(payload.id);
  const existing = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
  if (!existing) {
    return { deleted: purchaseId, notFound: true };
  }

  assertPurchaseMutable(tx, purchaseId);

  const oldItems = tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)).all();
  const oldBatches = tx.select().from(inventoryBatches)
    .where(eq(inventoryBatches.purchaseId, purchaseId))
    .all();
  if (oldBatches.length > 0) {
    for (const batch of oldBatches) {
      const baseQty = Number(batch.remainingQuantity ?? batch.quantity ?? 0);
      appendInventoryMovement(tx, ctx, {
        productId: Number(batch.productId),
        branchId: batch.branchId ?? existing.branchId ?? null,
        movementType: 'purchase_reversal',
        sourceType: 'purchase',
        sourceId: purchaseId,
        sourceLineId: batch.id,
        inputQuantity: baseQty,
        unitCode: batch.unitCode || null,
        baseUnitCode: batch.baseUnitCode || null,
        conversionToBase: Number(batch.conversionToBase || 1),
        quantityDeltaBase: -baseQty,
        unitCost: Number(batch.costPrice || 0),
        totalCost: baseQty * Number(batch.costPrice || 0),
        batchAllocations: [{ batchId: batch.id, quantity: baseQty, costPrice: Number(batch.costPrice || 0) }],
        reason: 'purchase_delete_or_update',
      });
    }
  } else {
    for (const item of oldItems) {
      const baseQty = Number(item.baseQuantity ?? (Number(item.quantity || 0) * Number(item.conversionToBase || 1)));
      const factor = Number(item.conversionToBase || 1);
      const unitCost = factor > 0 ? Number(item.costPrice || 0) / factor : Number(item.costPrice || 0);
      appendInventoryMovement(tx, ctx, {
        productId: Number(item.productId),
        branchId: existing.branchId ?? null,
        movementType: 'purchase_reversal',
        sourceType: 'purchase',
        sourceId: purchaseId,
        sourceLineId: item.id,
        inputQuantity: Number(item.quantity || 0),
        unitCode: item.unitCode || null,
        baseUnitCode: item.baseUnitCode || null,
        conversionToBase: factor,
        quantityDeltaBase: -baseQty,
        unitCost,
        totalCost: baseQty * unitCost,
        reason: 'legacy_purchase_without_batch',
      });
    }
  }

  for (const item of oldItems) {
    const baseQty = Number(item.baseQuantity ?? (Number(item.quantity || 0) * Number(item.conversionToBase || 1)));
    tx.update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${baseQty}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(products.id, item.productId))
      .run();
  }

  tx.delete(inventoryBatches).where(eq(inventoryBatches.purchaseId, purchaseId)).run();
  for (const item of oldItems) {
    recalculateProductWeightedCost(tx, item.productId);
  }

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

  tx.delete(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)).run();
  tx.delete(purchases).where(eq(purchases.id, purchaseId)).run();

  return { deleted: purchaseId };
}

function handlePurchaseUpdate(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
) {
  const { purchase } = payload;
  handlePurchaseDelete(tx, { id: purchase.id }, ctx);
  return handlePurchaseCreate(tx, payload, ctx);
}

function handlePurchaseReturn(
  tx: any,
  payload: any,
  ctx: { operationId: string; deviceId: string; actor: string; now: string }
) {
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
    if (!Number.isFinite(qtyToReturn) || qtyToReturn <= 0) {
      throw new OperationError('كمية مرتجع المشتريات يجب أن تكون رقماً موجباً', 400);
    }
    const prodId = Number(reqItem.productId);

    const matchingBatch = reqItem.batchId
      ? purchaseBatches.find((b: any) => b.id === String(reqItem.batchId) && b.productId === prodId)
      : purchaseBatches.find((b: any) =>
          b.productId === prodId &&
          (!reqItem.unitCode || b.unitCode === reqItem.unitCode) &&
          Number(b.remainingQuantity ?? b.quantity ?? 0) >= qtyToReturn * Number(b.conversionToBase || 1)
        ) || purchaseBatches.find((b: any) =>
          b.productId === prodId && (!reqItem.unitCode || b.unitCode === reqItem.unitCode)
        );
    if ((reqItem.batchId && !matchingBatch) ||
        (reqItem.unitCode && (!matchingBatch || matchingBatch.unitCode !== reqItem.unitCode))) {
      throw new OperationError('لا يمكن إرجاع وحدة شراء دون العثور على دفعتها الأصلية المطابقة', 409);
    }
    const unitCode = matchingBatch?.unitCode || null;
    if (unitCode) {
      const unitDefinition = tx.select().from(unitDefinitions)
        .where(eq(unitDefinitions.code, unitCode)).get();
      if (!unitDefinition || !unitDefinition.isActive) {
        throw new OperationError('تعريف وحدة مرتجع المشتريات غير متاح', 409);
      }
      const precision = Math.max(0, Math.min(6, Number(unitDefinition.decimalPlaces || 0)));
      const scale = 10 ** precision;
      if (Math.abs(qtyToReturn * scale - Math.round(qtyToReturn * scale)) > 1e-7) {
        throw new OperationError('كمية مرتجع المشتريات لا تتوافق مع دقة وحدة الشراء الأصلية', 400);
      }
    }
    const factor = Number(matchingBatch?.conversionToBase || 1);
    const baseQty = qtyToReturn * factor;

    if (matchingBatch) {
      if (Number(matchingBatch.remainingQuantity ?? matchingBatch.quantity ?? 0) < baseQty) {
        throw new OperationError(
          `الكمية المتبقية في دفعة المنتج ${reqItem.productName} (${matchingBatch.remainingQuantity}) أقل من كمية المرتجع (${qtyToReturn})`,
          400
        );
      }
      tx.update(inventoryBatches)
        .set({
          remainingQuantity: Number(matchingBatch.remainingQuantity ?? matchingBatch.quantity ?? 0) - baseQty,
          updatedAt: ctx.now,
          isSynced: 0,
        })
        .where(eq(inventoryBatches.id, matchingBatch.id))
        .run();
      matchingBatch.remainingQuantity = Number(matchingBatch.remainingQuantity ?? matchingBatch.quantity ?? 0) - baseQty;
    } else {
      const product = tx.select().from(products).where(eq(products.id, prodId)).get();
      if (!product || Number(product.stockQuantity || 0) < baseQty) {
        throw new OperationError(`المخزون المتاح لا يكفي لإرجاع المنتج ${reqItem.productName}`, 400);
      }
    }

    tx.update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${baseQty}`,
        updatedAt: ctx.now,
        isSynced: 0,
      })
      .where(eq(products.id, prodId))
      .run();

    recalculateProductWeightedCost(tx, prodId);

    const sourcePurchaseItems = tx.select().from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, String(originalPurchaseId))).all();
    const sourceItem = sourcePurchaseItems.find((row: any) =>
      row.productId === prodId && (!matchingBatch?.unitCode || row.unitCode === matchingBatch.unitCode)
    );
    const cost = matchingBatch
      ? Number(matchingBatch.costPrice || 0) * factor
      : Number(sourceItem?.costPrice ?? reqItem.costPrice ?? 0);
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
        unitCode: matchingBatch?.unitCode || null,
        baseUnitCode: matchingBatch?.baseUnitCode || null,
        conversionToBase: factor,
        baseQuantity: baseQty,
        batchId: matchingBatch?.id || null,
        isSynced: 0,
        createdAt: ctx.now,
      })
      .returning()
      .get();

    savedItems.push(insertedItem);
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
    branchId,
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
      ...(rawId && Number(rawId) < 1000000 ? { id: Number(rawId) } : {}),
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
  const requestedApprovalTime = payload?.approvedAt ? new Date(payload.approvedAt) : new Date(ctx.now);
  const approvedAt = Number.isNaN(requestedApprovalTime.getTime())
    ? ctx.now
    : requestedApprovalTime.toISOString();

  // Include session and entry snapshots so an offline terminal can synchronize
  // and approve a stocktake without a separate table-push round trip.
  const existingSession = tx.select().from(stocktakingSessions)
    .where(eq(stocktakingSessions.id, sessionId)).get();
  if (existingSession?.status === 'approved') {
    return { session: existingSession, alreadyApproved: true };
  }
  if (!existingSession && payload?.session && String(payload.session.id) === String(sessionId)) {
    const { syncStatus: _sessionSyncStatus, updatedAt: _sessionUpdatedAt, ...sessionData } = payload.session;
    tx.insert(stocktakingSessions).values({
        ...sessionData,
        isSynced: 0,
        createdAt: sessionData.createdAt || approvedAt,
    }).run();
  }
  if (Array.isArray(payload?.entries)) {
    for (const entry of payload.entries) {
      if (!entry || String(entry.sessionId) !== String(sessionId) || entry.id == null) continue;
      const { syncStatus: _entrySyncStatus, updatedAt: _entryUpdatedAt, createdAt: _entryCreatedAt, ...entryData } = entry;
      const existingEntry = tx.select().from(stocktakingEntries)
        .where(eq(stocktakingEntries.id, entry.id)).get();
      if (existingEntry) {
        tx.update(stocktakingEntries)
          .set({ ...entryData, isSynced: 0 })
          .where(eq(stocktakingEntries.id, entry.id))
          .run();
      } else {
        tx.insert(stocktakingEntries).values({
          ...entryData,
          isSynced: 0,
        }).run();
      }
    }
  }

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

  let netAdjustmentValue = 0;

  for (const entry of entries) {
    const product = tx.select().from(products).where(eq(products.id, entry.productId)).get();
    if (!product) continue;

    if (entry.unitCode) {
      const definition = tx.select().from(unitDefinitions).where(eq(unitDefinitions.code, entry.unitCode)).get();
      if (!definition || !definition.isActive ||
          (entry.baseUnitCode && entry.baseUnitCode !== entry.unitCode) ||
          (entry.baseUnitCode && entry.baseUnitCode !== product.baseUnitCode)) {
        throw new OperationError('وحدة الجرد لا تطابق وحدة الأساس الحالية للصنف', 409);
      }
      const precision = Math.max(0, Math.min(6, Number(definition.decimalPlaces || 0)));
      const scale = 10 ** precision;
      if (Math.abs(Number(entry.actualQuantity) * scale - Math.round(Number(entry.actualQuantity) * scale)) > 1e-7) {
        throw new OperationError(`كمية الجرد للصنف ${product.name} لا تتوافق مع دقة وحدة الأساس`, 400);
      }
    }

    const actualBaseQuantity = Number(entry.actualQuantity);
    if (!Number.isFinite(actualBaseQuantity) || actualBaseQuantity < 0) {
      throw new OperationError(`كمية الجرد للصنف ${product.name} غير صالحة`, 400);
    }
    const diff = actualBaseQuantity - Number(product.stockQuantity);
    if (diff === 0) continue;

    if (diff > 0) {
      const unitCost = Number(product.costPrice || 0);
      tx.insert(inventoryBatches)
        .values({
          id: `stocktake-${sessionId}-${product.id}`,
          productId: product.id,
          purchaseId: null,
          quantity: diff,
          remainingQuantity: diff,
          costPrice: unitCost,
          unitCode: entry.unitCode || product.baseUnitCode || null,
          baseUnitCode: entry.baseUnitCode || product.baseUnitCode || null,
          conversionToBase: 1,
          baseQuantity: diff,
          purchaseDate: approvedAt,
          branchId: session.branchId || null,
          isSynced: 0,
          createdAt: approvedAt,
          updatedAt: approvedAt,
        })
        .run();
      tx.update(products)
        .set({ stockQuantity: Number(entry.actualQuantity), updatedAt: approvedAt, isSynced: 0 })
        .where(eq(products.id, product.id))
        .run();
      netAdjustmentValue = roundMoney(netAdjustmentValue + diff * unitCost);
    } else {
      const fifo = consumeInventoryFIFO(tx, {
        productId: product.id,
        quantityInBaseUnits: Math.abs(diff),
        operationId: ctx.operationId,
        deviceId: ctx.deviceId,
        productName: product.name,
        allowNegative: true,
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
      date: approvedAt,
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
      date: approvedAt,
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

  if (tableName === 'products') {
    const productData: any = { ...clean };
    const existingProduct = productData.id
      ? tx.select().from(products).where(eq(products.id, Number(productData.id))).get()
      : null;
    if (existingProduct) {
      // Stock is changed only by stock movements/stocktaking, never by a stale
      // product form or a background entity sync.
      delete productData.stockQuantity;
      delete productData.baseUnitCode;
      delete productData.quantityPrecision;
      const existingBatch = tx.select({ id: inventoryBatches.id })
        .from(inventoryBatches).where(eq(inventoryBatches.productId, existingProduct.id)).limit(1).get();
      if (existingBatch) delete productData.costPrice;
      const updatedProduct = tx.update(products)
        .set({ ...productData, isSynced: 0, updatedAt: now })
        .where(eq(products.id, existingProduct.id))
        .returning()
        .get();
      if (!existingBatch && Number(updatedProduct.stockQuantity || 0) > 0) {
        tx.insert(inventoryBatches).values({
          id: `opening-${updatedProduct.id}`,
          productId: updatedProduct.id,
          purchaseId: null,
          quantity: Number(updatedProduct.stockQuantity),
          remainingQuantity: Number(updatedProduct.stockQuantity),
          costPrice: Number(updatedProduct.costPrice || 0),
          unitCode: updatedProduct.baseUnitCode || null,
          baseUnitCode: updatedProduct.baseUnitCode || null,
          conversionToBase: 1,
          baseQuantity: Number(updatedProduct.stockQuantity),
          purchaseDate: updatedProduct.createdAt || now,
          branchId: updatedProduct.branchId || null,
          isSynced: 0,
          createdAt: updatedProduct.createdAt || now,
          updatedAt: now,
        }).run();
      }
      return updatedProduct;
    }
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

  // Handle auto-increment integer tables where offline client generated a timestamp temp ID (>= 1000000)
  const autoIncTables = new Set(['products', 'categories', 'customers', 'suppliers', 'expenses']);
  let savedRecord: any;

  const existingRecord = clean.id !== undefined && clean.id !== null
    ? tx.select().from(table).where(eq(table.id, clean.id)).get()
    : null;

  if (existingRecord) {
    // A client may create and then edit the same temporary-ID entity while
    // offline. Update that row instead of attempting a second primary-key insert.
    const updateData: any = { ...clean };
    delete updateData.createdAt;
    if (tableName === 'customers') {
      // Customer balances and loyalty points are derived from sales/payments.
      // A stale terminal's entity snapshot must never overwrite them.
      delete updateData.balance;
      delete updateData.points;
    } else if (tableName === 'suppliers') {
      // Supplier balance is derived from purchases and supplier payments.
      delete updateData.balance;
    }
    savedRecord = tx
      .update(table)
      .set({ ...updateData, isSynced: 0, updatedAt: now })
      .where(eq(table.id, existingRecord.id))
      .returning()
      .get();
  } else if (autoIncTables.has(tableName) && clean.id && Number(clean.id) >= 1000000) {
    // Keep the client-generated numeric ID so later offline operations can
    // reference the same product/customer/category without remapping.
    savedRecord = tx
      .insert(table)
      .values({ ...clean, id: Number(clean.id), isSynced: 0, createdAt: clean.createdAt || now, updatedAt: clean.updatedAt || now })
      .returning()
      .get();
  } else {
    savedRecord = tx
      .insert(table)
      .values({ ...clean, isSynced: 0, createdAt: clean.createdAt || now, updatedAt: clean.updatedAt || now })
      .onConflictDoUpdate({
        target: table.id,
        set: { ...clean, isSynced: 0, updatedAt: now },
      })
      .returning()
      .get();
  }

  if (tableName === 'products' && savedRecord && Number(savedRecord.stockQuantity) > 0) {
    const existingBatches = tx
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.productId, savedRecord.id))
      .all();
    if (existingBatches.length === 0) {
      tx.insert(inventoryBatches)
        .values({
          id: `opening-${savedRecord.id}`,
          productId: savedRecord.id,
          purchaseId: null,
          quantity: Number(savedRecord.stockQuantity),
          remainingQuantity: Number(savedRecord.stockQuantity),
          costPrice: Number(savedRecord.costPrice || 0),
          unitCode: savedRecord.baseUnitCode || null,
          baseUnitCode: savedRecord.baseUnitCode || null,
          conversionToBase: 1,
          baseQuantity: Number(savedRecord.stockQuantity),
          purchaseDate: savedRecord.createdAt || now,
          branchId: savedRecord.branchId || null,
          isSynced: 0,
          createdAt: savedRecord.createdAt || now,
          updatedAt: now,
        })
        .run();
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
