import { db } from '../db/db';
import { ensureNativePosDatabase, isNativeAndroid, posLocalDatabase, replaceNativePosRecords } from '../native/posLocalDatabase';

const MIRRORED_TABLES = [
  'products', 'categories', 'orders', 'orderItems', 'returns', 'returnItems', 'accounts', 'shifts',
  'shiftMovements', 'customers', 'customerPayments', 'expenses', 'suppliers', 'supplierPayments',
  'employees', 'settings', 'purchases', 'purchaseItems', 'purchaseReturns', 'purchaseReturnItems',
  'attendance', 'loyaltyTransactions', 'branches', 'payroll', 'offers', 'auditLogs', 'journalEntries',
  'transactions', 'stocktakingSessions', 'stocktakingEntries', 'inventoryBatches', 'inventoryAlerts',
  'heldOrders', 'serviceRecipes', 'exchangeRateHistory', 'fiscalPeriods', 'unitDefinitions',
  'productUnits', 'inventoryMovements',
] as const;

function getRecordId(row: any): string {
  const value = row?.id ?? row?.code ?? row?.key;
  return value === undefined || value === null ? '' : String(value);
}

export async function mirrorNativePosDatabase(): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  for (const entity of MIRRORED_TABLES) {
    try {
      const table = (db as any)[entity];
      if (!table) continue;
      const rows = await table.toArray();
      const records = rows
        .filter((row: any) => !(entity === 'settings' && row.key === 'authSecret'))
        .map((row: any) => ({
          recordId: getRecordId(row),
          record: row as Record<string, unknown>,
          syncState: row.syncStatus || 'local',
        }))
        .filter((entry: any) => entry.recordId.length > 0);
      await replaceNativePosRecords(entity, records);
    } catch (error) {
      console.warn('تعذر حفظ لقطة SQLite للجدول ' + entity, error);
    }
  }
  await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: '1' }).catch(() => {});
}

export async function restoreNativePosDatabase(): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  for (const entity of MIRRORED_TABLES) {
    try {
      const table = (db as any)[entity];
      if (!table || await table.count() > 0) continue;
      const result = await posLocalDatabase.getRecords({ entity });
      if (!Array.isArray(result.records) || result.records.length === 0) continue;
      const rows = result.records.map((item) => ({
        ...item.record,
        ...(item.record.syncStatus === undefined ? { syncStatus: item.syncState } : {}),
      }));
      await table.bulkPut(rows);
    } catch (error) {
      console.warn('تعذر استعادة SQLite إلى IndexedDB للجدول ' + entity, error);
    }
  }
}
