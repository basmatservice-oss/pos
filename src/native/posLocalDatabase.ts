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
  saveRecordAndEnqueueOperation(options: PosLocalRecord & PosQueuedOperation): Promise<{
    saved: boolean;
    queued: boolean;
    duplicate: boolean;
    operationId: string;
  }>;
  getRecords(options: { entity: string }): Promise<{ records: Array<{ recordId: string; record: Record<string, unknown>; syncState: string; updatedAt: number }> }>;
  updateRecordSyncState(options: { entity: string; recordId: string; syncState: 'local' | 'pending' | 'synced' | 'error' }): Promise<{ updated: boolean; rows: number }>;
  enqueueOperation(options: PosQueuedOperation): Promise<{ queued: boolean; duplicate: boolean; operationId: string }>;
  listPendingOperations(): Promise<{ operations: Array<PosQueuedOperation & { createdAt: number; retryCount: number; nextRetryAt?: number }> }>;
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
