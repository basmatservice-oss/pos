import { db } from '../db/db';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

type PosRecord = Record<string, unknown>;

/** Read one business record from the active platform's authoritative database. */
export async function getPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  key: unknown,
): Promise<T | undefined> {
  if (isNativeAndroid()) return (await nativePosRepository.get<T>(entity, key)) ?? undefined;
  return await db.table(entity).get(key) as T | undefined;
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
  return await db.table(entity).where(field).equals(value).toArray() as T[];
}

/** Return the first equality match using the platform's primary data store. */
export async function getFirstPosRecordWhereEquals<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T | undefined> {
  if (isNativeAndroid()) return (await nativePosRepository.firstWhereEquals<T>(entity, field, value)) ?? undefined;
  return await db.table(entity).where(field).equals(value).first() as T | undefined;
}
