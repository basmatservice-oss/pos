import { useEffect, useState } from 'react';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronDesktop } from '../native/electronPosRepository';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/** Reactive indexed lookup; Android and Electron query SQLite; browser desktop retains Dexie. */
export function usePosRecordsWhereEquals<T extends Record<string, unknown> = Record<string, unknown>>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean | undefined,
): T[] {
  const isLocalSqlite = isNativeAndroid() || isElectronDesktop();
  const [records, setRecords] = useState<T[]>([]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    if (value === undefined) {
      setRecords([]);
      return () => { active = false; };
    }

    const start = async () => {
      if (isLocalSqlite) {
        const refresh = async () => {
          try {
            const rows = await nativePosRepository.whereEquals<T>(entity, field, value);
            if (active) setRecords(rows);
          } catch (error) {
            console.error(`Failed to query ${entity} by ${field} from local SQLite:`, error);
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
        const subscription = liveQuery(() => db.table(entity).where(field).equals(value as any).toArray()).subscribe({
          next: (rows) => { if (active) setRecords(rows as T[]); },
          error: (error) => console.error(`Failed to query ${entity} on desktop:`, error),
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
  }, [entity, field, value, isLocalSqlite]);

  return records;
}
