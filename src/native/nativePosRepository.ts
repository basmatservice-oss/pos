import { db } from '../db/db';
import {
  applyNativePosRecordChanges,
  deleteNativePosRecord,
  deleteNativePosRecords,
  ensureNativePosDatabase,
  getAllNativePosRecords,
  getNativePosRecord,
  getNativePosRecordsByIds,
  getNativePosRecordsByField,
  isNativeAndroid,
  putNativePosRecord,
  putNativePosRecords,
  updateNativePosRecordSyncState,
  type PosLocalRecord,
  type PosLocalRecordChange,
} from './posLocalDatabase';

const NATIVE_ENTITIES = [
  'products', 'categories', 'orders', 'orderItems', 'returns', 'returnItems', 'accounts', 'shifts',
  'shiftMovements', 'customers', 'customerPayments', 'expenses', 'suppliers', 'supplierPayments',
  'employees', 'settings', 'purchases', 'purchaseItems', 'purchaseReturns', 'purchaseReturnItems',
  'attendance', 'loyaltyTransactions', 'branches', 'payroll', 'offers', 'auditLogs', 'journalEntries',
  'transactions', 'stocktakingSessions', 'stocktakingEntries', 'inventoryBatches', 'inventoryAlerts',
  'heldOrders', 'serviceRecipes', 'exchangeRateHistory', 'fiscalPeriods', 'unitDefinitions',
  'productUnits', 'inventoryMovements',
] as const;

export type NativePosEntity = typeof NATIVE_ENTITIES[number];
export type NativePosSyncState = 'local' | 'pending' | 'synced' | 'error';

function assertEntity(entity: string): asserts entity is NativePosEntity {
  if (!(NATIVE_ENTITIES as readonly string[]).includes(entity)) {
    throw new Error(`Unsupported native POS entity: ${entity}`);
  }
}

function serializeKey(value: unknown): string {
  if (value === undefined || value === null) {
    throw new Error('A native POS record must have a complete primary key');
  }
  const serialized = JSON.stringify(value);
  if (!serialized) throw new Error('Could not serialize native POS primary key');
  return serialized;
}

function recordIdFor(entity: NativePosEntity, record: Record<string, unknown>): string {
  const table = (db as any)[entity];
  const keyPath = table?.schema?.primKey?.keyPath;
  if (Array.isArray(keyPath)) {
    const key = keyPath.map((part: string) => record[part]);
    if (key.some((part: unknown) => part === undefined || part === null)) {
      throw new Error(`Incomplete compound primary key for ${entity}`);
    }
    return serializeKey(key);
  }
  if (typeof keyPath !== 'string') throw new Error(`Missing Dexie primary-key schema for ${entity}`);
  return serializeKey(record[keyPath]);
}

function recordIdForKey(entity: NativePosEntity, key: unknown): string {
  return serializeKey(key);
}

function requireAndroid(): void {
  if (!isNativeAndroid()) throw new Error('The native POS repository is available only on Android');
}

async function readEquals<T extends Record<string, unknown>>(
  entity: NativePosEntity,
  indexName: string,
  value: string | number | boolean,
  limit = 0,
): Promise<T[]> {
  requireAndroid();
  assertEntity(entity);
  if (!indexName.trim()) throw new Error('A Dexie index name is required');
  const table = (db as any)[entity];
  const indexes = [table?.schema?.primKey, ...(table?.schema?.indexes ?? [])];
  const index = indexes.find((candidate: any) =>
    candidate?.name === indexName || candidate?.keyPath === indexName
  );
  if (!index || Array.isArray(index.keyPath)) {
    throw new Error(`Unsupported or unknown scalar index ${indexName} on ${entity}`);
  }
  const items = await getNativePosRecordsByField(entity, indexName, value, limit);
  return items.map((item) => item.record as T);
}

