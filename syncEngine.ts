import { createClient } from '@supabase/supabase-js';
import { db } from './drizzle/db.js';
import { eq } from 'drizzle-orm';
import * as schema from './drizzle/schema.js';
import {
  categories,
  products,
  customers,
  suppliers,
  employees,
  expenses,
  shifts,
  shiftMovements,
  orders,
  orderItems,
  returns,
  returnItems,
  purchases,
  purchaseItems,
  purchaseReturns,
  purchaseReturnItems,
  customerPayments,
  supplierPayments,
  attendance,
  branches,
  payrolls,
  offers,
  loyaltyTransactions,
  settings,
  auditLogs,
  accounts,
  journalEntries,
  transactions,
  stocktakingSessions,
  stocktakingEntries,
  inventoryBatches,
  syncQueue,
} from './drizzle/schema.js';

let supabase: any = null;

const SUPABASE_TABLE_MAP: Record<string, { drizzleTable: any; supabaseTable: string }> = {
  Category: { drizzleTable: categories, supabaseTable: 'categories' },
  Product: { drizzleTable: products, supabaseTable: 'products' },
  InventoryBatch: { drizzleTable: inventoryBatches, supabaseTable: 'inventory_batches' },
  Customer: { drizzleTable: customers, supabaseTable: 'customers' },
  Supplier: { drizzleTable: suppliers, supabaseTable: 'suppliers' },
  Employee: { drizzleTable: employees, supabaseTable: 'employees' },
  Expense: { drizzleTable: expenses, supabaseTable: 'expenses' },
  Shift: { drizzleTable: shifts, supabaseTable: 'shifts' },
  ShiftMovement: { drizzleTable: shiftMovements, supabaseTable: 'shift_movements' },
  Order: { drizzleTable: orders, supabaseTable: 'orders' },
  OrderItem: { drizzleTable: orderItems, supabaseTable: 'order_items' },
  Return: { drizzleTable: returns, supabaseTable: 'returns' },
  ReturnItem: { drizzleTable: returnItems, supabaseTable: 'return_items' },
  Purchase: { drizzleTable: purchases, supabaseTable: 'purchases' },
  PurchaseItem: { drizzleTable: purchaseItems, supabaseTable: 'purchase_items' },
  PurchaseReturn: { drizzleTable: purchaseReturns, supabaseTable: 'purchase_returns' },
  PurchaseReturnItem: { drizzleTable: purchaseReturnItems, supabaseTable: 'purchase_return_items' },
  CustomerPayment: { drizzleTable: customerPayments, supabaseTable: 'customer_payments' },
  SupplierPayment: { drizzleTable: supplierPayments, supabaseTable: 'supplier_payments' },
  Attendance: { drizzleTable: attendance, supabaseTable: 'attendance' },
  Branch: { drizzleTable: branches, supabaseTable: 'branches' },
  Payroll: { drizzleTable: payrolls, supabaseTable: 'payrolls' },
  Offer: { drizzleTable: offers, supabaseTable: 'offers' },
  LoyaltyTransaction: { drizzleTable: loyaltyTransactions, supabaseTable: 'loyalty_transactions' },
  Setting: { drizzleTable: settings, supabaseTable: 'settings' },
  AuditLog: { drizzleTable: auditLogs, supabaseTable: 'audit_logs' },
  Account: { drizzleTable: accounts, supabaseTable: 'accounts' },
  JournalEntry: { drizzleTable: journalEntries, supabaseTable: 'journal_entries' },
  Transaction: { drizzleTable: transactions, supabaseTable: 'transactions' },
  StocktakingSession: { drizzleTable: stocktakingSessions, supabaseTable: 'stocktaking_sessions' },
  StocktakingEntry: { drizzleTable: stocktakingEntries, supabaseTable: 'stocktaking_entries' },
};

export async function initSupabase() {
  try {
    const urlSetting = await db.select().from(settings).where(eq(settings.key, 'supabaseUrl'));
    const keySetting = await db.select().from(settings).where(eq(settings.key, 'supabaseKey'));
    const isCloudSyncEnabled = await db.select().from(settings).where(eq(settings.key, 'enableCloudSync'));

    if (isCloudSyncEnabled[0]?.value === 'true' && urlSetting[0]?.value && keySetting[0]?.value) {
      supabase = createClient(urlSetting[0].value, keySetting[0].value);
      return true;
    }
  } catch (e) {
    console.error('Failed to init Supabase:', e);
  }
  supabase = null;
  return false;
}

let lastPullTime = 0;

