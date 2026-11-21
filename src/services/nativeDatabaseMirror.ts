import { ensureNativePosDatabase, isNativeAndroid, posLocalDatabase } from '../native/posLocalDatabase';
import { getNativePosRecordId, NATIVE_POS_ENTITIES, notifyNativeEntityChanges, nativePosRepository } from '../native/nativePosRepository';

const MIRRORED_TABLES = NATIVE_POS_ENTITIES;

function getRecordId(entity: string, row: any): string {
  try {
    return getNativePosRecordId(entity, row);
  } catch {
    return '';
  }
}

export async function readLegacyIndexedDBStores(): Promise<Record<string, any[]>> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing to skip legacy Android data migration');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('RetailPOSDB');
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    request.onerror = () => fail(request.error || new Error('تعذر فتح قاعدة IndexedDB القديمة'));
    request.onblocked = () => fail(new Error('ترحيل قاعدة IndexedDB القديمة محجوب باتصال آخر'));
    request.onsuccess = () => {
      const legacyDb = request.result;
      const names = Array.from(legacyDb.objectStoreNames);
      if (!names.length) {
        legacyDb.close();
        if (!settled) { settled = true; resolve({}); }
        return;
      }
      try {
        const transaction = legacyDb.transaction(names, 'readonly');
        const reads = names.map((name) => new Promise<[string, any[]]>((readResolve, readReject) => {
          const read = transaction.objectStore(name).getAll();
          read.onsuccess = () => readResolve([name, Array.isArray(read.result) ? read.result : []]);
          read.onerror = () => readReject(read.error || new Error('تعذر قراءة جدول IndexedDB القديم: ' + name));
        }));
        Promise.all(reads).then((entries) => {
          legacyDb.close();
          if (settled) return;
          settled = true;
          resolve(Object.fromEntries(entries));
        }).catch((error) => { legacyDb.close(); fail(error); });
        transaction.onabort = () => { legacyDb.close(); fail(transaction.error || new Error('تم إلغاء قراءة قاعدة IndexedDB القديمة')); };
        transaction.onerror = () => { legacyDb.close(); fail(transaction.error || new Error('فشلت قراءة قاعدة IndexedDB القديمة')); };
      } catch (error) { legacyDb.close(); fail(error); }
    };
  });
}

// Serialize one-time legacy IndexedDB import writes so snapshot migration is deterministic.
let nativeMirrorWriteQueue: Promise<void> = Promise.resolve();

function enqueueNativeMirrorWrite(write: () => Promise<void>): Promise<void> {
  const next = nativeMirrorWriteQueue.then(write, write);
  nativeMirrorWriteQueue = next.catch((error) => {
    console.error('Android SQLite legacy snapshot migration write failed:', error);
  });
  return next;
}

export async function mirrorNativePosDatabase(): Promise<void> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;

  // A completed migration is immutable. Never import a stale IndexedDB snapshot
  // over the SQLite source of truth on a subsequent application launch.
  const existingMarker = await posLocalDatabase.getMeta({ key: 'business_snapshot_version' });
  if (existingMarker.value === '1') {
    await restoreNativePosDatabase();
    return;
  }

  const legacyStores = await readLegacyIndexedDBStores();
  const unsupportedStores = Object.keys(legacyStores).filter((name) =>
    name !== 'syncOperations' && !MIRRORED_TABLES.includes(name as any) &&
    Array.isArray(legacyStores[name]) && legacyStores[name].length > 0
  );
  if (unsupportedStores.length) {
    throw new Error('توجد جداول IndexedDB قديمة غير مدعومة في ترحيل SQLite: ' + unsupportedStores.join(', '));
  }
  const invalidated = await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: 'in_progress' });
  if (!invalidated.saved) throw new Error('تعذر إبطال علامة لقطة SQLite السابقة');
  const failedEntities: string[] = [];
  for (const entity of MIRRORED_TABLES) {
    try {
      const rows = Array.isArray(legacyStores[entity]) ? legacyStores[entity] : [];
      const businessRows = rows.filter((row: any) => !(entity === 'settings' && row.key === 'authSecret'));
      const records = businessRows.map((row: any) => {
        const recordId = getRecordId(entity, row);
        if (!recordId) throw new Error(`A record in ${entity} has no stable primary-key value; refusing to replace the SQLite snapshot`);
        return {
          recordId,
          record: row as Record<string, unknown>,
          syncState: row.syncStatus === 'pending' || row.syncStatus === 'synced' || row.syncStatus === 'error' ? row.syncStatus : 'local',
        };
      });
      const recordIds = new Set<string>();
      for (const record of records) {
        if (recordIds.has(record.recordId)) throw new Error(`Duplicate primary-key value ${record.recordId} in ${entity}; refusing to replace the SQLite snapshot`);
        recordIds.add(record.recordId);
      }
      await enqueueNativeMirrorWrite(async () => {
        // Merge legacy rows only when the primary key is absent in SQLite.
        // Existing SQLite records always win: a stale IndexedDB copy must never
        // roll back products, settings, stock or transactions created after migration.
        const currentRows = await nativePosRepository.getAllWithSyncState(entity as any);
        const currentIds = new Set(currentRows.map((row) => row.recordId));
        const missingRows = records.filter((record) => !currentIds.has(record.recordId));
        if (missingRows.length) {
          for (const syncState of ['local', 'pending', 'synced', 'error'] as const) {
            const group = missingRows.filter((row) => row.syncState === syncState);
            if (group.length) {
              await nativePosRepository.putMany(
                entity as any,
                group.map((row) => row.record),
                syncState,
              );
            }
          }
        }
      });
    } catch (error) {
      failedEntities.push(entity);
      console.error('تعذر حفظ لقطة SQLite للجدول ' + entity, error);
    }
  }
  if (failedEntities.length > 0) throw new Error('SQLite business snapshot incomplete; failed entities: ' + failedEntities.join(', '));
  const completed = await posLocalDatabase.setMeta({ key: 'business_snapshot_version', value: '1' });
  if (!completed.saved) throw new Error('تعذر تأكيد اكتمال لقطة SQLite');
  notifyNativeEntityChanges(MIRRORED_TABLES);
}

/**
 * Validate the completed SQLite snapshot without opening or hydrating Dexie.
 */
export async function restoreNativePosDatabase(): Promise<boolean> {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return false;
  const snapshotState = await posLocalDatabase.getMeta({ key: 'business_snapshot_version' });
  if (snapshotState.value === 'in_progress') {
    console.warn('Interrupted Android SQLite snapshot detected; legacy local database migration will be retried.');
    return false;
  }
  if (snapshotState.value !== '1') return false;

  // Validate the complete native snapshot without creating a Dexie instance.
  for (const entity of MIRRORED_TABLES) {
    const rows = await nativePosRepository.getAllWithSyncState(entity);
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row.recordId !== 'string' || !row.record ||
          typeof row.record !== 'object' || Array.isArray(row.record)) {
        throw new Error(`SQLite returned an invalid Android snapshot row in ${entity}`);
      }
      const resolvedId = getRecordId(entity, row.record);
      if (!resolvedId || resolvedId !== row.recordId || seen.has(row.recordId)) {
        throw new Error(`SQLite Android snapshot identity validation failed for ${entity}`);
      }
      seen.add(row.recordId);
    }
  }

  // SQLite is the Android source of truth. Do not hydrate a second Dexie copy.
  return true;
}
