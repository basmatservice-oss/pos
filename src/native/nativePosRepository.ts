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

const NATIVE_PRIMARY_KEYS = {
  products: 'id',
  categories: 'id',
  orders: 'id',
  orderItems: 'id',
  returns: 'id',
  returnItems: 'id',
  accounts: 'code',
  shifts: 'id',
  shiftMovements: 'id',
  customers: 'id',
  customerPayments: 'id',
  expenses: 'id',
  suppliers: 'id',
  supplierPayments: 'id',
  employees: 'id',
  settings: 'id',
  purchases: 'id',
  purchaseItems: 'id',
  purchaseReturns: 'id',
  purchaseReturnItems: 'id',
  attendance: 'id',
  loyaltyTransactions: 'id',
  branches: 'id',
  payroll: 'id',
  offers: 'id',
  auditLogs: 'id',
  journalEntries: 'id',
  transactions: 'id',
  stocktakingSessions: 'id',
  stocktakingEntries: 'id',
  inventoryBatches: 'id',
  inventoryAlerts: 'id',
  heldOrders: 'id',
  serviceRecipes: 'id',
  exchangeRateHistory: 'id',
  fiscalPeriods: 'id',
  unitDefinitions: 'code',
  productUnits: 'id',
  inventoryMovements: 'id',
} as const;

export type NativePosEntity = keyof typeof NATIVE_PRIMARY_KEYS;

// Keep the mirror entity list derived from the same key registry to prevent schema drift.
// syncOperations is intentionally excluded: Android stores its durable queue in pos_outbox.
export const NATIVE_POS_ENTITIES = Object.keys(NATIVE_PRIMARY_KEYS) as NativePosEntity[];

function assertEntity(entity: string): asserts entity is NativePosEntity {
  if (!Object.prototype.hasOwnProperty.call(NATIVE_PRIMARY_KEYS, entity)) {
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
  return serializeKey(record[NATIVE_PRIMARY_KEYS[entity]]);
}

export function getNativePosRecordId(entity: string, record: Record<string, unknown>): string {
  assertEntity(entity);
  return recordIdFor(entity, record);
}

function recordIdForKey(_entity: NativePosEntity, key: unknown): string {
  return serializeKey(key);
}

function notifyNativeEntityChanges(entities: Iterable<NativePosEntity>): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const changed = Array.from(new Set(entities));
  if (!changed.length) return;
  window.dispatchEvent(new CustomEvent('pos-native-records-changed', { detail: { entities: changed } }));
}

function requireAndroid(): void {
  if (!isNativeAndroid()) throw new Error('The native POS repository is available only on Android');
}

async function readEquals<T extends Record<string, unknown>>(
  entity: NativePosEntity,
  fieldName: string,
  value: string | number | boolean,
  limit = 0,
): Promise<T[]> {
  requireAndroid();
  assertEntity(entity);
  if (!fieldName.trim()) throw new Error('A field name is required');
  const items = await getNativePosRecordsByField(entity, fieldName, value, limit);
  return items.map((item) => item.record as T);
}

export type NativePosSyncState = 'local' | 'pending' | 'synced' | 'error';

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
    fieldName: string,
    value: string | number | boolean,
  ): Promise<T[]> {
    return readEquals<T>(entity, fieldName, value);
  },

  async firstWhereEquals<T extends Record<string, unknown>>(
    entity: NativePosEntity,
    fieldName: string,
    value: string | number | boolean,
  ): Promise<T | null> {
    const records = await readEquals<T>(entity, fieldName, value, 1);
    return records[0] ?? null;
  },

  async getAll<T extends Record<string, unknown>>(entity: NativePosEntity): Promise<T[]> {
    requireAndroid();
    assertEntity(entity);
    const items = await getAllNativePosRecords(entity);
    return items.map((item) => item.record as T);
  },

  async getAllWithSyncState(entity: NativePosEntity): Promise<Array<{
    record: Record<string, unknown>;
    recordId: string;
    syncState: NativePosSyncState;
  }>> {
    requireAndroid();
    assertEntity(entity);
    const items = await getAllNativePosRecords(entity);
    return items.map((item) => ({
      record: item.record,
      recordId: item.recordId,
      syncState: item.syncState ?? 'local',
    }));
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
    notifyNativeEntityChanges([entity]);
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
    if (entries.length) notifyNativeEntityChanges([entity]);
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
    const applied = await applyNativePosRecordChanges(nativeChanges);
    if (applied > 0) notifyNativeEntityChanges(nativeChanges.map((change) => change.entity));
    return applied;
  },

  async delete(entity: NativePosEntity, key: unknown): Promise<boolean> {
    requireAndroid();
    assertEntity(entity);
    const deleted = await deleteNativePosRecord(entity, serializeKey(key));
    if (deleted) notifyNativeEntityChanges([entity]);
    return deleted;
  },

  async deleteMany(entity: NativePosEntity, keys: unknown[]): Promise<number> {
    requireAndroid();
    assertEntity(entity);
    const deleted = await deleteNativePosRecords(entity, Array.from(new Set(keys.map(serializeKey))));
    if (deleted > 0) notifyNativeEntityChanges([entity]);
    return deleted;
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
    notifyNativeEntityChanges([entity]);
  },
};
