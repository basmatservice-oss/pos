import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/** Reactive indexed collection lookup; Android executes the equality query in SQLite. */
export function usePosRecordsWhereEquals<T extends Record<string, unknown> = Record<string, unknown>>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean | undefined,
): T[] {
  const isAndroid = isNativeAndroid();
  const dexieRecords = useLiveQuery(
    () => value === undefined
      ? Promise.resolve([] as T[])
      : isAndroid
        ? Promise.resolve([] as T[])
        : db.table(entity).where(field).equals(value as any).toArray(),
    [entity, field, value, isAndroid],
  );
  const [nativeRecords, setNativeRecords] = useState<T[]>([]);

  useEffect(() => {
    if (!isAndroid || value === undefined) {
      if (isAndroid) setNativeRecords([]);
      return;
    }
    let active = true;
    let refreshVersion = 0;
    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        const records = await nativePosRepository.whereEquals<T>(entity, field, value);
        if (active && version === refreshVersion) setNativeRecords(records);
      } catch (error) {
        console.error(`Failed to query ${entity} by ${field} from local SQLite:`, error);
      }
    };
    const onNativeChange = (event: Event) => {
      const entities = (event as CustomEvent<{ entities?: string[] }>).detail?.entities;
      if (Array.isArray(entities) && entities.includes(entity)) void refresh();
    };
    window.addEventListener('pos-native-records-changed', onNativeChange);
    void refresh();
    return () => {
      active = false;
      window.removeEventListener('pos-native-records-changed', onNativeChange);
    };
  }, [entity, field, value, isAndroid]);

  return (isAndroid ? nativeRecords : dexieRecords ?? []) as T[];
}
