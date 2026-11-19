import { ensureNativePosDatabase, isNativeAndroid, posLocalDatabase, replaceNativePosRecords } from '../native/posLocalDatabase';
import { getNativePosRecordId, NATIVE_POS_ENTITIES, notifyNativeEntityChanges } from '../native/nativePosRepository';

const MIRRORED_TABLES = NATIVE_POS_ENTITIES;

function serializeDexieKey(value: unknown): string {
  if (value === undefined || value === null) return '';
  // JSON preserves the distinction between numeric and string Dexie keys,
  // and also supports compound keys without collapsing their components.
  return JSON.stringify(value) ?? '';
}

function getRecordId(entity: string, row: any): string {
  try {
    return getNativePosRecordId(entity, row);
  } catch {
    return '';
  }
}

let nativeMirrorHooksInstalled = false;
let nativeMirrorWriteQueue: Promise<void> = Promise.resolve();
let nativeMirrorWriteFailure: unknown = null;
let nativeSnapshotNeedsRefresh = false;

type PendingTransactionChange = { entity: string; table: any; key: any };
const transactionChanges = new WeakMap<object, Map<string, PendingTransactionChange>>();

function collectTransactionChange(entity: string, table: any, key: any, transaction: any): void {
  if (key === undefined || key === null) {
    // Do not interfere with a valid Dexie commit when an inline/auto key is
    // unavailable in the hook. Rebuild the complete snapshot at the next flush.
    transaction.on('complete', () => { nativeSnapshotNeedsRefresh = true; });
    return;
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
              result.applied !== nativeChanges.length) {
            throw new Error('SQLite did not confirm the committed Dexie transaction mirror');
          }
          notifyNativeEntityChanges(nativeChanges.map((change) => change.entity as any));
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
export async function installNativeDatabaseMirrorHooks(): Promise<void> {
  const { db } = await import('../db/db');
  if (nativeMirrorHooksInstalled || !isNativeAndroid()) return;

  // Validate the complete registry before installing any hooks. Silently
  // skipping a missing table would leave SQLite stale while startup succeeds.
  const tables = MIRRORED_TABLES.map((entity) => {
    const table = (db as any)[entity];
    if (!table || typeof table.hook !== 'function' || !table.schema?.primKey) {
      throw new Error(`Cannot install Android SQLite mirror hooks: Dexie table ${entity} is unavailable or invalid`);
    }
    return { entity, table };
  });

  for (const { entity, table } of tables) {
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

  // Mark installed only after every registered table has its hooks.
  nativeMirrorHooksInstalled = true;
}

export async function mirrorNativePosDatabase(): Promise<void> {
  const { db } = await import('../db/db');
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
  notifyNativeEntityChanges(MIRRORED_TABLES);
}

async function persistNativePosRecord(entity: string, row: any): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  if (entity === 'settings' && row?.key === 'authSecret') return;
  const recordId = getRecordId(entity, row);
  if (!recordId) throw new Error(`Cannot mirror ${entity} record without its Dexie primary key`);
  const syncState = row?.syncStatus === 'pending' || row?.syncStatus === 'synced' || row?.syncStatus === 'error'
    ? row.syncStatus : 'local';
  await posLocalDatabase.putRecord({ entity, recordId, record: row, syncState }).then(() => undefined);
  notifyNativeEntityChanges([entity as any]);
}

export async function mirrorNativePosRecord(entity: string, row: any): Promise<void> {
  await enqueueNativeMirrorWrite(() => persistNativePosRecord(entity, row));
}
export async function restoreNativePosDatabase(): Promise<boolean> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return false;
  const snapshotState = await posLocalDatabase.getMeta({ key: 'business_snapshot_version' });
  if (snapshotState.value === 'in_progress') {
    console.warn('Interrupted Android SQLite snapshot detected; legacy local database migration will be retried.');
    return false;
  }
  // SQLite is the Android source of truth. A complete snapshot means startup
  // must not hydrate a second, competing Dexie copy.
  return snapshotState.value === '1';
}
