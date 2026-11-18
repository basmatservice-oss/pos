import { registerPlugin } from '@capacitor/core';

export interface PosLocalRecord {
  entity: string;
  recordId: string;
  record: Record<string, unknown>;
  syncState?: 'local' | 'pending' | 'synced' | 'error';
}

export type PosLocalRecordChange =
  | { action: 'put'; entity: string; recordId: string; record: Record<string, unknown>; syncState?: 'local' | 'pending' | 'synced' | 'error' }
  | { action: 'delete'; entity: string; recordId: string };

export interface PosQueuedOperation {
  operationId: string;
  type: string;
  payload: Record<string, unknown>;
  deviceId?: string;
  tenantId?: string;
  branchId?: string;
  actor?: string;
  schemaVersion?: number;
}

export interface PosLocalDatabasePlugin {
  initialize(): Promise<{ ready: boolean; schemaVersion: number; database: string }>;
  putRecord(options: PosLocalRecord): Promise<{ saved: boolean; recordId: string }>;
  putRecords(options: { records: PosLocalRecord[] }): Promise<{ saved: boolean; count: number }>;
  applyRecordChanges(options: { changes: PosLocalRecordChange[] }): Promise<{ applied: number; count: number }>;
  replaceRecords(options: { entity: string; records: Array<{ recordId: string; record: Record<string, unknown>; syncState?: 'local' | 'pending' | 'synced' | 'error' }> }): Promise<{ replaced: boolean; count: number }>;
  saveRecordAndEnqueueOperation(options: PosLocalRecord & PosQueuedOperation): Promise<{
    saved: boolean;
    queued: boolean;
    duplicate: boolean;
    operationId: string;
  }>;
  getRecordsByField(options: { entity: string; field: string; valueJson: string; limit?: number }): Promise<{ records: Array<{ recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number }> }>;
  getRecords(options: { entity: string }): Promise<{ records: Array<{ recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number }> }>;
  getRecordsByIds(options: { entity: string; recordIds: string[] }): Promise<{ records: Array<{ recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number }> }>;
  getRecord(options: { entity: string; recordId: string }): Promise<{ found: boolean; item?: { recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number } | null }>;
  updateRecordSyncState(options: { entity: string; recordId: string; syncState: 'local' | 'pending' | 'synced' | 'error' }): Promise<{ updated: boolean; rows: number }>;
  deleteRecord(options: { entity: string; recordId: string }): Promise<{ deleted: boolean; rows: number }>;
  deleteRecords(options: { entity: string; recordIds: string[] }): Promise<{ deleted: number }>;
  enqueueOperation(options: PosQueuedOperation): Promise<{ queued: boolean; duplicate: boolean; operationId: string }>;
  listPendingOperations(): Promise<{ operations: Array<PosQueuedOperation & { createdAt: number; retryCount: number; nextRetryAt?: number }> }>;
  updatePendingOperationPayload(options: { operationId: string; payload: Record<string, unknown> }): Promise<{ updated: boolean; rows: number }>;
  acknowledgeOperation(options: { operationId: string }): Promise<{ updated: boolean }>;
  markOperationError(options: { operationId: string; message: string }): Promise<{ updated: boolean }>;
  markOperationConflict(options: { operationId: string; message: string }): Promise<{ updated: boolean }>;
  setMeta(options: { key: string; value: string }): Promise<{ saved: boolean }>;
  getMeta(options: { key: string }): Promise<{ value?: string }>;
}

export const posLocalDatabase = registerPlugin<PosLocalDatabasePlugin>('PosLocalDatabase');

export const isNativeAndroid = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as any).Capacitor &&
  (window as any).Capacitor.getPlatform?.() === 'android';

let nativeDatabaseReady: Promise<boolean> | null = null;

export async function ensureNativePosDatabase(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  if (!nativeDatabaseReady) {
    nativeDatabaseReady = posLocalDatabase.initialize()
      .then((result) => result.ready)
      .catch((error) => {
        nativeDatabaseReady = null;
        throw error;
      });
  }
  return nativeDatabaseReady;
}

export async function enqueueNativePosOperation(operation: PosQueuedOperation): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  const result = await posLocalDatabase.saveRecordAndEnqueueOperation({
    entity: 'operations',
    recordId: operation.operationId,
    record: operation.payload,
    syncState: 'pending',
    ...operation,
  });
  return result.queued;
}

export async function listNativePendingPosOperations() {
  if (!(await ensureNativePosDatabase())) return [];
  const result = await posLocalDatabase.listPendingOperations();
  return result.operations;
}

export async function updateNativePendingOperationPayload(operationId: string, payload: Record<string, unknown>): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  const result = await posLocalDatabase.updatePendingOperationPayload({ operationId, payload });
  return result.updated;
}

export async function acknowledgeNativePosOperation(operationId: string): Promise<void> {
  if (await ensureNativePosDatabase()) {
    await posLocalDatabase.acknowledgeOperation({ operationId });
    await posLocalDatabase.updateRecordSyncState({
      entity: 'operations',
      recordId: operationId,
      syncState: 'synced',
    });
  }
}

export async function markNativePosOperationError(operationId: string, message: string): Promise<void> {
  if (await ensureNativePosDatabase()) {
    await posLocalDatabase.markOperationError({ operationId, message });
    await posLocalDatabase.updateRecordSyncState({
      entity: 'operations',
      recordId: operationId,
      syncState: 'error',
    });
  }
}

