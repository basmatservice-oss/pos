import { db } from '../db/db';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository, type NativePosEntity, type NativePosSyncState } from '../native/nativePosRepository';

type PosRecord = Record<string, unknown>;

/** Read one business record from the active platform's authoritative database. */
export async function getPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  key: unknown,
): Promise<T | undefined> {
  if (isNativeAndroid()) return (await nativePosRepository.get<T>(entity, key)) ?? undefined;
  return await db.table(entity).get(key as any) as T | undefined;
}

/** Read all records from SQLite on Android and Dexie on desktop. */
export async function getPosRecords<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
): Promise<T[]> {
  if (isNativeAndroid()) return nativePosRepository.getAll<T>(entity);
  return await db.table(entity).toArray() as T[];
}

/** Equality-filtered reads are executed by SQLite on Android, not in the Dexie cache. */
export async function getPosRecordsWhereEquals<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T[]> {
  if (isNativeAndroid()) return nativePosRepository.whereEquals<T>(entity, field, value);
  return await db.table(entity).where(field).equals(value as any).toArray() as T[];
}

/** Return the first equality match using the platform's primary data store. */
export async function getFirstPosRecordWhereEquals<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T | undefined> {
  if (isNativeAndroid()) return (await nativePosRepository.firstWhereEquals<T>(entity, field, value)) ?? undefined;
  return await db.table(entity).where(field).equals(value as any).first() as T | undefined;
}

/** Persist one record through the active platform's primary database. */
export async function putPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  record: T,
  syncState: NativePosSyncState = 'local',
): Promise<void> {
  if (isNativeAndroid()) {
    await nativePosRepository.put(entity, record, syncState);
    return;
  }
  await db.table(entity).put(record as any);
}

/** Delete one record from the active platform's primary database. */
export async function deletePosRecord(
  entity: NativePosEntity,
  key: unknown,
): Promise<void> {
  if (isNativeAndroid()) {
    const deleted = await nativePosRepository.delete(entity, key);
    if (!deleted) throw new Error(`Could not delete ${entity} record from SQLite`);
    return;
  }
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
  for (const duplicate of matches.slice(1)) {
    if (duplicate.id != null) await deletePosRecord('settings', duplicate.id);
  }
  const now = new Date().toISOString();
  const id = existing?.id ?? (Date.now() * 1000 + (++generatedSettingId % 1000));
  await putPosRecord('settings', {
    ...existing,
    id,
    key,
    value,
    syncStatus,
    updatedAt: now,
  }, syncStatus);
}

/** Remove every row for a logical setting key. */
export async function deletePosSettingsByKey(key: string): Promise<void> {
  const matches = await getPosRecordsWhereEquals<any>('settings', 'key', key);
  for (const record of matches) {
    if (record.id != null) await deletePosRecord('settings', record.id);
  }
}
