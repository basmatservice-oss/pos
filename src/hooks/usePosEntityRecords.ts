import { useEffect, useState } from 'react';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { electronPosRepository, isElectronDesktop } from '../native/electronPosRepository';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/**
 * Reactive entity reads with SQLite as Android and Electron SQLite as their local source of truth.
 * Dexie is loaded dynamically only for desktop compatibility.
 */
export function usePosEntityRecords<T extends Record<string, unknown> = Record<string, unknown>>(
  entity: NativePosEntity,
): T[] {
  const isLocalSqlite = isNativeAndroid() || isElectronDesktop();
  const repository = isNativeAndroid() ? nativePosRepository : electronPosRepository;
  const [records, setRecords] = useState<T[]>([]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    const start = async () => {
      if (isLocalSqlite) {
        const refresh = async () => {
          try {
            const rows = await repository.getAll<T>(entity);
            if (active) setRecords(rows);
          } catch (error) {
            console.error(`Failed to read ${entity} from local SQLite:`, error);
          }
        };
        const onNativeChange = (event: Event) => {
          const changed = (event as CustomEvent<{ entities?: string[] }>).detail?.entities;
          if (Array.isArray(changed) && changed.includes(entity)) void refresh();
        };
        window.addEventListener('pos-native-records-changed', onNativeChange);
        unsubscribe = () => window.removeEventListener('pos-native-records-changed', onNativeChange);
        await refresh();
        return;
      }

      try {
        const [{ liveQuery }, { db }] = await Promise.all([
          import('dexie'),
          import('../db/db'),
        ]);
        if (!active) return;
        const subscription = liveQuery(() => db.table(entity).toArray()).subscribe({
          next: (rows) => { if (active) setRecords(rows as T[]); },
          error: (error) => console.error(`Failed to read ${entity} from desktop database:`, error),
        });
        unsubscribe = () => subscription.unsubscribe();
      } catch (error) {
        console.error(`Failed to initialize desktop query for ${entity}:`, error);
      }
    };

    void start();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [entity, isLocalSqlite]);

  return records;
}
