import { useEffect, useState } from 'react';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronDesktop, isElectronLocalClient } from '../native/electronPosRepository';
import { getPosRecords, getPosRecordsWhereEquals, getFirstPosRecordWhereEquals } from '../services/posDataAccess';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/**
 * Reactive entity reads with SQLite as the local source of truth on Android and Electron.
 * Dexie is loaded dynamically only for desktop compatibility.
 */
export function usePosEntityRecords<T extends object = Record<string, unknown>>(
  entity: NativePosEntity,
): T[] {
  const isLocalSqlite = isNativeAndroid() || isElectronLocalClient();
  const isWindowsServer = isElectronDesktop() && !isElectronLocalClient();
  const [records, setRecords] = useState<T[]>([]);

  useEffect(() => {
    let active = true;
    let refreshGeneration = 0;
    let unsubscribe: (() => void) | undefined;

    const start = async () => {
      if (isWindowsServer) {
        const refresh = async () => {
          const generation = ++refreshGeneration;
          try {
            const rows = await getPosRecords(entity) as unknown as T[];
            if (active && generation === refreshGeneration) setRecords(rows);
          } catch (error) {
            console.error(`Failed to read ${entity} from Windows Server API:`, error);
          }
        };
        const onServerChange = (event: Event) => {
          const changed = (event as CustomEvent<{ entity?: string }>).detail?.entity;
          if (changed === entity) void refresh();
        };
        window.addEventListener('pos-server-record-changed', onServerChange);
        window.addEventListener('focus', refresh);
        unsubscribe = () => {
          window.removeEventListener('pos-server-record-changed', onServerChange);
          window.removeEventListener('focus', refresh);
        };
        await refresh();
        return;
      }

      if (isLocalSqlite) {
        const refresh = async () => {
          const generation = ++refreshGeneration;
          try {
            const rows = await nativePosRepository.getAll(entity) as unknown as T[];
            if (active && generation === refreshGeneration) setRecords(rows);
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
