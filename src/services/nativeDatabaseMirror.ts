import { db } from '../db/db';
import { deleteNativePosRecord, ensureNativePosDatabase, isNativeAndroid, posLocalDatabase, replaceNativePosRecords } from '../native/posLocalDatabase';

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

let nativeMirrorHooksInstalled = false;
let nativeMirrorWriteQueue: Promise<void> = Promise.resolve();

function enqueueNativeMirrorWrite(write: () => Promise<void>): Promise<void> {
  const next = nativeMirrorWriteQueue.then(write, write);
  nativeMirrorWriteQueue = next.catch((error) => {
    console.warn('Android SQLite mirror write failed:', error);
  });
  return next;
}

/**
 * Keep the Android SQLite copy current after every committed Dexie mutation.
 * Dexie remains the current UI data layer; this is a durability bridge, not
 * yet a replacement SQLite-backed repository.
 */
export function installNativeDatabaseMirrorHooks(): void {
  if (nativeMirrorHooksInstalled || !isNativeAndroid()) return;
  nativeMirrorHooksInstalled = true;

  for (const entity of MIRRORED_TABLES) {
    const table = (db as any)[entity];
    if (!table) continue;

    table.hook('creating', function (primKey: any, obj: any, transaction: any) {
      transaction.on('complete', () => {
        const key = primKey ?? getRecordId(obj);
        Promise.resolve(table.get(key))
          .then((row: any) => row && mirrorNativePosRecord(entity, row))
          .catch((error: any) => console.warn('Android SQLite create mirror failed:', entity, error));
      });
    });

    table.hook('updating', function (_changes: any, primKey: any, _obj: any, transaction: any) {
      transaction.on('complete', () => {
        Promise.resolve(table.get(primKey))
          .then((row: any) => row && mirrorNativePosRecord(entity, row))
          .catch((error: any) => console.warn('Android SQLite update mirror failed:', entity, error));
      });
    });

    table.hook('deleting', function (primKey: any, obj: any, transaction: any) {
      const recordId = getRecordId(obj) || String(primKey ?? '');
      transaction.on('complete', () => {
        if (!recordId || (entity === 'settings' && obj?.key === 'authSecret')) return;
        enqueueNativeMirrorWrite(() => deleteNativePosRecord(entity, recordId))
          .catch((error) => console.warn('Android SQLite delete mirror failed:', entity, error));
      });
    });
  }
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
          syncState: row.syncStatus === 'pending' || row.syncStatus === 'synced' || row.syncStatus === 'error' ? row.syncStatus : 'local',
        }))
        .filter((entry: any) => entry.recordId.length > 0);
      await enqueueNativeMirrorWrite(() => replaceNativePosRecords(entity, records));
    } catch (error) {
      console.warn('تعذر حفظ لقطة SQLite للجدول ' + entity, error);
    }
  }
  await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: '1' }).catch(() => {});
}

export async function mirrorNativePosRecord(entity: string, row: any): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  if (entity === 'settings' && row?.key === 'authSecret') return;
  const recordId = getRecordId(row);
  if (!recordId) return;
  const syncState = row?.syncStatus === 'pending' || row?.syncStatus === 'synced' || row?.syncStatus === 'error'
    ? row.syncStatus : 'local';
  await enqueueNativeMirrorWrite(() =>
    posLocalDatabase.putRecord({ entity, recordId, record: row, syncState }).then(() => undefined)
  );
}
export async function restoreNativePosDatabase(): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  for (const entity of MIRRORED_TABLES) {
    try {
      const table = (db as any)[entity];
      if (!table) continue;
      const result = await posLocalDatabase.getRecords({ entity });
      if (!Array.isArray(result.records) || result.records.length === 0) continue;
      const existingRows = await table.toArray();
      const existingIds = new Set(existingRows.map((row: any) => getRecordId(row)).filter(Boolean));
      const missingRows = result.records
        .filter((item) => item.recordId && !existingIds.has(String(item.recordId)))
        .map((item) => ({
          ...item.record,
          ...(item.record.syncStatus === undefined ? { syncStatus: item.syncState } : {}),
        }));
      if (missingRows.length) await table.bulkPut(missingRows);
    } catch (error) {
      console.warn('تعذر استعادة SQLite إلى IndexedDB للجدول ' + entity, error);
    }
  }
}
