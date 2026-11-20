import { apiService, getAuthToken } from './apiService';
import { useSyncStore } from '../store/syncStore';
import { isNativeAndroid, ensureNativePosDatabase, posLocalDatabase, listNativePendingPosOperations, getNativePosRecord, enqueueNativePosOperation, acknowledgeNativePosOperation, markNativePosOperationError, markNativePosOperationConflict } from '../native/posLocalDatabase';
import { reconcileLocalOperationAfterAck, remapPendingEntityReferences } from './localOperationReconciliation';
import { nativePosRepository, NATIVE_POS_ENTITIES } from '../native/nativePosRepository';
import { readLegacyIndexedDBStores } from './nativeDatabaseMirror';
import { isElectronDesktop } from '../native/electronPosRepository';
const isLocalSqlite = (): boolean => isNativeAndroid() || isElectronDesktop();
let db = {} as typeof import('../db/db').db;
let dexieLoaded = false;
let electronSyncListenerInstalled = false;
let electronSyncTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureDexieDatabase(): Promise<void> {
  if (dexieLoaded) return;
  db = (await import('../db/db')).db;
  dexieLoaded = true;
}

async function ensureDesktopDatabase(): Promise<void> {
  if (isLocalSqlite()) return;
  await ensureDexieDatabase();
}


async function updateRecordWithoutSyncHook(tableName: string, key: any, changes: Record<string, unknown>) {
  const previous = (globalThis as any).__posApplyingOperation;
  (globalThis as any).__posApplyingOperation = true;
  try { await (db as any)[tableName].update(key, changes); }
  finally { (globalThis as any).__posApplyingOperation = previous; }
}

async function markPushedRecordState(tableName: string, key: any, state: 'pending' | 'error' | 'conflict') {
  if (isLocalSqlite()) {
    const current = await nativePosRepository.get<any>(tableName as any, key);
    if (!current) throw new Error(`SQLite record is missing while updating ${tableName} sync state`);
    await nativePosRepository.put(
      tableName as any,
      { ...current, syncStatus: state },
      state === 'conflict' ? 'local' : state,
    );
    return;
  }
  await updateRecordWithoutSyncHook(tableName, key, { syncStatus: state });
}
export async function migrateLegacyAndroidQueueToSQLite() {
  if (!isNativeAndroid() || !(await ensureNativePosDatabase())) return;
  const migrationState = await posLocalDatabase.getMeta({ key: 'legacy_dexie_queue_migrated' });
  if (migrationState.value === '1') return;
  const legacyStores = await readLegacyIndexedDBStores();
  const legacy = (Array.isArray(legacyStores.syncOperations) ? legacyStores.syncOperations : [])
    .filter((operation: any) => ['pending', 'error', 'syncing', 'conflict'].includes(String(operation?.status || '')));
  if (!legacy.length) {
    const completed = await posLocalDatabase.setMeta({ key: 'legacy_dexie_queue_migrated', value: '1' });
    if (!completed.saved) throw new Error('تعذر حفظ علامة ترحيل طابور Dexie القديم في SQLite');
    return;
  }
  const pending = await listNativePendingPosOperations();
  const pendingIds = new Set(pending.map((operation) => String(operation.operationId)));
  for (const operation of legacy) {
    const id = String(operation.id || '');
    if (!id) throw new Error('تعذر ترحيل عملية Android قديمة لا تحتوي على معرّف؛ أُوقفت العملية لحماية الطابور');
    const nativeRecord = await getNativePosRecord('operations', id);
    const existingState = nativeRecord?.syncState ? String(nativeRecord.syncState) : undefined;
    if (existingState === 'synced' || existingState === 'conflict') continue;
    if (pendingIds.has(id)) {
      if (operation.status === 'conflict') {
        await markNativePosOperationConflict(id, String(operation.lastError || 'عملية قديمة متعارضة؛ حُفظت للمراجعة في SQLite'));
      }
      continue;
    }
    const validType = typeof operation.type === 'string' && operation.type.trim().length > 0;
    const validPayload = !!operation.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload);
    const invalidOperation = !validType || !validPayload;
    const createdAt = operation.createdAt == null ? Date.now() : new Date(operation.createdAt).getTime();
    const schemaVersion = Number(operation.schemaVersion || 1);
    const retryCount = Number(operation.retryCount || 0);
    const nextRetryAt = operation.nextRetryAt == null ? undefined : new Date(operation.nextRetryAt).getTime();
    const invalidMetadata =
      !Number.isFinite(createdAt) || createdAt <= 0 ||
      !Number.isInteger(schemaVersion) || schemaVersion <= 0 ||
      !Number.isInteger(retryCount) || retryCount < 0 ||
      (nextRetryAt !== undefined && (!Number.isFinite(nextRetryAt) || nextRetryAt <= 0));
    const safeCreatedAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
    const safeSchemaVersion = Number.isInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1;
    const safeRetryCount = Number.isInteger(retryCount) && retryCount >= 0 ? retryCount : 0;
    const safeNextRetryAt = nextRetryAt !== undefined && Number.isFinite(nextRetryAt) && nextRetryAt > 0
      ? nextRetryAt
      : undefined;
    const queued = await enqueueNativePosOperation({
      operationId: id,
      type: validType ? String(operation.type) : 'legacy_invalid_operation',
      payload: validPayload ? operation.payload as Record<string, unknown> : { _legacyInvalidPayload: operation.payload ?? null },
      deviceId: String(operation.deviceId || ''),
      branchId: operation.branchId == null ? undefined : String(operation.branchId),
      schemaVersion: safeSchemaVersion,
      createdAt: safeCreatedAt,
      retryCount: safeRetryCount,
      nextRetryAt: safeNextRetryAt,
    });
    if (!queued) throw new Error('تعذر ترحيل عملية Android قديمة إلى طابور SQLite؛ أوقف المزامنة لحماية العملية');
    if (operation.status === 'conflict' || invalidMetadata || invalidOperation) {
      const reason = operation.status === 'conflict'
        ? String(operation.lastError || 'عملية قديمة متعارضة؛ حُفظت للمراجعة في SQLite')
        : invalidOperation
          ? 'تعذر ترحيل عملية قديمة تلقائياً: نوع العملية أو محتواها غير صالح؛ حُفظت للمراجعة في SQLite'
          : 'تعذر ترحيل عملية قديمة تلقائياً: بيانات التوقيت أو إصدار المخطط أو عدد المحاولات غير صالحة؛ حُفظت في SQLite للمراجعة';
      await markNativePosOperationConflict(id, reason);
      continue;
    }
  }
  const completed = await posLocalDatabase.setMeta({ key: 'legacy_dexie_queue_migrated', value: '1' });
  if (!completed.saved) throw new Error('تعذر تأكيد اكتمال ترحيل طابور Dexie القديم إلى SQLite');
}

