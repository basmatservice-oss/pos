import { isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronLocalClient } from '../native/electronPosRepository';
const isLocalSqlite = (): boolean => isNativeAndroid() || isElectronLocalClient();

const isWindowsServer = (): boolean => {
  if (typeof window === 'undefined' || !(window as any).electronAPI?.getDeviceRole) return false;
  return !isElectronLocalClient() && !isNativeAndroid();
};

const SERVER_READ_ENDPOINTS: Partial<Record<NativePosEntity, string>> = {
  categories: '/categories',
  products: '/products',
  customers: '/customers',
  suppliers: '/suppliers',
  orders: '/orders',
  orderItems: '/orderItems',
  returns: '/returns',
  returnItems: '/returnItems',
  accounts: '/accounts',
  journalEntries: '/journalEntries',
  transactions: '/transactions',
  shifts: '/shifts',
  shiftMovements: '/shiftMovements',
  expenses: '/expenses',
  employees: '/employees',
  settings: '/settings',
  attendance: '/attendance',
  loyaltyTransactions: '/loyalty-transactions',
  payroll: '/payroll',
  branches: '/branches',
  offers: '/offers',
  purchases: '/purchases',
  purchaseItems: '/purchaseItems',
  purchaseReturns: '/purchaseReturns',
  purchaseReturnItems: '/purchaseReturnItems',
  customerPayments: '/customerPayments',
  supplierPayments: '/supplierPayments',
  auditLogs: '/auditLogs',
  stocktakingSessions: '/stocktakingSessions',
  stocktakingEntries: '/stocktakingEntries',
  inventoryBatches: '/inventoryBatches',
  serviceRecipes: '/serviceRecipes',
  exchangeRateHistory: '/exchangeRateHistory',
  fiscalPeriods: '/fiscalPeriods',
  inventoryAlerts: '/inventoryAlerts',
};

const SERVER_UPDATE_ENDPOINTS: Partial<Record<NativePosEntity, (record: Record<string, unknown>) => string>> = {
  categories: (r) => `/categories/${encodeURIComponent(String(r.id))}`,
  products: (r) => `/products/${encodeURIComponent(String(r.id))}`,
  customers: (r) => `/customers/${encodeURIComponent(String(r.id))}`,
  suppliers: (r) => `/suppliers/${encodeURIComponent(String(r.id))}`,
  orders: (r) => `/orders/${encodeURIComponent(String(r.id))}`,
  employees: (r) => `/employees/${encodeURIComponent(String(r.id))}`,
  shifts: (r) => `/shifts/${encodeURIComponent(String(r.id))}`,
  attendance: (r) => `/attendance/${encodeURIComponent(String(r.id))}`,
  branches: (r) => `/branches/${encodeURIComponent(String(r.id))}`,
  offers: (r) => `/offers/${encodeURIComponent(String(r.id))}`,
  purchases: (r) => `/purchases/${encodeURIComponent(String(r.id))}`,
  inventoryBatches: (r) => `/inventoryBatches/${encodeURIComponent(String(r.id))}`,
  stocktakingSessions: (r) => `/stocktakingSessions/${encodeURIComponent(String(r.id))}`,
};

const SERVER_DELETE_ENDPOINTS: Partial<Record<NativePosEntity, (key: unknown) => string>> = {
  categories: (key) => `/categories/${encodeURIComponent(String(key))}`,
  products: (key) => `/products/${encodeURIComponent(String(key))}`,
  customers: (key) => `/customers/${encodeURIComponent(String(key))}`,
  suppliers: (key) => `/suppliers/${encodeURIComponent(String(key))}`,
  orderItems: (key) => `/orderItems/${encodeURIComponent(String(key))}`,
  employees: (key) => `/employees/${encodeURIComponent(String(key))}`,
  branches: (key) => `/branches/${encodeURIComponent(String(key))}`,
  offers: (key) => `/offers/${encodeURIComponent(String(key))}`,
  purchases: (key) => `/purchases/${encodeURIComponent(String(key))}`,
  expenses: (key) => `/expenses/${encodeURIComponent(String(key))}`,
  serviceRecipes: (key) => `/serviceRecipes/${encodeURIComponent(String(key))}`,
  stocktakingSessions: (key) => `/stocktakingSessions/${encodeURIComponent(String(key))}`,
};
import { nativePosRepository, notifyNativeEntityChanges, type NativePosEntity, type NativePosSyncState } from '../native/nativePosRepository';

type PosRecord = Record<string, unknown>;

/** Read one business record from the active platform's authoritative database. */
export async function getPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  key: unknown,
): Promise<T | undefined> {
  if (isLocalSqlite()) return (await nativePosRepository.get<T>(entity, key)) ?? undefined;
  if (isWindowsServer()) {
    const endpoint = SERVER_READ_ENDPOINTS[entity];
    if (!endpoint) throw new Error(`No authoritative Windows Server read endpoint is registered for ${entity}`);
    const { apiService } = await import('./apiService');
    const records = await apiService.get(endpoint) as T[];
    return records.find((record) => record.id === key || (entity === 'settings' && record.key === key));
  }
  const { db } = await import('../db/db');
  return await db.table(entity).get(key as any) as T | undefined;
}

/** Read from SQLite on Android/Windows Client and Dexie-backed server cache on Windows Server. */
export async function getPosRecords<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
): Promise<T[]> {
  if (isLocalSqlite()) return nativePosRepository.getAll<T>(entity);
  if (isWindowsServer()) {
    const endpoint = SERVER_READ_ENDPOINTS[entity];
    if (!endpoint) throw new Error(`No authoritative Windows Server read endpoint is registered for ${entity}`);
    const { apiService } = await import('./apiService');
    return await apiService.get(endpoint) as T[];
  }
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
  if (isWindowsServer()) {
    const records = await getPosRecords<T>(entity);
    return records.filter((record) => record[field] === value);
  }
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
  if (isWindowsServer()) return (await getPosRecordsWhereEquals<T>(entity, field, value))[0];
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
  if (isWindowsServer()) {
    const { apiService } = await import('./apiService');
    if (entity === 'settings') {
      if (typeof record.key !== 'string') throw new Error('Windows Server settings require a logical key');
      await apiService.updateSetting(record.key, { value: record.value });
      return;
    }
    const endpoint = SERVER_UPDATE_ENDPOINTS[entity]?.(record);
    if (!endpoint || record.id == null) {
      throw new Error(`No safe Windows Server update endpoint is registered for ${entity}`);
    }
    await apiService.put(endpoint, record);
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
  if (isWindowsServer()) {
    const { apiService } = await import('./apiService');
    if (entity === 'settings') {
      const setting = await getPosRecord<any>('settings', key);
      if (setting?.key) await apiService.delete(`/settings/${encodeURIComponent(String(setting.key))}`);
      return;
    }
    const endpoint = SERVER_DELETE_ENDPOINTS[entity]?.(key);
    if (!endpoint) throw new Error(`No safe Windows Server delete endpoint is registered for ${entity}`);
    await apiService.delete(endpoint);
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
