import { useEffect, useState } from 'react';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronDesktop, isElectronLocalClient } from '../native/electronPosRepository';
import { getPosRecords, getPosRecordsWhereEquals, getFirstPosRecordWhereEquals } from '../services/posDataAccess';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/** Reactive first-match lookup; Android and Electron query SQLite; browser desktop retains Dexie. */
export function usePosFirstRecordWhereEquals<T extends Record<string, unknown> = Record<string, unknown>>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): T | undefined {
  const isLocalSqlite = isNativeAndroid() || isElectronLocalClient();
  const isWindowsServer = isElectronDesktop() && !isElectronLocalClient();
  const [record, setRecord] = useState<T | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    const start = async () => {
      if (isWindowsServer) {
        const refresh = async () => {
          try {
            const row = await getFirstPosRecordWhereEquals<T>(entity, field, value);
            if (active) setRecord(row);
          } catch (error) {
            console.error(`Failed to query ${entity} from Windows Server API:`, error);
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
          try {
            const row = await nativePosRepository.firstWhereEquals<T>(entity, field, value);
            if (active) setRecord(row ?? undefined);
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
        const subscription = liveQuery(() => db.table(entity).where(field).equals(value as any).first()).subscribe({
          next: (row) => { if (active) setRecord(row as T | undefined); },
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

  return record;
}