export const syncService = {
  cachedRole: null as string | null,

  async getDeviceRole() {
    await ensureDesktopDatabase();
    // Read the persisted role each time: onboarding can switch a device to
    // standalone after the sync service has already been initialized.
    const setting = isLocalSqlite()
      ? await nativePosRepository.firstWhereEquals<{ key: string; value: any }>('settings', 'key', 'deviceRole')
      : await db.settings.where('key').equals('deviceRole').first();
    this.cachedRole = setting ? setting.value : 'server';
    return this.cachedRole;
  },

  clearCachedRole() {
    this.cachedRole = null;
  },

  async updatePendingCount() {
    try {
      if (!isLocalSqlite()) await ensureDesktopDatabase();
      // The native outbox is the sole durable operation queue on Android;
      // Dexie entries are only a compatibility mirror and must not be counted.
      let pendingOps = 0;
      if (isLocalSqlite()) {
        // Preserve the previous count if SQLite cannot be read; reporting zero
        // would falsely imply that the durable outbox is empty.
        pendingOps = (await listNativePendingPosOperations()).length;
      } else {
        pendingOps = await db.syncOperations
          .where('status')
          .anyOf(['pending', 'error'])
          .count();
      }

      const tables: string[] = [
        'categories',
        'products',
        'customers',
        'customerPayments',
        'suppliers',
        'supplierPayments',
        'employees',
        'expenses',
        'shifts',
        'shiftMovements',
        'orders',
        'orderItems',
        'returns',
        'returnItems',
        'purchases',
        'purchaseItems',
        'purchaseReturns',
        'purchaseReturnItems',
        'attendance',
        'branches',
        'payroll',
        'offers',
        'loyaltyTransactions',
        'settings',
        'auditLogs',
        'stocktakingSessions',
        'stocktakingEntries',
        'inventoryBatches',
        'serviceRecipes',
        'exchangeRateHistory',
        'fiscalPeriods',
      ];
      let pendingRecords = 0;
      if (!isLocalSqlite()) await ensureDesktopDatabase();
      for (const table of tables) {
        if (isLocalSqlite()) {
          const records = await nativePosRepository.getAllWithSyncState(table as any);
          pendingRecords += records.filter((item) => item.syncState === 'pending' || item.syncState === 'error').length;
        } else if ((db as any)[table]) {
          pendingRecords += await (db as any)[table].where('syncStatus').anyOf(['pending', 'error']).count();
        }
      }

      useSyncStore.getState().setPendingItemsCount(pendingOps + pendingRecords);
    } catch (e) {
      console.error('Failed to count pending items:', e);
    }
  },

  async syncAll() {
    if (await this.getDeviceRole() === 'standalone') return false;
    const token = getAuthToken();
    if (!token) return false;

    const reachable = await apiService.checkServerReachability(2500);
    useSyncStore.getState().setOnlineStatus(reachable);
    if (!reachable) {
      return false;
    }

    useSyncStore.getState().setSyncing(true);

    try {
      await this.pushOperationsQueue();
      await this.pushAll();
      await this.pullAll();

      useSyncStore.getState().setLastSynced(new Date());
      await this.updatePendingCount();
      return true;
    } catch (error) {
      console.error('Sync failed:', error);
      throw error;
    } finally {
      useSyncStore.getState().setSyncing(false);
    }
  },

  async pushOperationsQueue() {
    if (await this.getDeviceRole() === 'standalone') return;
    const now = Date.now();
    // Migrate only pre-SQLite Android queue entries; new Android operations
    // are written directly to SQLite and never enter Dexie.
    if (isNativeAndroid()) await migrateLegacyAndroidQueueToSQLite();
    const queued = isLocalSqlite()
      ? []
      : await db.syncOperations
          .where('status')
          .anyOf(['pending', 'error'])
          .toArray();
    const nativeQueued: Array<any> = isLocalSqlite()
      ? await listNativePendingPosOperations()
      : [];
    const nativeIds = new Set(nativeQueued.map((op) => op.operationId));
    const nativeAsSyncOperations = nativeQueued.map((op) => ({
      id: op.operationId,
      type: op.type,
      payload: op.payload,
      deviceId: op.deviceId || '',
      branchId: op.branchId ? Number(op.branchId) : undefined,
      status: 'pending' as const,
      retryCount: op.retryCount || 0,
      nextRetryAt: op.nextRetryAt ? new Date(op.nextRetryAt).toISOString() : undefined,
      createdAt: new Date(op.createdAt).toISOString(),
      updatedAt: new Date(op.createdAt).toISOString(),
    }));
    const merged = [
      ...nativeAsSyncOperations,
      ...queued.filter((op) => !nativeIds.has(op.id)),
    ];
    const readyOps = merged
      .filter((op) => {
        const dexieOp = queued.find((candidate) => candidate.id === op.id);
        const retryAt = op.nextRetryAt || dexieOp?.nextRetryAt;
        return !retryAt || new Date(retryAt).getTime() <= now;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (readyOps.length === 0) return;

    // Process operations in creation order, one at a time. A create operation may
    // establish server-side identifiers needed by the next queued operation;
    // batching dependent operations would send stale temporary references.
    for (let i = 0; i < readyOps.length; i += 1) {
      const queuedOperation = readyOps[i];
      // Re-read the payload after each acknowledgement: an earlier create may
      // have remapped IDs inside this operation while readyOps was being sorted.
      const isNativeOperation = isLocalSqlite() && nativeIds.has(queuedOperation.id);
      let currentOperation: any;
      if (isNativeOperation) {
        const latestNative = await listNativePendingPosOperations();
        const nativeOperation = latestNative.find((item) => item.operationId === queuedOperation.id);
        if (!nativeOperation) continue;
        currentOperation = {
          id: nativeOperation.operationId,
          type: nativeOperation.type,
          payload: nativeOperation.payload,
          deviceId: nativeOperation.deviceId || '',
          branchId: nativeOperation.branchId ? Number(nativeOperation.branchId) : undefined,
          status: 'pending',
          retryCount: nativeOperation.retryCount || 0,
          nextRetryAt: nativeOperation.nextRetryAt ? new Date(nativeOperation.nextRetryAt).toISOString() : undefined,
          createdAt: new Date(nativeOperation.createdAt).toISOString(),
        };
      } else {
        currentOperation = await db.syncOperations.get(queuedOperation.id);
      }
      if (!currentOperation || !['pending', 'error', 'syncing'].includes(currentOperation.status || 'pending')) continue;
      // Android purchase_update now has a preflighted, atomic SQLite
      // reversal-and-replacement path; queued updates can use normal delivery.
      const batch = [currentOperation];
      const response = await apiService.executeOperationsBatch(
        batch.map((op) => ({
          id: op.id,
          type: op.type,
          payload: op.payload,
          deviceId: op.deviceId,
          branchId: op.branchId,
        }))
      );

      const results = response?.results || [];
      for (const res of results) {
        const op = batch.find((b) => b.id === res.operationId);
        if (!op) continue;

        if (res.status === 'ok' || res.status === 'duplicate') {
          // Rewrite dependent records and durable queues before acknowledging
          // the create operation. A retry after interruption is safe because
          // the server returns the original result for duplicate operation IDs.
          if (op.type === 'entity_upsert' && op.payload?.record?.id !== undefined && res.result?.id !== undefined) {
            await remapPendingEntityReferences(op.payload.table, op.payload.record.id, res.result.id, op.id);
          }
          if (!isNativeOperation) {
            await db.syncOperations.update(op.id, {
              status: 'synced', lastError: undefined, updatedAt: new Date().toISOString(),
            });
          }
          // Keep the durable SQLite outbox row until every local reconciliation
          // write is confirmed; a failure can then safely retry the server duplicate.
          await reconcileLocalOperationAfterAck(op.type, op.payload, op.id, res.result);
          if (isNativeOperation) await acknowledgeNativePosOperation(op.id);
        } else {
          const retryCount = (op.retryCount || 0) + 1;
          const backoffMs = Math.min(60000, 2000 * Math.pow(2, retryCount));
          const message = res.error || 'Unknown sync error';
          if (isNativeOperation) {
            if (retryCount >= 8) await markNativePosOperationConflict(op.id, message);
            else await markNativePosOperationError(op.id, message);
            if (queued.some((candidate) => candidate.id === op.id)) {
              await db.syncOperations.update(op.id, {
                status: retryCount >= 8 ? 'conflict' : 'error',
                retryCount, lastError: message,
                nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
          } else {
            await db.syncOperations.update(op.id, {
              status: retryCount >= 8 ? 'conflict' : 'error',
              retryCount, lastError: message,
              nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  },

  async pushAll() {
    if (await this.getDeviceRole() === 'standalone') return;
    const tables: string[] = [
      'categories',
      'products',
      'customers',
      'suppliers',
      'employees',
      'expenses',
      'shifts',
      'attendance',
      'branches',
      'payroll',
      'offers',
      'loyaltyTransactions',
      'settings',
      'auditLogs',
      'stocktakingSessions',
      'stocktakingEntries',
      'serviceRecipes',
      'exchangeRateHistory',
      'fiscalPeriods',
    ];

    for (const table of tables) {
      await this.pushTable(table);
    }
  },

  async pushRecord(tableName: string, record: any) {
    if (await this.getDeviceRole() === 'standalone') return false;
    if (!getAuthToken()) return false;
    const table = isLocalSqlite() ? undefined : (db as any)[tableName];
    if (!table && (!isLocalSqlite() || !NATIVE_POS_ENTITIES.includes(tableName as any))) return false;
    const recordKey = record?.id ?? record?.key;
    if (recordKey === undefined || recordKey === null) return false;
    let sourceRecord = record;

    // On Android, read the committed entity from SQLite rather than trusting
    // the Dexie hook payload, which may be stale or only a compatibility copy.
    if (isLocalSqlite()) {
      sourceRecord = await nativePosRepository.get<any>(tableName as any, recordKey);
      if (!sourceRecord) {
        console.warn('Skipped Android entity push because the SQLite record is missing:', tableName, recordKey);
        return false;
      }
    }

    const reachable = await apiService.checkServerReachability(1800);
    if (reachable) {
      try {
        const serverRes = await this.sendRecordToServer(tableName, sourceRecord);
        await this.reconcilePushedRecord(tableName, sourceRecord, serverRes);
        if (!isLocalSqlite()) {
          const savedKey = serverRes?.id ?? sourceRecord.id ?? sourceRecord.key;
          const saved = await table.get(savedKey);
        }
        // Android reconciliation already committed the canonical record and
        // sync state to SQLite before updating the compatibility cache.
        return true;
      } catch (err) {
        console.error(`Failed to push ${tableName} record directly:`, err);
        await markPushedRecordState(tableName, recordKey, 'pending');
        if (!isLocalSqlite()) {
          const saved = await table.get(recordKey);
        }
        return false;
      }
    }

    await markPushedRecordState(tableName, recordKey, 'pending');
    if (!isLocalSqlite()) {
      const saved = await table.get(recordKey);
    }
    return false;
  },

  async reconcilePushedRecord(tableName: string, localRecord: any, serverRes: any) {
    await ensureDesktopDatabase();
    const table = isLocalSqlite() ? undefined : (db as any)[tableName];
    if (!table && !isLocalSqlite()) return;

    if (isLocalSqlite()) {
      const oldKey = localRecord.id ?? localRecord.key ?? localRecord.code;
      const merged = {
        ...localRecord,
        ...(serverRes && typeof serverRes === 'object' ? serverRes : {}),
        syncStatus: 'synced',
      };
      const newKey = merged.id ?? merged.key ?? merged.code ?? oldKey;
      if (oldKey === undefined || newKey === undefined) {
        throw new Error(`Cannot reconcile Android ${tableName} push without a stable record key`);
      }

      // Commit the canonical server response and old-key removal to SQLite
      // before touching the Dexie compatibility cache.
      if (tableName !== 'settings' && String(oldKey) !== String(newKey)) {
        await remapPendingEntityReferences(tableName, oldKey, newKey);
      }
      const changes: Array<any> = [];
      if (String(oldKey) !== String(newKey)) {
        changes.push({ action: 'delete', entity: tableName, key: oldKey });
      }
      changes.push({ action: 'put', entity: tableName, record: merged, syncState: 'synced' });
      const applied = await nativePosRepository.applyChanges(changes);
      if (applied !== changes.length) {
        throw new Error(`SQLite did not confirm Android ${tableName} push reconciliation`);
      }

      return;
    }

    if (tableName === 'settings') {
      if (localRecord.id) {
        await table.update(localRecord.id, { syncStatus: 'synced' });
      }
      return;
    }
    if (serverRes && typeof serverRes === 'object' && serverRes.id !== undefined) {
      if (localRecord.id !== undefined && String(localRecord.id) !== String(serverRes.id)) {
        // REST entity creation uses a separate path from entity_upsert queue
        // operations, so it must perform the same dependent-ID remapping.
        await remapPendingEntityReferences(tableName, localRecord.id, serverRes.id);
        await table.delete(localRecord.id);
      }
      await table.put({ ...localRecord, ...serverRes, syncStatus: 'synced' });
    } else if (localRecord.id !== undefined) {
      await table.update(localRecord.id, { syncStatus: 'synced' });
    }
  },

  async sendRecordToServer(tableName: string, record: any): Promise<any> {
    switch (tableName) {
      case 'categories':
        if (record.id && record.id > 1000000) return await apiService.createCategory(record);
        return await apiService.updateCategory(record.id, record);
      case 'products':
        if (record.id && record.id > 1000000) return await apiService.createProduct(record);
        return await apiService.updateProduct(record.id, record);
      case 'customers':
        if (record.id && record.id > 1000000) return await apiService.createCustomer(record);
        return await apiService.updateCustomer(record.id, record);
      case 'suppliers':
        if (record.id && record.id > 1000000) return await apiService.createSupplier(record);
        return await apiService.updateSupplier(record.id, record);
      case 'expenses':
        return await apiService.createExpense(record);
      case 'shifts':
        if (record.status === 'closed') return await apiService.updateShift(record.id, record);
        return await apiService.createShift(record);
      case 'attendance':
        if (record.checkOut) return await apiService.updateAttendance(record.id, record);
        return await apiService.recordAttendance(record);
      case 'payroll':
        return await apiService.createPayroll(record);
      case 'employees':
        if (record.id && record.id > 1000000) return await apiService.createEmployee(record);
        return await apiService.updateEmployee(record.id, record);
      case 'branches':
        if (record.id && record.id > 1000000) return await apiService.createBranch(record);
        return await apiService.updateBranch(record.id, record);
      case 'offers':
        if (record.id && record.id > 1000000) return await apiService.createOffer(record);
        return await apiService.updateOffer(record.id, record);
      case 'settings':
        if (record.key === 'deviceRole' || record.key === 'serverUrl') return null;
        return await apiService.updateSetting(record.key, record);
      case 'auditLogs':
        return await apiService.createAuditLog(record);
      case 'stocktakingSessions':
        if (record.status === 'closed' || record.status === 'approved')
          return await apiService.updateStocktakingSession(record.id, record);
        return await apiService.createStocktakingSession(record);
      case 'stocktakingEntries':
        return await apiService.createStocktakingEntry(record);
      case 'loyaltyTransactions':
        return await apiService.createLoyaltyTransaction(record);
      case 'serviceRecipes':
        return await apiService.saveServiceRecipe(record);
      case 'exchangeRateHistory':
        return await apiService.addExchangeRate(record);
      case 'fiscalPeriods':
        return await apiService.saveFiscalPeriod(record);
      default:
        throw new Error(`Unsupported sync entity: ${tableName}`);
    }
  },

  async pushTable(tableName: string) {
    if (await this.getDeviceRole() === 'standalone') return;
    if (isLocalSqlite()) {
      if (!NATIVE_POS_ENTITIES.includes(tableName as any)) return;
    } else if (!(db as any)[tableName]) return;
    const pendingRecords = isLocalSqlite()
      ? (await nativePosRepository.getAllWithSyncState(tableName as any))
          .filter((item) => item.syncState === 'pending' || item.syncState === 'error')
          .map((item) => item.record)
      : await (db as any)[tableName].where('syncStatus').anyOf(['pending', 'error']).toArray();

    for (const record of pendingRecords) {
      const recordKey = record.id ?? record.key;
      try {
        const serverRes = await this.sendRecordToServer(tableName, record);
        await this.reconcilePushedRecord(tableName, record, serverRes);
      } catch (err: any) {
        console.error(`Failed to push ${tableName} record:`, record, err);
        const conflict = err.response && err.response.status === 409;
        if (recordKey !== undefined) {
          await markPushedRecordState(tableName, recordKey, conflict ? 'conflict' : 'error');
        }
      }
    }
  },

  async pullAll() {
    if (await this.getDeviceRole() === 'standalone') return;
    if (!getAuthToken()) return;
    try {
      const reachable = await apiService.checkServerReachability(1200);
      if (!reachable) return;

      // Android SQLite owns the durable operation queue. Never let a stale
      // Dexie mirror entry prevent an authoritative server snapshot from
      // reconciling SQLite records.
      const pendingOpsCount = isLocalSqlite()
        ? (await listNativePendingPosOperations()).length
        : await db.syncOperations
            .where('status')
            .anyOf(['pending', 'error', 'syncing'])
            .count();

      const pullTasks: Array<{
        entity: string;
        api: () => Promise<any>;
        preserveLocalAuth?: boolean;
        excludeKeys?: string[];
        noSyncStatus?: boolean;
        authoritativeReplaceSynced?: boolean;
      }> = [
        { entity: 'products', api: () => apiService.getProducts() },
        { entity: 'categories', api: () => apiService.getCategories() },
        { entity: 'customers', api: () => apiService.getCustomers() },
        { entity: 'customerPayments', api: () => apiService.getCustomerPayments(), authoritativeReplaceSynced: true },
        { entity: 'suppliers', api: () => apiService.getSuppliers() },
        { entity: 'supplierPayments', api: () => apiService.getSupplierPayments(), authoritativeReplaceSynced: true },
        { entity: 'employees', api: () => apiService.getEmployees(), preserveLocalAuth: true },
        { entity: 'settings', api: () => apiService.getSettings(), excludeKeys: ['deviceRole', 'serverUrl'] },
        { entity: 'branches', api: () => apiService.getBranches() },
        { entity: 'offers', api: () => apiService.getOffers() },
        { entity: 'shifts', api: () => apiService.getShifts() },
        { entity: 'shiftMovements', api: () => apiService.getShiftMovements(), authoritativeReplaceSynced: true },
        { entity: 'expenses', api: () => apiService.getExpenses() },
        { entity: 'orders', api: () => apiService.getOrders() },
        { entity: 'orderItems', api: () => apiService.getOrderItems(), authoritativeReplaceSynced: true },
        { entity: 'returns', api: () => apiService.getReturns() },
        { entity: 'returnItems', api: () => apiService.getReturnItems(), authoritativeReplaceSynced: true },
        { entity: 'accounts', api: () => apiService.getAccounts(), noSyncStatus: true },
        { entity: 'journalEntries', api: () => apiService.getJournalEntries(), authoritativeReplaceSynced: true },
        { entity: 'transactions', api: () => apiService.getTransactions(), authoritativeReplaceSynced: true },
        { entity: 'inventoryBatches', api: () => apiService.getInventoryBatches(), authoritativeReplaceSynced: true },
        {
          entity: 'inventoryMovements',
          api: async () => {
            const allMovements: any[] = [];
            let offset = 0;
            do {
              const page = await apiService.getInventoryMovements({ offset, limit: 2000 });
              if (Array.isArray(page)) { allMovements.push(...page); break; }
              if (Array.isArray(page?.items)) allMovements.push(...page.items);
              if (page?.nextOffset === null || page?.nextOffset === undefined) break;
              offset = Number(page.nextOffset);
            } while (Number.isFinite(offset) && offset >= 0);
            return allMovements;
          },
          authoritativeReplaceSynced: true,
        },
        { entity: 'inventoryAlerts', api: () => apiService.getInventoryAlerts(), noSyncStatus: true },
        { entity: 'loyaltyTransactions', api: () => apiService.getLoyaltyTransactions() },
        { entity: 'purchases', api: () => apiService.getPurchases() },
        { entity: 'purchaseItems', api: () => apiService.getPurchaseItems(), authoritativeReplaceSynced: true },
        { entity: 'purchaseReturns', api: () => apiService.getPurchaseReturns() },
        { entity: 'purchaseReturnItems', api: () => apiService.getPurchaseReturnItems(), authoritativeReplaceSynced: true },
        { entity: 'attendance', api: () => apiService.getAttendance() },
        { entity: 'payroll', api: () => apiService.getPayroll() },
        { entity: 'auditLogs', api: () => apiService.getAuditLogs() },
        { entity: 'stocktakingSessions', api: () => apiService.getStocktakingSessions() },
        { entity: 'stocktakingEntries', api: () => apiService.getStocktakingEntries() },
        { entity: 'serviceRecipes', api: () => apiService.getServiceRecipes(), authoritativeReplaceSynced: true },
        { entity: 'exchangeRateHistory', api: () => apiService.getExchangeRateHistory(), authoritativeReplaceSynced: true },
        { entity: 'fiscalPeriods', api: () => apiService.getFiscalPeriods(), authoritativeReplaceSynced: true },
      ];

      (globalThis as any).__posApplyingOperation = true;
      try {
        for (const task of pullTasks) {
          try {
            const data = await task.api();
            if (!Array.isArray(data)) continue;

            if (isLocalSqlite()) {
              const entity = task.entity;
              const existingNative = await nativePosRepository.getAllWithSyncState(entity as any);
              const existingById = new Map(existingNative.map((item) => {
                const record: any = item.record;
                const key = record.id ?? record.key ?? record.code;
                return [key === undefined || key === null ? '' : String(key), record];
              }));
              if (task.noSyncStatus) {
                const changes = data.map((record: any) => ({
                  action: 'put' as const, entity: entity as any, record, syncState: 'synced' as const,
                }));
                const applied = changes.length ? await nativePosRepository.applyChanges(changes) : 0;
                if (applied !== changes.length) throw new Error('SQLite did not apply the complete server snapshot for ' + entity);
                if (data.length) {
                  // SQLite owns the Android snapshot; no Dexie cache write is required here.
                }
                continue;
              }

              const pendingLocal = existingNative.filter((item) => item.syncState === 'pending' || item.syncState === 'error');
              const pendingIds = new Set(pendingLocal.map((item) => {
                const record: any = item.record;
                const key = record.id ?? record.key ?? record.code;
                return key === undefined || key === null ? '' : String(key);
              }));
              const changes: Array<any> = [];
              const staleIds: any[] = [];
              if (task.authoritativeReplaceSynced && pendingOpsCount === 0) {
                const serverIds = new Set(data.map((item: any) => String(item.id ?? item.key ?? item.code)));
                for (const item of existingNative) {
                  const record: any = item.record;
                  const key = record.id ?? record.key ?? record.code;
                  if (item.syncState === 'synced' && key !== undefined && !serverIds.has(String(key))) {
                    staleIds.push(key);
                    changes.push({ action: 'delete', entity: entity as any, key });
                  }
                }
              }

              let filtered = data.filter((item: any) => {
                const key = item.id ?? item.key ?? item.code;
                return key === undefined || key === null || !pendingIds.has(String(key));
              });
              if (task.excludeKeys) {
                const excluded = new Set(task.excludeKeys);
                filtered = filtered.filter((item: any) => !excluded.has(item.key));
              }
              const recordsToPut = filtered.map((item: any) => {
                const normalized = { ...item };
                if (task.preserveLocalAuth) {
                  const previous = existingById.get(String(item.id ?? item.key ?? item.code));
                  if (previous) {
                    if (!normalized.password && previous.password) normalized.password = previous.password;
                    if (!normalized.pinCode && previous.pinCode) normalized.pinCode = previous.pinCode;
                  }
                }
                return { ...normalized, syncStatus: 'synced' };
              });
              for (const record of recordsToPut) {
                changes.push({ action: 'put', entity: entity as any, record, syncState: 'synced' as const });
              }
              const applied = changes.length ? await nativePosRepository.applyChanges(changes) : 0;
              if (applied !== changes.length) throw new Error('SQLite did not apply the complete server snapshot for ' + entity);
              // SQLite owns the Android snapshot; no Dexie cache write is required here.
              continue;
            }

            const cacheTable = db.table(task.entity);
            if (task.noSyncStatus) {
              await cacheTable.bulkPut(data);
              continue;
            }

            const existingAll = await cacheTable.toArray();
            const existingById = new Map(existingAll.map((r: any) => [r.id || r.key, r]));

            const pendingLocal = await cacheTable
              .where('syncStatus')
              .anyOf(['pending', 'error'])
              .toArray();
            const pendingIds = new Set(pendingLocal.map((r: any) => r.id || r.key));

            if (task.authoritativeReplaceSynced && pendingOpsCount === 0) {
              const serverIds = new Set(data.map((d: any) => d.id));
              const staleIds = existingAll
                .filter((r: any) => r.syncStatus === 'synced' && !serverIds.has(r.id))
                .map((r: any) => r.id)
                .filter((id: any) => id !== undefined);
              if (staleIds.length > 0) {
                await cacheTable.bulkDelete(staleIds);
              }
            }

            let filtered = data.filter((item: any) => !pendingIds.has(item.id || item.key));
            if (task.excludeKeys) {
              const excl = new Set(task.excludeKeys);
              filtered = filtered.filter((item: any) => !excl.has(item.key));
            }

            const recordsToPut = filtered.map((item: any) => {
              const normalized = { ...item };
              if (task.preserveLocalAuth) {
                const prev = existingById.get(item.id);
                if (prev) {
                  if (!normalized.password && (prev as any).password) {
                    normalized.password = (prev as any).password;
                  }
                  if (!normalized.pinCode && (prev as any).pinCode) {
                    normalized.pinCode = (prev as any).pinCode;
                  }
                }
              }
              return { ...normalized, syncStatus: 'synced' };
            });

            if (recordsToPut.length > 0) {
              await cacheTable.bulkPut(recordsToPut);
            }
          } catch (err: any) {
            // Android commits each server snapshot to SQLite first. Do not hide
            // a failed native write or continue with a partially refreshed database.
            if (isLocalSqlite()) throw err;
            if (process.env.NODE_ENV !== 'production') {
              console.warn('Skipped pulling table data:', err?.message || err);
            }
          }
        }
        // Native rows were already committed directly above. Re-mirroring all
        // Dexie tables here could overwrite a successful SQLite snapshot with
        // stale compatibility-cache data after a partial cache write.

      } finally {
        (globalThis as any).__posApplyingOperation = false;
      }
    } catch (err) {
      if (isLocalSqlite()) throw err;
      // Desktop/web may remain offline without blocking the local application.
    }
  },

  async initAutoSync() {
    if (isElectronDesktop()) {
      if (!electronSyncListenerInstalled && typeof window !== 'undefined') {
        electronSyncListenerInstalled = true;
        window.addEventListener('pos-native-records-changed', () => {
          if (electronSyncTimer) clearTimeout(electronSyncTimer);
          electronSyncTimer = setTimeout(() => {
            electronSyncTimer = null;
            void this.syncAll().catch((error) => console.warn('Electron SQLite auto-sync deferred:', error));
          }, 900);
        });
      }
      return;
    }
    if (isNativeAndroid()) return;
    await ensureDesktopDatabase();
    const entityTables = new Set([
      'products',
      'categories',
      'customers',
      'suppliers',
      'employees',
      'expenses',
      'shifts',
      'attendance',
      'branches',
      'payroll',
      'offers',
      'settings',
      'auditLogs',
      'stocktakingSessions',
      'stocktakingEntries',
      'serviceRecipes',
      'exchangeRateHistory',
      'fiscalPeriods',
    ]);

    db.tables.forEach((table) => {
      if (!entityTables.has(table.name)) return;

      table.hook('creating', function (_primKey, obj, transaction) {
        if ((obj as any)?.syncStatus === 'synced' || (globalThis as any).__posApplyingOperation) return;
        transaction.on('complete', () => {
          syncService.pushRecord(table.name, obj).catch(() => {});
        });
      });

      table.hook('updating', function (modifications: any, _primKey, obj, transaction) {
        if (modifications?.syncStatus === 'synced' || (globalThis as any).__posApplyingOperation) return;
        transaction.on('complete', () => {
          syncService.pushRecord(table.name, { ...obj, ...modifications }).catch(() => {});
        });
      });
    });
  },
};
