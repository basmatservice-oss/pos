import type { NativePosEntity, NativePosSyncState } from './nativePosRepository';
import { getNativePosRecordId } from './nativePosRepository';

type ElectronRecord = { recordId: string; record: Record<string, unknown>; syncState: NativePosSyncState; updatedAt: number };
type ElectronDatabaseBridge = {
  initialize(): Promise<{ ready: boolean }>;
  getRecords(entity: string): Promise<ElectronRecord[]>;
  getRecord(entity: string, recordId: string): Promise<{ found: boolean; item?: ElectronRecord | null }>;
  putRecords(records: Array<{ entity: string; recordId: string; record: Record<string, unknown>; syncState: NativePosSyncState }>): Promise<{ saved: boolean; count: number }>;
  applyRecordChanges(changes: Array<{ action: 'put' | 'delete'; entity: string; recordId: string; record?: Record<string, unknown>; syncState?: NativePosSyncState }>): Promise<{ applied: number; count: number }>;
};

function notifyElectronEntityChanges(entities: string[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('pos-native-records-changed', { detail: { entities: Array.from(new Set(entities)) } }));
}

function bridge(): ElectronDatabaseBridge {
  const api = typeof window !== 'undefined' ? (window as any).electronAPI?.posLocalDatabase : null;
  if (!api) throw new Error('Electron local SQLite bridge is unavailable');
  return api as ElectronDatabaseBridge;
}

export function isElectronDesktop(): boolean {
  return typeof window !== 'undefined' && (window as any).electronAPI?.isElectron === true;
}

export const electronPosRepository = {
  async isReady(): Promise<boolean> {
    const result = await bridge().initialize();
    return result.ready === true;
  },
  async get<T extends Record<string, unknown>>(entity: NativePosEntity, key: unknown): Promise<T | null> {
    await this.isReady();
    const recordId = JSON.stringify(key);
    const result = await bridge().getRecord(entity, recordId);
    return result.found && result.item ? result.item.record as T : null;
  },
  async getAll<T extends Record<string, unknown>>(entity: NativePosEntity): Promise<T[]> {
    await this.isReady();
    const rows = await bridge().getRecords(entity);
    if (!Array.isArray(rows)) throw new Error('Electron SQLite returned an invalid record list');
    return rows.map(row => row.record as T);
  },
  async getAllWithSyncState(entity: NativePosEntity) {
    await this.isReady();
    return (await bridge().getRecords(entity)).map(row => ({ record: row.record, recordId: row.recordId, syncState: row.syncState }));
  },
  async whereEquals<T extends Record<string, unknown>>(entity: NativePosEntity, field: string, value: string | number | boolean): Promise<T[]> {
    const rows = await this.getAll<T>(entity);
    return rows.filter(row => row[field] === value);
  },
  async firstWhereEquals<T extends Record<string, unknown>>(entity: NativePosEntity, field: string, value: string | number | boolean): Promise<T | null> {
    return (await this.whereEquals<T>(entity, field, value))[0] ?? null;
  },
  async put(entity: NativePosEntity, record: Record<string, unknown>, syncState: NativePosSyncState = 'local'): Promise<void> {
    await this.isReady();
    const result = await bridge().putRecords([{ entity, recordId: getNativePosRecordId(entity, record), record, syncState }]);
    if (result.saved !== true || result.count !== 1) throw new Error(`Electron SQLite did not confirm saving ${entity}`);
    notifyElectronEntityChanges([entity]);
  },
  async putMany(entity: NativePosEntity, records: Record<string, unknown>[], syncState: NativePosSyncState = 'local'): Promise<void> {
    await this.isReady();
    const entries = records.map(record => ({ entity, recordId: getNativePosRecordId(entity, record), record, syncState }));
    const result = await bridge().putRecords(entries);
    if (result.saved !== true || result.count !== entries.length) throw new Error(`Electron SQLite did not confirm saving all ${entity} records`);
    if (entries.length) notifyElectronEntityChanges([entity]);
  },
  async applyChanges(changes: Array<
    | { action: 'put'; entity: NativePosEntity; record: Record<string, unknown>; syncState?: NativePosSyncState }
    | { action: 'delete'; entity: NativePosEntity; key: unknown }
  >): Promise<number> {
    await this.isReady();
    const nativeChanges = changes.map(change => change.action === 'delete'
      ? { action: 'delete' as const, entity: change.entity, recordId: JSON.stringify(change.key) }
      : { action: 'put' as const, entity: change.entity, recordId: getNativePosRecordId(change.entity, change.record), record: change.record, syncState: change.syncState ?? 'local' });
    const result = await bridge().applyRecordChanges(nativeChanges);
    if (result.applied !== changes.length || result.count !== changes.length) throw new Error('Electron SQLite did not confirm the complete transaction');
    if (changes.length) notifyElectronEntityChanges(changes.map(change => change.entity));
    return result.applied;
  },
  async delete(entity: NativePosEntity, key: unknown): Promise<boolean> {
    const result = await this.applyChanges([{ action: 'delete', entity, key }]);
    return result === 1;
  },
  async deleteMany(entity: NativePosEntity, keys: unknown[]): Promise<number> {
    if (!keys.length) return 0;
    return this.applyChanges(keys.map(key => ({ action: 'delete' as const, entity, key })));
  },
  async setSyncState(entity: NativePosEntity, key: unknown, syncState: NativePosSyncState): Promise<void> {
    const record = await this.get<Record<string, unknown>>(entity, key);
    if (!record) throw new Error(`Electron SQLite record not found: ${entity}`);
    await this.put(entity, record, syncState);
  },
};