export const nativePosRepository = {
  async isReady(): Promise<boolean> {
    return ensureNativePosDatabase();
  },

  async get<T extends Record<string, unknown>>(entity: NativePosEntity, key: unknown): Promise<T | null> {
    requireAndroid();
    assertEntity(entity);
    const item = await getNativePosRecord(entity, serializeKey(key));
    return item ? item.record as T : null;
  },

  async getMany<T extends Record<string, unknown>>(
    entity: NativePosEntity,
    keys: unknown[],
  ): Promise<T[]> {
    requireAndroid();
    assertEntity(entity);
    const ids = Array.from(new Set(keys.map(serializeKey)));
    const items = await getNativePosRecordsByIds(entity, ids);
    const byId = new Map(items.map((item) => [item.recordId, item.record as T]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  },

  async whereEquals<T extends Record<string, unknown>>(
    entity: NativePosEntity,
    indexName: string,
    value: string | number | boolean,
  ): Promise<T[]> {
    return readEquals<T>(entity, indexName, value);
  },

  async firstWhereEquals<T extends Record<string, unknown>>(
    entity: NativePosEntity,
    indexName: string,
    value: string | number | boolean,
  ): Promise<T | null> {
    const records = await readEquals<T>(entity, indexName, value, 1);
    return records[0] ?? null;
  },

  async getAll<T extends Record<string, unknown>>(entity: NativePosEntity): Promise<T[]> {
    requireAndroid();
    assertEntity(entity);
    const items = await getAllNativePosRecords(entity);
    return items.map((item) => item.record as T);
  },

  async put(
    entity: NativePosEntity,
    record: Record<string, unknown>,
    syncState: NativePosSyncState = 'local',
  ): Promise<void> {
    requireAndroid();
    assertEntity(entity);
    const entry: PosLocalRecord = { entity, recordId: recordIdFor(entity, record), record, syncState };
    if (!(await putNativePosRecord(entry))) throw new Error(`SQLite did not confirm saving ${entity}`);
  },

  async putMany(
    entity: NativePosEntity,
    records: Record<string, unknown>[],
    syncState: NativePosSyncState = 'local',
  ): Promise<void> {
    requireAndroid();
    assertEntity(entity);
    const entries = records.map((record) => ({
      entity, recordId: recordIdFor(entity, record), record, syncState,
    }));
    if (!(await putNativePosRecords(entries))) throw new Error(`SQLite did not confirm saving all ${entity} records`);
  },

  async applyChanges(changes: Array<
    | { action: 'put'; entity: NativePosEntity; record: Record<string, unknown>; syncState?: NativePosSyncState }
    | { action: 'delete'; entity: NativePosEntity; key: unknown }
  >): Promise<number> {
    requireAndroid();
    const nativeChanges: PosLocalRecordChange[] = changes.map((change) => {
      assertEntity(change.entity);
      if (change.action === 'delete') {
        return { action: 'delete', entity: change.entity, recordId: recordIdForKey(change.entity, change.key) };
      }
      return {
        action: 'put',
        entity: change.entity,
        recordId: recordIdFor(change.entity, change.record),
        record: change.record,
        syncState: change.syncState ?? 'local',
      };
    });
    return applyNativePosRecordChanges(nativeChanges);
  },

  async delete(entity: NativePosEntity, key: unknown): Promise<boolean> {
    requireAndroid();
    assertEntity(entity);
    return deleteNativePosRecord(entity, serializeKey(key));
  },

  async deleteMany(entity: NativePosEntity, keys: unknown[]): Promise<number> {
    requireAndroid();
    assertEntity(entity);
    return deleteNativePosRecords(entity, Array.from(new Set(keys.map(serializeKey))));
  },

  async setSyncState(
    entity: NativePosEntity,
    key: unknown,
    syncState: NativePosSyncState,
  ): Promise<void> {
    requireAndroid();
    assertEntity(entity);
    if (!(await updateNativePosRecordSyncState(entity, serializeKey(key), syncState))) {
      throw new Error(`SQLite did not confirm sync-state update for ${entity}`);
    }
  },
};