export async function pullFromSupabase() {
  if (!supabase) return;

  const now = Date.now();
  if (now - lastPullTime < 60000) return;
  lastPullTime = now;

  try {
    const lastSyncSetting = await db.select().from(settings).where(eq(settings.key, 'lastCloudSync'));
    const lastSync = lastSyncSetting[0]?.value ? new Date(lastSyncSetting[0].value) : new Date(0);
    const newSyncTime = new Date();

    const tables = [
      { model: 'categories', table: 'categories' },
      { model: 'products', table: 'products' },
      { model: 'inventoryBatches', table: 'inventory_batches' },
      { model: 'customers', table: 'customers' },
      { model: 'suppliers', table: 'suppliers' },
      { model: 'employees', table: 'employees' },
      { model: 'expenses', table: 'expenses' },
      { model: 'shifts', table: 'shifts' },
      { model: 'orders', table: 'orders' },
      { model: 'orderItems', table: 'order_items' },
      { model: 'returns', table: 'returns' },
      { model: 'returnItems', table: 'return_items' },
      { model: 'purchases', table: 'purchases' },
      { model: 'purchaseItems', table: 'purchase_items' },
      { model: 'purchaseReturns', table: 'purchase_returns' },
      { model: 'purchaseReturnItems', table: 'purchase_return_items' },
      { model: 'attendance', table: 'attendance' },
      { model: 'branches', table: 'branches' },
      { model: 'payrolls', table: 'payrolls' },
      { model: 'offers', table: 'offers' },
      { model: 'loyaltyTransactions', table: 'loyalty_transactions' },
      { model: 'settings', table: 'settings' },
    ];

    for (const { model, table } of tables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('*')
          .gt('updatedAt', lastSync.toISOString());

        if (error) throw error;
        if (!data || data.length === 0) continue;

        for (const record of data) {
          const drizzleModel = (schema as any)[model];
          if (!drizzleModel) continue;
          const localRecord = await db.select().from(drizzleModel).where(eq(drizzleModel.id, record.id));

          if (localRecord.length === 0 || new Date(record.updatedAt) > new Date(localRecord[0].updatedAt)) {
            const { isSynced, ...dataToSave } = record;
            await db
              .insert(drizzleModel)
              .values({ ...dataToSave, isSynced: 1 })
              .onConflictDoUpdate({
                target: drizzleModel.id,
                set: { ...dataToSave, isSynced: 1 },
              });
          }
        }
      } catch (e) {
        console.error(`Failed to pull ${table}:`, e);
      }
    }

    await db
      .insert(settings)
      .values({
        key: 'lastCloudSync',
        value: newSyncTime.toISOString(),
        isSynced: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: newSyncTime.toISOString(), updatedAt: new Date().toISOString() },
      });
  } catch (error) {
    console.error('Error pulling from Supabase:', error);
  }
}

export async function processSyncQueue() {
  const isCloudSyncEnabled = await db.select().from(settings).where(eq(settings.key, 'enableCloudSync'));
  const enabled = isCloudSyncEnabled[0]?.value === 'true';

  if (!enabled) {
    return;
  }

  if (!supabase) {
    await initSupabase();
  }
  if (!supabase) return;

  try {
    await pullFromSupabase();

    const pendingItems = await db
      .select()
      .from(syncQueue)
      .where(eq(syncQueue.status, 'pending'))
      .limit(50)
      .orderBy(syncQueue.createdAt);

    if (pendingItems.length === 0) return;

    for (const item of pendingItems) {
      try {
        await db.update(syncQueue).set({ status: 'processing' }).where(eq(syncQueue.id, item.id));

        const payload = JSON.parse(item.data);
        const mapping = SUPABASE_TABLE_MAP[item.type];
        if (!mapping) {
          throw new Error(`Table mapping not found for type: ${item.type}`);
        }

        const { drizzleTable, supabaseTable } = mapping;

        if (item.action === 'create' || item.action === 'update' || item.action === 'upsert') {
          const { id, isSynced, ...dataToSync } = payload;
          const { error } = await supabase.from(supabaseTable).upsert({ id, ...dataToSync });
          if (error) throw error;

          if (payload.id && drizzleTable.id) {
            try {
              await db.update(drizzleTable).set({ isSynced: 1 }).where(eq(drizzleTable.id, payload.id));
            } catch {}
          }
        } else if (item.action === 'delete') {
          const { error } = await supabase.from(supabaseTable).delete().eq('id', payload.id);
          if (error) throw error;
        }

        await db.update(syncQueue).set({ status: 'completed' }).where(eq(syncQueue.id, item.id));
      } catch (error) {
        console.error(`Failed to sync item ${item.id}:`, error);
        await db.update(syncQueue).set({ status: 'failed' }).where(eq(syncQueue.id, item.id));
      }
    }
  } catch (error) {
    console.error('Error processing sync queue:', error);
  }
}

let syncTimer: NodeJS.Timeout | null = null;

export function startSyncEngine() {
  if (syncTimer) return;
  syncTimer = setInterval(processSyncQueue, 15000);
}

export function stopSyncEngine() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
