import { isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronLocalClient } from '../native/electronPosRepository';
const isLocalSqlite = (): boolean => isNativeAndroid() || isElectronLocalClient();
import { nativePosRepository, notifyNativeEntityChanges, type NativePosEntity, type NativePosSyncState } from '../native/nativePosRepository';

type PosRecord = Record<string, unknown>;

/** Read one business record from the active platform's authoritative database. */
export async function getPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  key: unknown,
): Promise<T | undefined> {
  if (isLocalSqlite()) return (await nativePosRepository.get<T>(entity, key)) ?? undefined;
  const { db } = await import('../db/db');
  return await db.table(entity).get(key as any) as T | undefined;
}

/** Read from SQLite on Android/Windows Client and Dexie-backed server cache on Windows Server. */
export async function getPosRecords<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
): Promise<T[]> {
  if (isLocalSqlite()) return nativePosRepository.getAll<T>(entity);
  const { db } = await import('../db/db');
  return await db.table(entity).toArray() as T[];
}

/** Equality-filtered reads are executed by SQLite on Android, not in the Dexie cache. */
export async function getPosRecordsWhereEquals<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T[]> {
  if (isLocalSqlite()) return nativePosRepository.whereEquals<T>(entity, field, value);
  const { db } = await import('../db/db');
  return await db.table(entity).where(field).equals(value as any).toArray() as T[];
}

/** Return the first equality match using the platform's primary data store. */
export async function getFirstPosRecordWhereEquals<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T | undefined> {
  if (isLocalSqlite()) return (await nativePosRepository.firstWhereEquals<T>(entity, field, value)) ?? undefined;
  const { db } = await import('../db/db');
  return await db.table(entity).where(field).equals(value as any).first() as T | undefined;
}

/** Persist one record through the active platform's primary database. */
export async function putPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  record: T,
  syncState: NativePosSyncState = 'local',
): Promise<void> {
  if (isLocalSqlite()) {
    await nativePosRepository.put(entity, record, syncState);
    return;
  }
  const { db } = await import('../db/db');
  await db.table(entity).put(record as any);
}

/** Delete one record from the active platform's primary database. */
export async function deletePosRecord(
  entity: NativePosEntity,
  key: unknown,
): Promise<void> {
  if (isLocalSqlite()) {
    const deleted = await nativePosRepository.delete(entity, key);
    if (!deleted) throw new Error(`Could not delete ${entity} record from SQLite`);
    return;
  }
  const { db } = await import('../db/db');
  await db.table(entity).delete(key as any);
}

let generatedSettingId = 0;

/** Upsert a setting by its logical key while retaining the native/Dexie primary id. */
export async function putPosSetting(
  key: string,
  value: unknown,
  syncStatus: NativePosSyncState = 'local',
): Promise<void> {
  const matches = await getPosRecordsWhereEquals<any>('settings', 'key', key);
  const existing = matches[0];
  const now = new Date().toISOString();
  const id = existing?.id ?? (Date.now() * 1000 + (++generatedSettingId % 1000));
  const record = {
    ...existing,
    id,
    key,
    value,
    syncStatus,
    updatedAt: now,
  };

  if (isLocalSqlite()) {
    // Keep logical-key deduplication and the replacement in one SQLite transaction.
    const changes = [
      ...matches.slice(1).filter((item) => item.id != null).map((item) => ({
        action: 'delete' as const, entity: 'settings' as const, key: item.id,
      })),
      { action: 'put' as const, entity: 'settings' as const, record, syncState: syncStatus },
    ];
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('SQLite did not confirm the complete settings upsert');
    notifyNativeEntityChanges(['settings']);
    return;
  }

  for (const duplicate of matches.slice(1)) {
    if (duplicate.id != null) await deletePosRecord('settings', duplicate.id);
  }
  await putPosRecord('settings', record, syncStatus);
}

/** Remove every row for a logical setting key. */
export async function deletePosSettingsByKey(key: string): Promise<void> {
  const matches = await getPosRecordsWhereEquals<any>('settings', 'key', key);
  if (isLocalSqlite()) {
    const changes = matches.filter((record) => record.id != null).map((record) => ({
      action: 'delete' as const, entity: 'settings' as const, key: record.id,
    }));
    if (!changes.length) return;
    const deleted = await nativePosRepository.applyChanges(changes);
    if (deleted !== changes.length) throw new Error('SQLite did not confirm deletion of every matching setting');
    notifyNativeEntityChanges(['settings']);
    return;
  }
  for (const record of matches) {
    if (record.id != null) await deletePosRecord('settings', record.id);
  }
}
