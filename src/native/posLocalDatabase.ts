import { registerPlugin } from '@capacitor/core';

export interface PosLocalRecord {
  entity: string;
  recordId: string;
  record: Record<string, unknown>;
  syncState?: 'local' | 'pending' | 'synced' | 'error';
}

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
  replaceRecords(options: { entity: string; records: Array<{ recordId: string; record: Record<string, unknown>; syncState?: 'local' | 'pending' | 'synced' | 'error' }> }): Promise<{ replaced: boolean; count: number }>;
  saveRecordAndEnqueueOperation(options: PosLocalRecord & PosQueuedOperation): Promise<{
    saved: boolean;
    queued: boolean;
    duplicate: boolean;
    operationId: string;
  }>;
  getRecords(options: { entity: string }): Promise<{ records: Array<{ recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number }> }>;
  getRecord(options: { entity: string; recordId: string }): Promise<{ found: boolean; item?: { recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number } | null }>;
  updateRecordSyncState(options: { entity: string; recordId: string; syncState: 'local' | 'pending' | 'synced' | 'error' }): Promise<{ updated: boolean; rows: number }>;
  deleteRecord(options: { entity: string; recordId: string }): Promise<{ deleted: boolean; rows: number }>;
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

export async function getNativePosRecord(entity: string, recordId: string) {
  if (!(await ensureNativePosDatabase())) return null;
  const result = await posLocalDatabase.getRecord({ entity, recordId });
  if (!result.found || !result.item || result.item.recordId !== recordId) return null;
  return result.item;
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
