import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import {
  products,
  customers,
  suppliers,
  orders,
  inventoryBatches,
  journalEntries,
  settings,
} from '../drizzle/schema.js';
import { ensureChartOfAccounts, postJournalEntry, JournalLineInput } from './accounting.js';

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Idempotent migration & opening reconciliation for legacy databases (e.g. dev.db)
 * that have existing products/orders/customers/suppliers without InventoryBatch or JournalEntry rows.
 */
export function runLegacyDataBackfill(dbInstance: any): {
  alreadyCompleted: boolean;
  batchesCreated: number;
  openingEntryId: string | null;
} {
  const existingMarker = dbInstance
    .select()
    .from(settings)
    .where(eq(settings.key, 'legacyBackfillV1'))
    .get();

  if (existingMarker?.value === 'done') {
    return { alreadyCompleted: true, batchesCreated: 0, openingEntryId: null };
  }

  return dbInstance.transaction((tx: any) => {
    const markerInTx = tx
      .select()
      .from(settings)
      .where(eq(settings.key, 'legacyBackfillV1'))
      .get();

    if (markerInTx?.value === 'done') {
      return { alreadyCompleted: true, batchesCreated: 0, openingEntryId: null };
    }

    ensureChartOfAccounts(tx);
    const now = new Date().toISOString();

    // 1. Backfill paidAmount on legacy completed non-credit orders where paidAmount is 0 or null
    const allOrders = tx.select().from(orders).all();
    for (const ord of allOrders) {
      if (
        ord.status !== 'void' &&
        ord.paymentMethod !== 'credit' &&
        (ord.paidAmount === null || ord.paidAmount === undefined || Number(ord.paidAmount) === 0) &&
        Number(ord.netAmount || 0) > 0
      ) {
        tx.update(orders)
          .set({
            paidAmount: roundMoney(ord.netAmount),
            cashAmount: ord.paymentMethod === 'cash' ? roundMoney(ord.netAmount) : Number(ord.cashAmount || 0),
            cardAmount: ord.paymentMethod === 'card' ? roundMoney(ord.netAmount) : Number(ord.cardAmount || 0),
            updatedAt: now,
          })
          .where(eq(orders.id, ord.id))
          .run();
      }
    }

    // 2. Create opening InventoryBatch records for any products with stock > 0 and zero existing batches
    const allProducts = tx.select().from(products).all();
    const allExistingBatches = tx.select().from(inventoryBatches).all();
    const productsWithBatches = new Set(allExistingBatches.map((b: any) => Number(b.productId)));

    let batchesCreated = 0;
    for (const prod of allProducts) {
      const qty = Number(prod.stockQuantity || 0);
      if (qty > 0 && !productsWithBatches.has(Number(prod.id))) {
        tx.insert(inventoryBatches)
          .values({
            id: crypto.randomUUID(),
            productId: Number(prod.id),
            purchaseId: null,
            quantity: qty,
            remainingQuantity: qty,
            costPrice: Number(prod.costPrice || 0),
            purchaseDate: prod.createdAt || now,
            expiryDate: prod.expiryDate || null,
            batchNumber: prod.batchNumber || 'OPENING',
            branchId: prod.branchId || null,
            isSynced: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        batchesCreated += 1;
      }
    }

    // 3. Create balanced Opening JournalEntry if ledger is empty & legacy balances exist
    const existingJournals = tx.select().from(journalEntries).limit(1).all();
    let openingEntryId: string | null = null;

    if (existingJournals.length === 0) {
      const batchesAfter = tx.select().from(inventoryBatches).all();
      const inventoryValue = roundMoney(
        batchesAfter.reduce(
          (s: number, b: any) => s + Math.max(0, Number(b.remainingQuantity || 0)) * Number(b.costPrice || 0),
          0
        )
      );

      const allCustomers = tx.select().from(customers).all();
      const customerReceivables = roundMoney(
        allCustomers.reduce((s: number, c: any) => s + Math.max(0, Number(c.balance || 0)), 0)
      );

      const allSuppliers = tx.select().from(suppliers).all();
      const supplierPayables = roundMoney(
        allSuppliers.reduce((s: number, sup: any) => s + Math.max(0, Number(sup.balance || 0)), 0)
      );

      const lines: JournalLineInput[] = [];
      if (inventoryValue > 0) {
        lines.push({
          accountCode: '1200',
          debit: inventoryValue,
          credit: 0,
          description: 'رصيد المخزون الافتتاحي للبيانات السابقة',
        });
      }
      if (customerReceivables > 0) {
        lines.push({
          accountCode: '1100',
          debit: customerReceivables,
          credit: 0,
          description: 'أرصدة ذمم العملاء الافتتاحية',
        });
      }
      if (supplierPayables > 0) {
        lines.push({
          accountCode: '2100',
          debit: 0,
          credit: supplierPayables,
          description: 'أرصدة ذمم الموردين الافتتاحية',
        });
      }

      const netEquity = roundMoney(inventoryValue + customerReceivables - supplierPayables);
      if (netEquity > 0) {
        lines.push({
          accountCode: '3100',
          debit: 0,
          credit: netEquity,
          description: 'صافي حقوق الملكية والأرصدة الافتتاحية',
        });
      } else if (netEquity < 0) {
        lines.push({
          accountCode: '3100',
          debit: Math.abs(netEquity),
          credit: 0,
          description: 'عجز الأرصدة الافتتاحية',
        });
      }

      if (lines.length > 0) {
        openingEntryId = postJournalEntry(tx, {
          date: now,
          referenceId: 'OPENING-LEGACY-V1',
          referenceType: 'opening',
          description: 'قيد الأرصدة الافتتاحية ومطابقة البيانات السابقة',
          lines,
          createdBy: 'System',
        });
      }
    }

    tx.insert(settings)
      .values({
        key: 'legacyBackfillV1',
        value: 'done',
        isSynced: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: 'done', updatedAt: now },
      })
      .run();

    return { alreadyCompleted: false, batchesCreated, openingEntryId };
  });
}
