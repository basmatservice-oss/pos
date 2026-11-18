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
let nativeMirrorWriteFailure: unknown = null;

function enqueueNativeMirrorWrite(write: () => Promise<void>): Promise<void> {
  const next = nativeMirrorWriteQueue.then(write, write);
  nativeMirrorWriteQueue = next.catch((error) => {
    nativeMirrorWriteFailure = error;
    console.error('Android SQLite mirror write failed:', error);
  });
  return next;
}

/**
 * Wait until every Dexie mutation already observed by the hooks is durable in SQLite.
 * A failed write is surfaced to the caller instead of being silently forgotten.
 */
export async function flushNativeDatabaseMirrorWrites(): Promise<void> {
  await nativeMirrorWriteQueue;
  if (nativeMirrorWriteFailure) {
    const error = nativeMirrorWriteFailure;
    nativeMirrorWriteFailure = null;
    const invalidated = await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: 'in_progress' });
    if (!invalidated.saved) {
      throw new Error('Android SQLite mirror write failed and the business snapshot could not be invalidated: ' + String(error));
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
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
        if (key === undefined || key === null || key === '') return;
        enqueueNativeMirrorWrite(async () => {
          const row = await table.get(key);
          if (row) await persistNativePosRecord(entity, row);
        }).catch((error) => console.warn('Android SQLite create mirror failed:', entity, error));
      });
    });

    table.hook('updating', function (_changes: any, primKey: any, _obj: any, transaction: any) {
      transaction.on('complete', () => {
        enqueueNativeMirrorWrite(async () => {
          const row = await table.get(primKey);
          if (row) await persistNativePosRecord(entity, row);
        }).catch((error) => console.warn('Android SQLite update mirror failed:', entity, error));
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
  const invalidated = await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: 'in_progress' });
  if (!invalidated.saved) throw new Error('تعذر إبطال علامة لقطة SQLite السابقة');
  const failedEntities: string[] = [];
  for (const entity of MIRRORED_TABLES) {
    try {
      const table = (db as any)[entity];
      if (!table) throw new Error('Dexie table is unavailable');
      const rows = await table.toArray();
      const records = rows
        .filter((row: any) => !(entity === 'settings' && row.key === 'authSecret'))
        .map((row: any) => ({
          recordId: getRecordId(row),
          record: row as Record<string, unknown>,
          syncState: row.syncStatus === 'pending' || row.syncStatus === 'synced' || row.syncStatus === 'error' ? row.syncStatus : 'local',
        }))
        .filter((entry: any) => entry.recordId.length > 0);
      const saved = await enqueueNativeMirrorWrite(() => replaceNativePosRecords(entity, records));
      if (!saved) throw new Error('SQLite snapshot write was not confirmed');
    } catch (error) {
      failedEntities.push(entity);
      console.error('تعذر حفظ لقطة SQLite للجدول ' + entity, error);
    }
  }
  if (failedEntities.length > 0) {
    throw new Error('SQLite business snapshot incomplete; failed entities: ' + failedEntities.join(', '));
  }
  const completed = await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: '1' });
  if (!completed.saved) throw new Error('تعذر تأكيد اكتمال لقطة SQLite');
}

async function persistNativePosRecord(entity: string, row: any): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  if (entity === 'settings' && row?.key === 'authSecret') return;
  const recordId = getRecordId(row);
  if (!recordId) return;
  const syncState = row?.syncStatus === 'pending' || row?.syncStatus === 'synced' || row?.syncStatus === 'error'
    ? row.syncStatus : 'local';
  await posLocalDatabase.putRecord({ entity, recordId, record: row, syncState }).then(() => undefined);
}

export async function mirrorNativePosRecord(entity: string, row: any): Promise<void> {
  await enqueueNativeMirrorWrite(() => persistNativePosRecord(entity, row));
}
export async function restoreNativePosDatabase(): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  const snapshotState = await posLocalDatabase.getMeta({ key: 'business_snapshot_version' });
  if (snapshotState.value === 'in_progress') {
    console.warn('Interrupted Android SQLite snapshot detected; partial records will not be restored. A fresh Dexie snapshot will be attempted.');
    return;
  }
  if (snapshotState.value !== '1') return;
  const failedEntities: string[] = [];
  for (const entity of MIRRORED_TABLES) {
    try {
      const table = (db as any)[entity];
      if (!table) throw new Error('Dexie table is unavailable');
      const result = await posLocalDatabase.getRecords({ entity });
      if (!Array.isArray(result.records)) throw new Error('SQLite returned an invalid record collection');
      if (result.records.length === 0) continue;
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
      failedEntities.push(entity);
      console.error('تعذر استعادة SQLite إلى IndexedDB للجدول ' + entity, error);
    }
  }
  if (failedEntities.length > 0) {
    throw new Error('Android SQLite restore incomplete; failed entities: ' + failedEntities.join(', '));
  }
}
