import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/**
 * Reactive entity reads with SQLite as the Android source of truth.
 * Desktop continues to use Dexie's live query implementation.
 */
export function usePosEntityRecords<T extends Record<string, unknown> = Record<string, unknown>>(
  entity: NativePosEntity,
): T[] {
  const isAndroid = isNativeAndroid();
  const dexieRecords = useLiveQuery(
    () => isAndroid ? Promise.resolve([] as T[]) : db.table(entity).toArray(),
    [entity, isAndroid],
  );
  const [nativeRecords, setNativeRecords] = useState<T[]>([]);

  useEffect(() => {
    if (!isAndroid) return;
    let active = true;
    let refreshVersion = 0;

    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        const records = await nativePosRepository.getAll<T>(entity);
        if (active && version === refreshVersion) setNativeRecords(records);
      } catch (error) {
        console.error(`Failed to read ${entity} from local SQLite:`, error);
      }
    };

    const onNativeChange = (event: Event) => {
      const changedEntities = (event as CustomEvent<{ entities?: string[] }>).detail?.entities;
      if (Array.isArray(changedEntities) && changedEntities.includes(entity)) void refresh();
    };

    window.addEventListener('pos-native-records-changed', onNativeChange);
    void refresh();
    return () => {
      active = false;
      window.removeEventListener('pos-native-records-changed', onNativeChange);
    };
  }, [entity, isAndroid]);

  return (isAndroid ? nativeRecords : dexieRecords ?? []) as T[];
}
