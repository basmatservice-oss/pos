import crypto from 'crypto';
import { eq, and, gt, asc, sql } from 'drizzle-orm';
import {
  accounts,
  journalEntries,
  transactions,
  inventoryBatches,
  inventoryAlerts,
  inventoryMovements,
  products,
} from '../drizzle/schema.js';

export class AccountingError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const SYSTEM_ACCOUNTS = [
  { code: '1010', name: 'الصندوق', type: 'asset' },
  { code: '1020', name: 'البنك / الشبكة', type: 'asset' },
  { code: '1100', name: 'ذمم العملاء', type: 'asset' },
  { code: '1200', name: 'المخزون', type: 'asset' },
  { code: '2100', name: 'ذمم الموردين', type: 'liability' },
  { code: '2200', name: 'ضريبة القيمة المضافة المستحقة', type: 'liability' },
  { code: '3100', name: 'رأس المال والأرصدة الافتتاحية', type: 'equity' },
  { code: '3200', name: 'الأرباح المحتجزة', type: 'equity' },
  { code: '4100', name: 'المبيعات', type: 'revenue' },
  { code: '4200', name: 'مرتجعات المبيعات', type: 'revenue' },
  { code: '4300', name: 'خصومات مسموحة', type: 'revenue' },
  { code: '5100', name: 'تكلفة البضاعة المباعة', type: 'expense' },
  { code: '5200', name: 'المصروفات التشغيلية', type: 'expense' },
  { code: '5300', name: 'الرواتب والأجور', type: 'expense' },
  { code: '5400', name: 'تسويات الجرد', type: 'expense' },
] as const;

export const ACCOUNT_NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  SYSTEM_ACCOUNTS.map((a) => [a.code, a.name])
);

