import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { nativePosRepository, type NativePosEntity } from '../native/nativePosRepository';

/** Reactive indexed equality lookup; Android queries SQLite directly. */
export function usePosFirstRecordWhereEquals<T extends Record<string, unknown> = Record<string, unknown>>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): T | undefined {
  const isAndroid = isNativeAndroid();
  const dexieRecord = useLiveQuery(
    () => isAndroid ? Promise.resolve(undefined) : db.table(entity).where(field).equals(value as any).first(),
    [entity, field, value, isAndroid],
  );
  const [nativeRecord, setNativeRecord] = useState<T | undefined>(undefined);

  useEffect(() => {
    if (!isAndroid) return;
    let active = true;
    let refreshVersion = 0;
    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        const record = await nativePosRepository.firstWhereEquals<T>(entity, field, value);
        if (active && version === refreshVersion) setNativeRecord(record ?? undefined);
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

  return (isAndroid ? nativeRecord : dexieRecord) as T | undefined;
}
