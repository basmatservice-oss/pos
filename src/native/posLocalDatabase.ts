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
  branchId?: string;
}

export interface PosLocalDatabasePlugin {
  initialize(): Promise<{ ready: boolean; schemaVersion: number; database: string }>;
  putRecord(options: PosLocalRecord): Promise<{ saved: boolean; recordId: string }>;
  getRecords(options: { entity: string }): Promise<{ records: Array<{ record: Record<string, unknown>; syncState: string; updatedAt: number }> }>;
  enqueueOperation(options: PosQueuedOperation): Promise<{ queued: boolean; operationId: string }>;
  listPendingOperations(): Promise<{ operations: Array<PosQueuedOperation & { createdAt: number; retryCount: number }> }>;
  acknowledgeOperation(options: { operationId: string }): Promise<{ updated: boolean }>;
  markOperationError(options: { operationId: string; message: string }): Promise<{ updated: boolean }>;
  setMeta(options: { key: string; value: string }): Promise<{ saved: boolean }>;
  getMeta(options: { key: string }): Promise<{ value?: string }>;
}

export const posLocalDatabase = registerPlugin<PosLocalDatabasePlugin>('PosLocalDatabase');

export const isNativeAndroid = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as any).Capacitor &&
  (window as any).Capacitor.getPlatform?.() === 'android';