export async function markNativePosOperationConflict(operationId: string, message: string): Promise<void> {
  if (await ensureNativePosDatabase()) {
    await posLocalDatabase.markOperationConflict({ operationId, message });
    await posLocalDatabase.updateRecordSyncState({
      entity: 'operations',
      recordId: operationId,
      syncState: 'error',
    });
  }
}

export async function getNativePosRecordsByIds(entity: string, recordIds: string[]) {
  if (!(await ensureNativePosDatabase())) return [];
  if (!entity.trim() || recordIds.length === 0) return [];
  const uniqueIds = Array.from(new Set(recordIds.map((id) => id.trim())));
  if (uniqueIds.some((id) => !id)) throw new Error('Record IDs must not be empty');
  const result = await posLocalDatabase.getRecordsByIds({ entity, recordIds: uniqueIds });
  if (!Array.isArray(result.records)) throw new Error('SQLite returned an invalid record collection');
  const requested = new Set(uniqueIds);
  return result.records.filter((item) =>
    requested.has(item.recordId) && item.record && typeof item.record === 'object'
  );
}

export async function getNativePosRecord(entity: string, recordId: string) {
  if (!(await ensureNativePosDatabase())) return null;
  const result = await posLocalDatabase.getRecord({ entity, recordId });
  if (!result.found || !result.item || result.item.recordId !== recordId) return null;
  return result.item;
}

export async function updateNativePosRecordSyncState(
  entity: string,
  recordId: string,
  syncState: 'local' | 'pending' | 'synced' | 'error'
): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  if (!entity.trim() || !recordId.trim()) return false;
  const result = await posLocalDatabase.updateRecordSyncState({ entity, recordId, syncState });
  return result.updated === true && result.rows === 1;
}

export async function putNativePosRecord(record: PosLocalRecord): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  const result = await posLocalDatabase.putRecord(record);
  return result.saved === true && result.recordId === record.recordId;
}

export async function getNativePosRecordsByField(entity: string, field: string, value: string | number | boolean, limit = 0) {
  if (!(await ensureNativePosDatabase())) return [];
  if (!entity.trim() || !field.trim()) return [];
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) throw new Error('Unsupported SQLite field lookup value');
  const result = await posLocalDatabase.getRecordsByField({ entity, field, valueJson, limit });
  if (!Array.isArray(result.records)) throw new Error('SQLite returned an invalid field lookup result');
  return result.records.filter((item) => item.record && typeof item.record === 'object');
}

export async function getAllNativePosRecords(entity: string) {
  if (!(await ensureNativePosDatabase())) return [];
  if (!entity.trim()) return [];
  const result = await posLocalDatabase.getRecords({ entity });
  if (!Array.isArray(result.records)) throw new Error('SQLite returned an invalid record collection');
  return result.records;
}

export async function deleteNativePosRecords(entity: string, recordIds: string[]): Promise<number> {
  if (!(await ensureNativePosDatabase())) return 0;
  if (!entity.trim() || recordIds.length === 0) return 0;
  const uniqueIds = Array.from(new Set(recordIds.map((id) => id.trim())));
  if (uniqueIds.some((id) => !id)) throw new Error('Record IDs must not be empty');
  const result = await posLocalDatabase.deleteRecords({ entity, recordIds: uniqueIds });
  if (!Number.isInteger(result.deleted) || result.deleted < 0 || result.deleted > uniqueIds.length) {
    throw new Error('SQLite returned an invalid deleted-row count');
  }
  return result.deleted;
}

export async function deleteNativePosRecord(entity: string, recordId: string): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  const result = await posLocalDatabase.deleteRecord({ entity, recordId });
  return result.deleted;
}

export async function putNativePosRecords(records: PosLocalRecord[]): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  if (records.length === 0) return true;
  const result = await posLocalDatabase.putRecords({ records });
  return result.saved === true && result.count === records.length;
}

export async function replaceNativePosRecords(
  entity: string,
  records: Array<{ recordId: string; record: Record<string, unknown>; syncState?: 'local' | 'pending' | 'synced' | 'error' }>
): Promise<boolean> {
  if (!(await ensureNativePosDatabase())) return false;
  const result = await posLocalDatabase.replaceRecords({ entity, records });
  return result.replaced === true && result.count === records.length;
}

export async function applyNativePosRecordChanges(changes: PosLocalRecordChange[]): Promise<number> {
  if (!(await ensureNativePosDatabase())) return 0;
  if (changes.length === 0) return 0;
  const identities = new Set<string>();
  for (const change of changes) {
    if (!change.entity.trim() || !change.recordId.trim()) {
      throw new Error('Native SQLite record changes require entity and record ID');
    }
    const identity = JSON.stringify([change.entity, change.recordId]);
    if (identities.has(identity)) throw new Error('Duplicate native SQLite record change');
    identities.add(identity);
    if (change.action === 'put' && (!change.record || typeof change.record !== 'object' || Array.isArray(change.record))) {
      throw new Error('Native SQLite put changes require a record object');
    }
  }
  const result = await posLocalDatabase.applyRecordChanges({ changes });
  if (!Number.isInteger(result.count) || result.count !== changes.length ||
      !Number.isInteger(result.applied) || result.applied < 0 || result.applied > changes.length) {
    throw new Error('SQLite returned an invalid atomic record-change result');
  }
  return result.applied;
}
