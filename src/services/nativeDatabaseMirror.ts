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

function serializeDexieKey(value: unknown): string {
  if (value === undefined || value === null) return '';
  // JSON preserves the distinction between numeric and string Dexie keys,
  // and also supports compound keys without collapsing their components.
  return JSON.stringify(value) ?? '';
}

function getRecordId(entity: string, row: any): string {
  const primaryKey = (db as any)[entity]?.schema?.primKey?.keyPath;
  const value = Array.isArray(primaryKey)
    ? primaryKey.map((path: string) => row?.[path])
    : typeof primaryKey === 'string'
      ? row?.[primaryKey]
      : row?.id ?? row?.code ?? row?.key;
  if (Array.isArray(value) && value.some((part) => part === undefined || part === null)) return '';
  return serializeDexieKey(value);
}

let nativeMirrorHooksInstalled = false;
let nativeMirrorWriteQueue: Promise<void> = Promise.resolve();
let nativeMirrorWriteFailure: unknown = null;
let nativeSnapshotNeedsRefresh = false;

type PendingTransactionChange = { entity: string; table: any; key: any };
const transactionChanges = new WeakMap<object, Map<string, PendingTransactionChange>>();

function collectTransactionChange(entity: string, table: any, key: any, transaction: any): void {
  if (key === undefined || key === null) {
    throw new Error(`Cannot mirror ${entity} mutation without its Dexie primary key`);
  }
  let changes = transactionChanges.get(transaction);
  if (!changes) {
    changes = new Map<string, PendingTransactionChange>();
    transactionChanges.set(transaction, changes);
    transaction.on('complete', () => {
      const committed = Array.from(changes!.values());
      enqueueNativeMirrorWrite(async () => {
        const nativeChanges = [];
        for (const change of committed) {
          const row = await change.table.get(change.key);
          const recordId = serializeDexieKey(change.key);
          if (!recordId) throw new Error(`Cannot resolve committed ${change.entity} record key`);
          if (!row) {
            if (!(change.entity === 'settings' && change.key === 'authSecret')) {
              nativeChanges.push({ action: 'delete' as const, entity: change.entity, recordId });
            }
            continue;
          }
          if (change.entity === 'settings' && row.key === 'authSecret') continue;
          const resolvedId = getRecordId(change.entity, row);
          if (!resolvedId || resolvedId !== recordId) {
            throw new Error(`Committed ${change.entity} record key does not match its Dexie primary key`);
          }
          nativeChanges.push({
            action: 'put' as const,
            entity: change.entity,
            recordId,
            record: row,
            syncState: row.syncStatus === 'pending' || row.syncStatus === 'synced' || row.syncStatus === 'error'
              ? row.syncStatus : 'local',
          });
        }
        if (nativeChanges.length) {
          const result = await posLocalDatabase.applyRecordChanges({ changes: nativeChanges });
          if (result.count !== nativeChanges.length || !Number.isInteger(result.applied) ||
              result.applied < 0 || result.applied > nativeChanges.length) {
            throw new Error('SQLite did not confirm the committed Dexie transaction mirror');
          }
        }
      }).catch((error) => console.warn('Android SQLite transaction mirror failed:', error));
    });
  }
  const identity = JSON.stringify([entity, key]);
  changes.set(identity, { entity, table, key });
}

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
    nativeSnapshotNeedsRefresh = true;
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (nativeSnapshotNeedsRefresh) {
    await mirrorNativePosDatabase();
    nativeSnapshotNeedsRefresh = false;
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
      const key = primKey ?? (typeof table.schema.primKey.keyPath === 'string'
        ? obj?.[table.schema.primKey.keyPath]
        : Array.isArray(table.schema.primKey.keyPath)
          ? table.schema.primKey.keyPath.map((part: string) => obj?.[part])
          : undefined);
      collectTransactionChange(entity, table, key, transaction);
    });

    table.hook('updating', function (_changes: any, primKey: any, _obj: any, transaction: any) {
      collectTransactionChange(entity, table, primKey, transaction);
    });

    table.hook('deleting', function (primKey: any, obj: any, transaction: any) {
      if (entity === 'settings' && obj?.key === 'authSecret') return;
      collectTransactionChange(entity, table, primKey, transaction);
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
      const businessRows = rows.filter((row: any) => !(entity === 'settings' && row.key === 'authSecret'));
      const records = businessRows.map((row: any) => {
        const recordId = getRecordId(entity, row);
        if (!recordId) {
          throw new Error(`A record in ${entity} has no stable primary-key value; refusing to replace the SQLite snapshot`);
        }
        return {
          recordId,
          record: row as Record<string, unknown>,
          syncState: row.syncStatus === 'pending' || row.syncStatus === 'synced' || row.syncStatus === 'error' ? row.syncStatus : 'local',
        };
      });
      const recordIds = new Set<string>();
      for (const record of records) {
        if (recordIds.has(record.recordId)) {
          throw new Error(`Duplicate primary-key value ${record.recordId} in ${entity}; refusing to replace the SQLite snapshot`);
        }
        recordIds.add(record.recordId);
      }
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
  const recordId = getRecordId(entity, row);
  if (!recordId) throw new Error(`Cannot mirror ${entity} record without its Dexie primary key`);
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

      // Validate the complete SQLite response before writing anything to Dexie.
      // A mismatched serialized key could otherwise restore a row under the wrong identity.
      const restoredIds = new Set<string>();
      const validRecords = result.records.filter((item) => !(entity === 'settings' && item.record?.key === 'authSecret'));
      for (const item of validRecords) {
        if (!item || typeof item.recordId !== 'string' || !item.record || typeof item.record !== 'object') {
          throw new Error(`SQLite returned an invalid record in ${entity}`);
        }
        const resolvedId = getRecordId(entity, item.record);
        if (!resolvedId || resolvedId !== item.recordId) {
          throw new Error(`SQLite record identity mismatch in ${entity}: stored key does not match the record primary key`);
        }
        if (restoredIds.has(item.recordId)) {
          throw new Error(`SQLite returned a duplicate primary key in ${entity}`);
        }
        restoredIds.add(item.recordId);
      }
      if (validRecords.length === 0) continue;
      const existingRows = await table.toArray();
      const existingIds = new Set(existingRows.map((row: any) => getRecordId(entity, row)).filter(Boolean));
      const missingRows = validRecords
        .filter((item) => !existingIds.has(item.recordId))
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