export function ensureChartOfAccounts(dbOrTx: any) {
  const now = new Date().toISOString();
  for (const acc of SYSTEM_ACCOUNTS) {
    dbOrTx
      .insert(accounts)
      .values({
        code: acc.code,
        name: acc.name,
        type: acc.type,
        balance: 0,
        isSystem: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run?.();
  }
}

export async function ensureChartOfAccountsAsync(dbInstance: any) {
  const now = new Date().toISOString();
  for (const acc of SYSTEM_ACCOUNTS) {
    await dbInstance
      .insert(accounts)
      .values({
        code: acc.code,
        name: acc.name,
        type: acc.type,
        balance: 0,
        isSystem: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

export interface JournalLineInput {
  accountCode: string;
  accountName?: string;
  debit: number;
  credit: number;
  description?: string;
  orderId?: string;
  purchaseId?: string;
  returnId?: string;
}

export interface PostJournalEntryInput {
  id?: string;
  date?: string;
  referenceId: string;
  referenceType:
    | 'order'
    | 'purchase'
    | 'purchase_return'
    | 'expense'
    | 'payment'
    | 'return'
    | 'payroll'
    | 'stocktake'
    | 'shift_movement'
    | 'opening';
  description: string;
  lines: JournalLineInput[];
  createdBy?: string;
  branchId?: number;
}

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function postJournalEntry(tx: any, input: PostJournalEntryInput) {
  const validLines = input.lines
    .map((l) => ({
      ...l,
      debit: roundMoney(l.debit),
      credit: roundMoney(l.credit),
    }))
    .filter((l) => l.debit > 0 || l.credit > 0);

  if (validLines.length === 0) {
    return null;
  }

  const totalDebit = roundMoney(validLines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = roundMoney(validLines.reduce((s, l) => s + l.credit, 0));

  if (Math.abs(totalDebit - totalCredit) > 0.02) {
    throw new AccountingError(
      `Unbalanced journal entry (${input.description}): debit=${totalDebit}, credit=${totalCredit}`,
      400
    );
  }

  // Adjust tiny 0.01-0.02 rounding diff on last line if needed
  const diff = roundMoney(totalDebit - totalCredit);
  if (diff !== 0 && validLines.length > 0) {
    const last = validLines[validLines.length - 1];
    if (last.credit > 0) {
      last.credit = roundMoney(last.credit + diff);
    } else {
      last.debit = roundMoney(last.debit - diff);
    }
  }

  const entryId = input.id || crypto.randomUUID();
  const now = input.date || new Date().toISOString();
  const entryNumber = `JE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  tx.insert(journalEntries)
    .values({
      id: entryId,
      entryNumber,
      date: now,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      description: input.description,
      totalDebit: roundMoney(validLines.reduce((s, l) => s + l.debit, 0)),
      totalCredit: roundMoney(validLines.reduce((s, l) => s + l.credit, 0)),
      status: 'posted',
      createdBy: input.createdBy || 'System',
      branchId: input.branchId,
      isSynced: 0,
      createdAt: now,
    })
    .run();

  for (const line of validLines) {
    const accountName = line.accountName || ACCOUNT_NAME_BY_CODE[line.accountCode] || line.accountCode;
    const isDebit = line.debit > 0;
    const amount = isDebit ? line.debit : line.credit;

    tx.insert(transactions)
      .values({
        id: crypto.randomUUID(),
        journalEntryId: entryId,
        accountId: line.accountCode,
        accountName,
        type: isDebit ? 'debit' : 'credit',
        amount,
        debit: line.debit,
        credit: line.credit,
        description: line.description || input.description,
        orderId: line.orderId,
        purchaseId: line.purchaseId,
        returnId: line.returnId,
        isSynced: 0,
        createdAt: now,
      })
      .run();

    // Update account balance according to account type
    const acc = tx.select().from(accounts).where(eq(accounts.code, line.accountCode)).get();
    if (acc) {
      const normalDebit = acc.type === 'asset' || acc.type === 'expense';
      const delta = normalDebit ? line.debit - line.credit : line.credit - line.debit;
      tx.update(accounts)
        .set({
          balance: roundMoney((acc.balance || 0) + delta),
          updatedAt: now,
        })
        .where(eq(accounts.code, line.accountCode))
        .run();
    }
  }

  return entryId;
}

export function reverseJournalEntriesByReference(
  tx: any,
  referenceId: string,
  reason: string,
  createdBy?: string
) {
  const allEntries = tx
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.referenceId, referenceId))
    .all();
  const reversalEntryIds = new Set(allEntries.map((entry: any) => entry.reversedEntryId).filter(Boolean).map(String));
  const entries = allEntries.filter((entry: any) => entry.status === 'posted' && !reversalEntryIds.has(String(entry.id)));

  for (const entry of entries) {
    const lines = tx
      .select()
      .from(transactions)
      .where(eq(transactions.journalEntryId, entry.id))
      .all();

    if (lines.length === 0) continue;

    const reversedLines: JournalLineInput[] = lines.map((l: any) => ({
      accountCode: l.accountId,
      accountName: l.accountName,
      debit: Number(l.credit || 0),
      credit: Number(l.debit || 0),
      description: `عكس: ${l.description || entry.description} (${reason})`,
      orderId: l.orderId,
      purchaseId: l.purchaseId,
      returnId: l.returnId,
    }));

    const reversalId = postJournalEntry(tx, {
      referenceId,
      referenceType: (entry.referenceType as any) || 'payment',
      description: `قيد عكسي - ${entry.description} (${reason})`,
      lines: reversedLines,
      createdBy: createdBy || 'System',
      branchId: entry.branchId,
    });

    tx.update(journalEntries)
      .set({
        status: 'reversed',
        reversedEntryId: reversalId,
      })
      .where(eq(journalEntries.id, entry.id))
      .run();
  }
}

export interface BatchAllocation {
  batchId: string | null;
  quantity: number;
  costPrice: number;
}

function roundQty(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

export interface RecordInventoryMovementInput {
  movementKey: string;
  productId: number;
  movementType: string;
  sourceType: string;
  sourceId: string;
  quantityDeltaBase: number;
  baseUnitCode?: string | null;
  unitCost?: number;
  totalCost?: number;
  branchId?: number | null;
  operationId?: string | null;
  reason?: string | null;
  createdBy?: string | null;
  createdAt?: string;
}

export function recordInventoryMovement(tx: any, input: RecordInventoryMovementInput) {
  const delta = roundQty(input.quantityDeltaBase);
  if (Math.abs(delta) < 1e-6) return null;

  let baseUnitCode = input.baseUnitCode || null;
  if (!baseUnitCode) {
    const prod = tx.select().from(products).where(eq(products.id, input.productId)).get?.();
    baseUnitCode = prod?.baseUnitCode || prod?.unit || 'piece';
  }

  const unitCost =
    input.unitCost !== undefined
      ? Math.round((Number(input.unitCost) || 0) * 10000) / 10000
      : 0;
  const totalCost =
    input.totalCost !== undefined
      ? roundMoney(Number(input.totalCost))
      : roundMoney(Math.abs(delta) * unitCost);
  const now = input.createdAt || new Date().toISOString();

  tx.insert(inventoryMovements)
    .values({
      id: crypto.randomUUID(),
      movementKey: input.movementKey,
      productId: Number(input.productId),
      movementType: input.movementType,
      sourceType: input.sourceType,
      sourceId: String(input.sourceId),
      quantityDeltaBase: delta,
      baseUnitCode,
      unitCost,
      totalCost,
      branchId: input.branchId ?? null,
      operationId: input.operationId ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? 'System',
      isSynced: 0,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run?.();

  return input.movementKey;
}

export function consumeInventoryFIFO(
  tx: any,
  params: {
    productId: number;
    quantityInBaseUnits: number;
    operationId?: string;
    deviceId?: string;
    productName?: string;
    allowNegative?: boolean;
    valuationMethod?: 'fifo' | 'weighted_average';
    movementType?: string;
    sourceType?: string;
    sourceId?: string;
    movementKeySuffix?: string;
    branchId?: number | null;
    reason?: string | null;
    createdBy?: string | null;
    createdAt?: string;
  }
): { totalCost: number; averageUnitCost: number; allocations: BatchAllocation[] } {
  const {
    productId,
    quantityInBaseUnits,
    operationId,
    deviceId,
    allowNegative = true,
    valuationMethod = 'fifo',
  } = params;
  const qtyNeeded = roundQty(quantityInBaseUnits);
  const now = params.createdAt || new Date().toISOString();

  const product = tx.select().from(products).where(eq(products.id, productId)).get();
  if (!product) {
    throw new AccountingError(`Product ${productId} not found`, 404);
  }

  const prevQty = roundQty(Number(product.stockQuantity || 0));
  const newQty = roundQty(prevQty - qtyNeeded);

  if (!allowNegative && newQty < -1e-6) {
    throw new AccountingError(`الكمية المتاحة لا تكفي للمنتج ${product.name}`, 400);
  }

  // Consume oldest batches first (FIFO physical flow tracking)
  const availableBatches = tx
    .select()
    .from(inventoryBatches)
    .where(and(eq(inventoryBatches.productId, productId), gt(inventoryBatches.remainingQuantity, 0)))
    .orderBy(asc(inventoryBatches.purchaseDate), asc(inventoryBatches.createdAt))
    .all();

  let weightedUnitCost = Number(product.costPrice || 0);
  if (valuationMethod === 'weighted_average' && availableBatches.length > 0) {
    let activeQty = 0;
    let activeVal = 0;
    for (const b of availableBatches) {
      const bq = Number(b.remainingQuantity || 0);
      const bc = Number(b.costPrice || 0);
      activeQty += bq;
      activeVal += bq * bc;
    }
    if (activeQty > 0) {
      weightedUnitCost = Math.round((activeVal / activeQty) * 10000) / 10000;
      // Keep the remaining batch valuation aligned with the weighted-average
      // COGS applied to this issue, so later issues do not drift back to FIFO layer costs.
      for (const batch of availableBatches) {
        tx.update(inventoryBatches)
          .set({ costPrice: weightedUnitCost, updatedAt: now, isSynced: 0 })
          .where(eq(inventoryBatches.id, batch.id))
          .run();
      }
    }
  }

  let remainingToConsume = qtyNeeded;
  let totalCost = 0;
  const allocations: BatchAllocation[] = [];

  for (const batch of availableBatches) {
    if (remainingToConsume <= 1e-6) break;
    const take = roundQty(Math.min(remainingToConsume, Number(batch.remainingQuantity)));
    if (take <= 0) continue;

    tx.update(inventoryBatches)
      .set({
        remainingQuantity: roundQty(Math.max(0, Number(batch.remainingQuantity) - take)),
        updatedAt: now,
        isSynced: 0,
      })
      .where(eq(inventoryBatches.id, batch.id))
      .run();

    const batchCost =
      valuationMethod === 'weighted_average' ? weightedUnitCost : Number(batch.costPrice || 0);
    totalCost += take * batchCost;
    allocations.push({
      batchId: batch.id,
      quantity: take,
      costPrice: batchCost,
    });
    remainingToConsume = roundQty(remainingToConsume - take);
  }

  // Fallback for pre-batch stock or offline oversell
  if (remainingToConsume > 1e-6) {
    const fallbackCost =
      valuationMethod === 'weighted_average' ? weightedUnitCost : Number(product.costPrice || 0);
    totalCost += remainingToConsume * fallbackCost;
    allocations.push({
      batchId: null,
      quantity: remainingToConsume,
      costPrice: fallbackCost,
    });
  }

  // Update product stock atomically
  tx.update(products)
    .set({
      ...(valuationMethod === 'weighted_average' ? { costPrice: roundMoney(weightedUnitCost) } : {}),
      stockQuantity: newQty,
      updatedAt: now,
      isSynced: 0,
    })
    .where(eq(products.id, productId))
    .run();

  // Record Offline Oversell / Deficit Alert if stock became negative
  if (newQty < -1e-6) {
    tx.insert(inventoryAlerts)
      .values({
        id: crypto.randomUUID(),
        productId,
        productName: params.productName || product.name,
        previousQty: prevQty,
        changeQty: -qtyNeeded,
        resultingQty: newQty,
        operationId: operationId || null,
        deviceId: deviceId || null,
        reason: 'offline_oversell',
        resolved: 0,
        createdAt: now,
      })
      .run();
  }

  const averageUnitCost =
    qtyNeeded > 0 ? totalCost / qtyNeeded : Number(product.costPrice || 0);

  const srcType = params.sourceType || 'order';
  const srcId = params.sourceId || operationId || crypto.randomUUID();
  recordInventoryMovement(tx, {
    movementKey: `${srcType}:${srcId}:out:${productId}:${params.movementKeySuffix ?? '0'}`,
    productId,
    movementType: params.movementType || 'sale',
    sourceType: srcType,
    sourceId: srcId,
    quantityDeltaBase: -qtyNeeded,
    baseUnitCode: product.baseUnitCode || product.unit || 'piece',
    unitCost: averageUnitCost,
    totalCost: roundMoney(totalCost),
    branchId: params.branchId ?? product.branchId ?? null,
    operationId: operationId ?? null,
    reason: params.reason ?? null,
    createdBy: params.createdBy ?? 'System',
    createdAt: now,
  });

  return {
    totalCost: roundMoney(totalCost),
    averageUnitCost,
    allocations,
  };
}

export function restoreInventoryFIFO(
  tx: any,
  params: {
    productId: number;
    quantityInBaseUnits: number;
    allocations?: BatchAllocation[];
    fallbackCost: number;
    valuationMethod?: 'fifo' | 'weighted_average';
    branchId?: number | null;
    operationId?: string;
    movementType?: string;
    sourceType?: string;
    sourceId?: string;
    movementKeySuffix?: string;
    reason?: string | null;
    createdBy?: string | null;
    createdAt?: string;
  }
): { totalCostRestored: number; restoredAllocations: BatchAllocation[] } {
  const { productId, quantityInBaseUnits, allocations = [], fallbackCost, valuationMethod = 'fifo', branchId } = params;
  const now = params.createdAt || new Date().toISOString();

  const qtyToRestore = roundQty(quantityInBaseUnits);
  let remainingToRestore = qtyToRestore;
  let totalCostRestored = 0;
  const restoredAllocations: BatchAllocation[] = [];

  // Restore into original batch layers (LIFO reverse of allocations or direct batch restore)
  for (let i = allocations.length - 1; i >= 0 && remainingToRestore > 1e-6; i--) {
    const alloc = allocations[i];
    if (!alloc || alloc.quantity <= 0) continue;
    let putBack = roundQty(Math.min(remainingToRestore, alloc.quantity));

    const allocationCost = Number(alloc.costPrice ?? fallbackCost);
    if (alloc.batchId) {
      const batch = tx
        .select()
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, alloc.batchId))
        .get();
      if (batch) {
        const room = roundQty(Math.max(0, Number(batch.quantity) - Number(batch.remainingQuantity)));
        putBack = roundQty(Math.min(putBack, room));
        if (putBack <= 1e-6) continue;
        const newRem = roundQty(Number(batch.remainingQuantity) + putBack);
        tx.update(inventoryBatches)
          .set({ remainingQuantity: newRem, updatedAt: now, isSynced: 0 })
          .where(eq(inventoryBatches.id, batch.id))
          .run();
      } else {
        const replacementBatchId = crypto.randomUUID();
        tx.insert(inventoryBatches).values({
          id: replacementBatchId, productId, purchaseId: null, quantity: putBack, remainingQuantity: putBack,
          costPrice: allocationCost, purchaseDate: now, branchId: branchId ?? null, isSynced: 0,
          createdAt: now, updatedAt: now,
        }).run();
        restoredAllocations.push({ batchId: replacementBatchId, quantity: putBack, costPrice: allocationCost });
        totalCostRestored += putBack * allocationCost;
        remainingToRestore = roundQty(remainingToRestore - putBack);
        continue;
      }
    }
    totalCostRestored += putBack * allocationCost;
    restoredAllocations.push({ batchId: alloc.batchId, quantity: putBack, costPrice: allocationCost });
    remainingToRestore = roundQty(remainingToRestore - putBack);
  }

  // If no batch allocations were present or original batches are full, create a return batch layer so FIFO stays consistent
  if (remainingToRestore > 1e-6) {
    const batchId = crypto.randomUUID();
    tx.insert(inventoryBatches)
      .values({
        id: batchId,
        productId,
        purchaseId: null,
        quantity: remainingToRestore,
        remainingQuantity: remainingToRestore,
        costPrice: fallbackCost,
        purchaseDate: now,
        branchId: branchId ?? null,
        isSynced: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    totalCostRestored += remainingToRestore * fallbackCost;
    restoredAllocations.push({
      batchId,
      quantity: remainingToRestore,
      costPrice: fallbackCost,
    });
  }

  const product = tx.select().from(products).where(eq(products.id, productId)).get();
  if (product) {
    const updatedQty = roundQty(Number(product.stockQuantity || 0) + qtyToRestore);
    tx.update(products)
      .set({
        stockQuantity: updatedQty,
        updatedAt: now,
        isSynced: 0,
      })
      .where(eq(products.id, productId))
      .run();
    if (valuationMethod === 'weighted_average') recalculateProductWeightedCost(tx, productId);
  }

  const srcType = params.sourceType || 'return';
  const srcId = params.sourceId || params.operationId || crypto.randomUUID();
  const avgRestoredCost = qtyToRestore > 0 ? totalCostRestored / qtyToRestore : fallbackCost;
  recordInventoryMovement(tx, {
    movementKey: `${srcType}:${srcId}:in:${productId}:${params.movementKeySuffix ?? '0'}`,
    productId,
    movementType: params.movementType || 'sale_return',
    sourceType: srcType,
    sourceId: srcId,
    quantityDeltaBase: qtyToRestore,
    baseUnitCode: product?.baseUnitCode || product?.unit || 'piece',
    unitCost: avgRestoredCost,
    totalCost: roundMoney(totalCostRestored),
    branchId: branchId ?? product?.branchId ?? null,
    operationId: params.operationId ?? null,
    reason: params.reason ?? null,
    createdBy: params.createdBy ?? 'System',
    createdAt: now,
  });

  return {
    totalCostRestored: roundMoney(totalCostRestored),
    restoredAllocations,
  };
}

export function recalculateProductWeightedCost(tx: any, productId: number) {
  const activeBatches = tx
    .select()
    .from(inventoryBatches)
    .where(and(eq(inventoryBatches.productId, productId), gt(inventoryBatches.remainingQuantity, 0)))
    .all();

  let totalQty = 0;
  let totalValue = 0;
  for (const b of activeBatches) {
    const q = Number(b.remainingQuantity || 0);
    const c = Number(b.costPrice || 0);
    totalQty += q;
    totalValue += q * c;
  }

  if (totalQty > 0) {
    const weightedAvg = Math.round((totalValue / totalQty) * 100) / 100;
    tx.update(products)
      .set({ costPrice: weightedAvg, updatedAt: new Date().toISOString(), isSynced: 0 })
      .where(eq(products.id, productId))
      .run();
    return weightedAvg;
  }
  return null;
}
