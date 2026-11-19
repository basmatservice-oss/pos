import { db } from '../db/db';
import { apiService, getAuthToken } from './apiService';
import { useSyncStore } from '../store/syncStore';
import { isNativeAndroid, listNativePendingPosOperations, acknowledgeNativePosOperation, markNativePosOperationError, markNativePosOperationConflict } from '../native/posLocalDatabase';
import { reconcileLocalOperationAfterAck, remapPendingEntityReferences } from './localOperationReconciliation';
import { mirrorNativePosRecord } from './nativeDatabaseMirror';
import { nativePosRepository } from '../native/nativePosRepository';

async function updateRecordWithoutSyncHook(tableName: string, key: any, changes: Record<string, unknown>) {
  const previous = (globalThis as any).__posApplyingOperation;
  (globalThis as any).__posApplyingOperation = true;
  try { await (db as any)[tableName].update(key, changes); }
  finally { (globalThis as any).__posApplyingOperation = previous; }
}
export const syncService = {
  cachedRole: null as string | null,

  async getDeviceRole() {
    // Read the persisted role each time: onboarding can switch a device to
    // standalone after the sync service has already been initialized.
    const setting = isNativeAndroid()
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
      const pendingDexieOperations = await db.syncOperations
        .where('status')
        .anyOf(['pending', 'error'])
        .toArray();
      let pendingOps = pendingDexieOperations.length;

      // Include native-only Android outbox entries after an IndexedDB reset.
      // Entries mirrored in Dexie are counted once.
      if (isNativeAndroid()) {
        try {
          const dexieIds = new Set(pendingDexieOperations.map((operation) => operation.id));
          const nativePending = await listNativePendingPosOperations();
          pendingOps += nativePending.filter((operation) => !dexieIds.has(operation.operationId)).length;
        } catch (error) {
          console.error('Failed to count Android SQLite outbox:', error);
        }
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
      for (const table of tables) {
        if (isNativeAndroid()) {
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
    const queued = await db.syncOperations
      .where('status')
      .anyOf(['pending', 'error'])
      .toArray();

    // On Android, native SQLite is the durable outbox. Merge older Dexie-only
    // entries so upgrades do not strand operations created by previous builds.
    let nativeQueued: Array<any> = [];
    if (isNativeAndroid()) {
      try {
        nativeQueued = await listNativePendingPosOperations();
      } catch (error) {
        console.error('Android SQLite outbox unavailable; using Dexie recovery queue:', error);
      }
    }
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
      const isNativeOperation = isNativeAndroid() && nativeIds.has(queuedOperation.id);
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
      // Older Android clients may already have a queued purchase_update from
      // before the SQLite transaction guard was added. Never send it to the
      // server: local reversal/replacement is not yet atomic in SQLite.
      if (isNativeOperation && currentOperation.type === 'purchase_update') {
        await markNativePosOperationConflict(
          currentOperation.id,
          'تعديل فاتورة الشراء متوقف على Android حتى اكتمال ترحيله الذري إلى SQLite؛ لم تُرسل العملية إلى الخادم',
        );
        continue;
      }
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
          if (isNativeOperation) {
            // SQLite owns Android's durable queue; acknowledge it before touching
            // any optional Dexie compatibility copy.
            await acknowledgeNativePosOperation(op.id);
            if (queued.some((candidate) => candidate.id === op.id)) {
              await db.syncOperations.update(op.id, {
                status: 'synced', lastError: undefined, updatedAt: new Date().toISOString(),
              });
            }
          } else {
            await db.syncOperations.update(op.id, {
              status: 'synced', lastError: undefined, updatedAt: new Date().toISOString(),
            });
          }
          await reconcileLocalOperationAfterAck(op.type, op.payload, op.id, res.result);
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
    const table = (db as any)[tableName];
    if (!table) return false;
    const recordKey = record?.id ?? record?.key;
    if (recordKey === undefined || recordKey === null) return false;
    let sourceRecord = record;

    // On Android, read the committed entity from SQLite rather than trusting
    // the Dexie hook payload, which may be stale or only a compatibility copy.
    if (isNativeAndroid()) {
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
        const savedKey = serverRes?.id ?? sourceRecord.id ?? sourceRecord.key;
        const saved = await table.get(savedKey);
        if (isNativeAndroid()) {
          if (String(recordKey) !== String(savedKey)) await nativePosRepository.delete(tableName as any, recordKey);
          if (saved) {
            await mirrorNativePosRecord(tableName, saved);
            await nativePosRepository.setSyncState(tableName as any, saved.id ?? saved.key, 'synced');
          }
        } else if (saved) {
          await mirrorNativePosRecord(tableName, saved).catch((error) => console.warn('Android SQLite entity snapshot failed:', error));
        }
        return true;
      } catch (err) {
        console.error(`Failed to push ${tableName} record directly:`, err);
        await updateRecordWithoutSyncHook(tableName, recordKey, { syncStatus: 'pending' });
        const saved = await table.get(recordKey);
        if (isNativeAndroid()) {
          if (saved) await mirrorNativePosRecord(tableName, saved);
          await nativePosRepository.setSyncState(tableName as any, recordKey, 'pending');
        } else if (saved) {
          await mirrorNativePosRecord(tableName, saved).catch((error) => console.warn('Android SQLite entity snapshot failed:', error));
        }
        return false;
      }
    }

    await updateRecordWithoutSyncHook(tableName, recordKey, { syncStatus: 'pending' });
    const saved = await table.get(recordKey);
    if (isNativeAndroid()) {
      if (saved) await mirrorNativePosRecord(tableName, saved);
      await nativePosRepository.setSyncState(tableName as any, recordKey, 'pending');
    } else if (saved) {
      await mirrorNativePosRecord(tableName, saved).catch((error) => console.warn('Android SQLite entity snapshot failed:', error));
    }
    return false;
  },

  async reconcilePushedRecord(tableName: string, localRecord: any, serverRes: any) {
    const table = (db as any)[tableName];
    if (!table) return;
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
    }
    return null;
  },

  async pushTable(tableName: string) {
    if (await this.getDeviceRole() === 'standalone') return;
    if (!(db as any)[tableName]) return;
    const pendingRecords = isNativeAndroid()
      ? (await nativePosRepository.getAllWithSyncState(tableName as any))
          .filter((item) => item.syncState === 'pending' || item.syncState === 'error')
          .map((item) => item.record)
      : await (db as any)[tableName].where('syncStatus').anyOf(['pending', 'error']).toArray();

    for (const record of pendingRecords) {
      const recordKey = record.id ?? record.key;
      try {
        const serverRes = await this.sendRecordToServer(tableName, record);
        await this.reconcilePushedRecord(tableName, record, serverRes);
        if (isNativeAndroid()) {
          const saved = await (db as any)[tableName].get(serverRes?.id ?? recordKey);
          if (recordKey !== undefined && saved?.id !== undefined && String(recordKey) !== String(saved.id)) {
            await nativePosRepository.delete(tableName as any, recordKey);
          }
          if (saved) {
            await mirrorNativePosRecord(tableName, saved);
            await nativePosRepository.setSyncState(tableName as any, saved.id ?? saved.key, 'synced');
          }
        }
      } catch (err: any) {
        console.error(`Failed to push ${tableName} record:`, record, err);
        const conflict = err.response && err.response.status === 409;
        await updateRecordWithoutSyncHook(tableName, recordKey, { syncStatus: conflict ? 'conflict' : 'error' });
        if (isNativeAndroid() && recordKey !== undefined) {
          await nativePosRepository.setSyncState(tableName as any, recordKey, conflict ? 'local' : 'error');
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

      const dexiePendingOperations = await db.syncOperations
        .where('status')
        .anyOf(['pending', 'error', 'syncing'])
        .toArray();
      let pendingOpsCount = dexiePendingOperations.length;
      if (isNativeAndroid()) {
        const dexieIds = new Set(dexiePendingOperations.map((operation) => operation.id));
        const nativePending = await listNativePendingPosOperations();
        pendingOpsCount += nativePending.filter((operation) => !dexieIds.has(operation.operationId)).length;
      }

      const pullTasks: Array<{
        table: any;
        api: () => Promise<any>;
        preserveLocalAuth?: boolean;
        excludeKeys?: string[];
        noSyncStatus?: boolean;
        authoritativeReplaceSynced?: boolean;
      }> = [
        { table: db.products, api: () => apiService.getProducts() },
        { table: db.categories, api: () => apiService.getCategories() },
        { table: db.customers, api: () => apiService.getCustomers() },
        { table: db.customerPayments, api: () => apiService.getCustomerPayments(), authoritativeReplaceSynced: true },
        { table: db.suppliers, api: () => apiService.getSuppliers() },
        { table: db.supplierPayments, api: () => apiService.getSupplierPayments(), authoritativeReplaceSynced: true },
        { table: db.employees, api: () => apiService.getEmployees(), preserveLocalAuth: true },
        { table: db.settings, api: () => apiService.getSettings(), excludeKeys: ['deviceRole', 'serverUrl'] },
        { table: db.branches, api: () => apiService.getBranches() },
        { table: db.offers, api: () => apiService.getOffers() },
        { table: db.shifts, api: () => apiService.getShifts() },
        { table: db.shiftMovements, api: () => apiService.getShiftMovements(), authoritativeReplaceSynced: true },
        { table: db.expenses, api: () => apiService.getExpenses() },
        { table: db.orders, api: () => apiService.getOrders() },
        { table: db.orderItems, api: () => apiService.getOrderItems(), authoritativeReplaceSynced: true },
        { table: db.returns, api: () => apiService.getReturns() },
        { table: db.returnItems, api: () => apiService.getReturnItems(), authoritativeReplaceSynced: true },
        { table: db.accounts, api: () => apiService.getAccounts(), noSyncStatus: true },
        { table: db.journalEntries, api: () => apiService.getJournalEntries(), authoritativeReplaceSynced: true },
        { table: db.transactions, api: () => apiService.getTransactions(), authoritativeReplaceSynced: true },
        { table: db.inventoryBatches, api: () => apiService.getInventoryBatches(), authoritativeReplaceSynced: true },
        {
          table: db.inventoryMovements,
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
        },        { table: db.inventoryAlerts, api: () => apiService.getInventoryAlerts(), noSyncStatus: true },
        { table: db.loyaltyTransactions, api: () => apiService.getLoyaltyTransactions() },
        { table: db.purchases, api: () => apiService.getPurchases() },
        { table: db.purchaseItems, api: () => apiService.getPurchaseItems(), authoritativeReplaceSynced: true },
        { table: db.purchaseReturns, api: () => apiService.getPurchaseReturns() },
        { table: db.purchaseReturnItems, api: () => apiService.getPurchaseReturnItems(), authoritativeReplaceSynced: true },
        { table: db.attendance, api: () => apiService.getAttendance() },
        { table: db.payroll, api: () => apiService.getPayroll() },
        { table: db.auditLogs, api: () => apiService.getAuditLogs() },
        { table: db.stocktakingSessions, api: () => apiService.getStocktakingSessions() },
        { table: db.stocktakingEntries, api: () => apiService.getStocktakingEntries() },
        { table: db.serviceRecipes, api: () => apiService.getServiceRecipes(), authoritativeReplaceSynced: true },
        { table: db.exchangeRateHistory, api: () => apiService.getExchangeRateHistory(), authoritativeReplaceSynced: true },
        { table: db.fiscalPeriods, api: () => apiService.getFiscalPeriods(), authoritativeReplaceSynced: true },
      ];

      (globalThis as any).__posApplyingOperation = true;
      try {
        for (const task of pullTasks) {
          try {
            const data = await task.api();
            if (!Array.isArray(data)) continue;

            if (isNativeAndroid()) {
              const entity = task.table.name;
              const existingNative = await nativePosRepository.getAllWithSyncState(entity as any);
              const existingById = new Map(existingNative.map((item) => {
                const record: any = item.record;
                return [record.id ?? record.key ?? record.code, record];
              }));
              if (task.noSyncStatus) {
                const changes = data.map((record: any) => ({
                  action: 'put' as const, entity: entity as any, record, syncState: 'synced' as const,
                }));
                const applied = changes.length ? await nativePosRepository.applyChanges(changes) : 0;
                if (applied !== changes.length) throw new Error('SQLite did not apply the complete server snapshot for ' + entity);
                if (data.length) await task.table.bulkPut(data);
                continue;
              }

              const pendingLocal = existingNative.filter((item) => item.syncState === 'pending' || item.syncState === 'error');
              const pendingIds = new Set(pendingLocal.map((item) => {
                const record: any = item.record;
                return record.id ?? record.key ?? record.code;
              }));
              const changes: Array<any> = [];
              const staleIds: any[] = [];
              if (task.authoritativeReplaceSynced && pendingOpsCount === 0) {
                const serverIds = new Set(data.map((item: any) => item.id ?? item.key ?? item.code));
                for (const item of existingNative) {
                  const record: any = item.record;
                  const key = record.id ?? record.key ?? record.code;
                  if (item.syncState === 'synced' && key !== undefined && !serverIds.has(key)) {
                    staleIds.push(key);
                    changes.push({ action: 'delete', entity: entity as any, key });
                  }
                }
              }

              let filtered = data.filter((item: any) => !pendingIds.has(item.id ?? item.key ?? item.code));
              if (task.excludeKeys) {
                const excluded = new Set(task.excludeKeys);
                filtered = filtered.filter((item: any) => !excluded.has(item.key));
              }
              const recordsToPut = filtered.map((item: any) => {
                const normalized = { ...item };
                if (task.preserveLocalAuth) {
                  const previous = existingById.get(item.id);
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
              if (staleIds.length) await task.table.bulkDelete(staleIds);
              if (recordsToPut.length) await task.table.bulkPut(recordsToPut);
              continue;
            }

            if (task.noSyncStatus) {
              await task.table.bulkPut(data);
              continue;
            }

            const existingAll = await task.table.toArray();
            const existingById = new Map(existingAll.map((r: any) => [r.id || r.key, r]));

            const pendingLocal = await task.table
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
                await task.table.bulkDelete(staleIds);
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
              await task.table.bulkPut(recordsToPut);
            }
          } catch (err: any) {
            // Silently skip or log clean debug warning instead of noisy console.error stack traces
            if (process.env.NODE_ENV !== 'production') {
              console.warn('Skipped pulling table data:', err?.message || err);
            }
          }
        }
        if (isNativeAndroid()) {
          try {
            const { mirrorNativePosDatabase } = await import('./nativeDatabaseMirror');
            await mirrorNativePosDatabase();
          } catch (mirrorError) {
            console.warn('Android SQLite snapshot refresh failed:', mirrorError);
          }
        }
      } finally {
        (globalThis as any).__posApplyingOperation = false;
      }
    } catch (err) {
      // Silently catch pull failures when offline or server unreachable
    }
  },

  initAutoSync() {
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
