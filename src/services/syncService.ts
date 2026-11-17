import { db } from '../db/db';
import { apiService, getAuthToken } from './apiService';
import { useSyncStore } from '../store/syncStore';

const INVENTORY_MOVEMENT_CURSOR_KEY = '__local_inventory_movement_cursor__';

export const syncService = {
  cachedRole: null as string | null,

  async getDeviceRole() {
    if (this.cachedRole) return this.cachedRole;
    const setting = await db.settings.where('key').equals('deviceRole').first();
    this.cachedRole = setting ? setting.value : 'server';
    return this.cachedRole;
  },

  clearCachedRole() {
    this.cachedRole = null;
  },

  async updatePendingCount() {
    try {
      const pendingOps = await db.syncOperations
        .where('status')
        .anyOf(['pending', 'error', 'conflict'])
        .count();

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
        'inventoryMovements',
      ];
      let pendingRecords = 0;
      for (const table of tables) {
        if ((db as any)[table]) {
          const c = await (db as any)[table].where('syncStatus').anyOf(['pending', 'error', 'conflict']).count();
          pendingRecords += c;
        }
      }

      useSyncStore.getState().setPendingItemsCount(pendingOps + pendingRecords);
    } catch (e) {
      console.error('Failed to count pending items:', e);
    }
  },

  async syncAll() {
    const token = getAuthToken();
    if (!token) return false;
    // Set the lock before the first await so concurrent POS operations cannot
    // start overlapping push/pull cycles.
    if (useSyncStore.getState().isSyncing) return false;
    useSyncStore.getState().setSyncing(true);

    try {
      const reachable = await apiService.checkServerReachability(2500);
      useSyncStore.getState().setOnlineStatus(reachable);
      if (!reachable) return false;

      await this.pushOperationsQueue();
      const unresolvedOperations = await db.syncOperations
        .where('status')
        .anyOf(['pending', 'error', 'syncing', 'conflict'])
        .count();
      if (unresolvedOperations === 0) {
        await this.pushAll();
      }
      await this.pullAll();
      await this.pullInventoryMovements();
      await this.pullCurrencyLedger();
      await this.pullUnitCatalog();

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
    const conflictCount = await db.syncOperations.where('status').equals('conflict').count();
    if (conflictCount > 0) return;

    const queuedOps = (await db.syncOperations
      .where('status')
      .anyOf(['pending', 'error', 'syncing'])
      .toArray())
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Process one operation at a time. A delayed/failed/conflicted operation blocks
    // later operations so dependent stock and financial movements cannot be reordered.
    for (const op of queuedOps) {
      if (op.nextRetryAt && new Date(op.nextRetryAt).getTime() > Date.now()) break;
      const response = await apiService.executeOperationsBatch([{
        id: op.id,
        type: op.type,
        payload: op.payload,
        deviceId: op.deviceId,
        branchId: op.branchId,
      }]);
      const result = (response?.results || []).find((row: any) => row.operationId === op.id);
      if (result?.status === 'ok' || result?.status === 'duplicate') {
        if (op.type === 'entity_upsert' && op.payload?.table && op.payload?.record) {
          await this.reconcilePushedRecord(op.payload.table, op.payload.record, result?.result || op.payload.record);
        }
        await db.syncOperations.update(op.id, {
          status: 'synced',
          lastError: undefined,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const retryCount = (op.retryCount || 0) + 1;
      const backoffMs = Math.min(60000, 2000 * Math.pow(2, retryCount));
      const failedStatus = retryCount >= 8 ? 'conflict' : 'error';
      await db.syncOperations.update(op.id, {
        status: failedStatus,
        retryCount,
        lastError: result?.error || 'Unknown sync error',
        nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await db.inventoryMovements
        .where('operationId')
        .equals(op.id)
        .modify({ syncStatus: failedStatus });
      break;
    }
  },

  // Currency/rate records are server-authoritative. Devices only cache approved rates;
  // they never push or invent exchange rates while disconnected.
  async pullCurrencyLedger() {
    const [currencyRows, rateRows, baseConfig] = await Promise.all([
      apiService.getCurrencies(),
      apiService.getExchangeRates(),
      apiService.getBaseCurrency(),
    ]);

    await db.transaction('rw', db.currencies, db.exchangeRates, db.settings, async () => {
      for (const currency of currencyRows || []) {
        await db.currencies.put({ ...currency, syncStatus: 'synced' });
      }
      for (const rate of (rateRows || []).filter((item: any) => Boolean(item.approvedAt))) {
        await db.exchangeRates.put({ ...rate, syncStatus: 'synced' });
      }
      if (baseConfig?.baseCurrencyCode) {
        const existing = await db.settings.where('key').equals('baseCurrencyCode').first();
        const setting = { key: 'baseCurrencyCode', value: baseConfig.baseCurrencyCode, syncStatus: 'synced' as const, updatedAt: new Date().toISOString() };
        if (existing?.id !== undefined) await db.settings.update(existing.id, setting);
        else await db.settings.add(setting);
      }
    });
  },

  // Unit catalog is server-authoritative. Product unit definitions are cached for offline selection.
  async pullUnitCatalog() {
    const [unitRows, productUnitRows] = await Promise.all([
      apiService.getUnitDefinitions(),
      apiService.getProductUnits(),
    ]);
    await db.transaction('rw', db.unitDefinitions, db.productUnits, async () => {
      for (const unit of unitRows || []) {
        await db.unitDefinitions.put({ ...unit, syncStatus: 'synced' });
      }
      for (const unit of productUnitRows || []) {
        await db.productUnits.put({ ...unit, syncStatus: 'synced' });
      }
    });
  },

  // Inventory movements are append-only and paged by a stable (createdAt, id) cursor.
  // This avoids pulling the full ledger on every sync while preserving every historical row.
  async pullInventoryMovements() {
    if (!getAuthToken()) return;
    let cursorSetting = await db.settings.where('key').equals(INVENTORY_MOVEMENT_CURSOR_KEY).first();
    let cursor: { createdAt: string; id: string } | null = null;
    if (cursorSetting?.value) {
      try {
        cursor = JSON.parse(String(cursorSetting.value));
      } catch {
        cursor = null;
      }
    }

    const saveMovementRows = async (items: any[]) => {
      if (items.length === 0) return;
      await db.transaction('rw', db.inventoryMovements, db.syncOperations, async () => {
        const movementKeys = items.map((movement: any) => movement.movementKey);
        const localMatches = await db.inventoryMovements
          .where('movementKey')
          .anyOf(movementKeys)
          .toArray();
        const serverIds = new Set(items.map((movement: any) => movement.id));
        const staleLocalIds = localMatches
          .filter((movement) => !serverIds.has(movement.id))
          .map((movement) => movement.id);
        if (staleLocalIds.length > 0) {
          await db.inventoryMovements.bulkDelete(staleLocalIds);
        }
        await db.inventoryMovements.bulkPut(
          items.map((movement: any) => ({ ...movement, syncStatus: 'synced' }))
        );
        for (const movement of items) {
          // A historical backfill may have a legacy operationId, while a local
          // pending row for the same immutable source key carries the real one.
          const localOperationIds = localMatches
            .filter((local) => local.movementKey === movement.movementKey)
            .map((local) => local.operationId);
          const operationIds = [...new Set([movement.operationId, ...localOperationIds].filter(Boolean))];
          for (const operationId of operationIds) {
            const operation = await db.syncOperations.get(operationId);
            if (operation && operation.status !== 'synced') {
              await db.syncOperations.update(operation.id, {
                status: 'synced',
                lastError: undefined,
                nextRetryAt: undefined,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }
      });
    };

    // Reconcile pending rows by immutable source key first. This also handles
    // a movement that was backfilled before a device's cursor was established.
    const pendingRows = await db.inventoryMovements
      .where('syncStatus')
      .anyOf(['pending', 'error', 'conflict'])
      .toArray();
    const pendingKeys = [...new Set(pendingRows.map((movement) => movement.movementKey))];
    for (let index = 0; index < pendingKeys.length; index += 50) {
      let response: any;
      try {
        response = await apiService.getInventoryMovements({
          movementKeys: pendingKeys.slice(index, index + 50).join(','),
          limit: 500,
        });
      } catch (error: any) {
        if (error?.response?.status === 404) return;
        throw error;
      }
      if (!response || !Array.isArray(response.items)) {
        throw new Error('Invalid inventory movement reconciliation response');
      }
      await saveMovementRows(response.items);
    }

    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      let response: any;
      try {
        response = await apiService.getInventoryMovements({
          afterCreatedAt: cursor?.createdAt,
          afterId: cursor?.id,
          limit: 500,
        });
      } catch (error: any) {
        // Allow a newer terminal to connect to an older server during staged LAN upgrades.
        if (error?.response?.status === 404) return;
        throw error;
      }
      if (!response || !Array.isArray(response.items)) {
        throw new Error('Invalid inventory movement page response');
      }

      await saveMovementRows(response.items);
      if (response.nextCursor?.createdAt && response.nextCursor?.id) {
        const setting = {
          ...(cursorSetting || {}),
          key: INVENTORY_MOVEMENT_CURSOR_KEY,
          value: JSON.stringify(response.nextCursor),
          syncStatus: 'synced' as const,
          createdAt: cursorSetting?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        if (cursorSetting?.id !== undefined) {
          await db.settings.put({ ...setting, id: cursorSetting.id });
          cursorSetting = { ...setting, id: cursorSetting.id };
        } else {
          const id = await db.settings.add(setting);
          cursorSetting = { ...setting, id };
        }
      }

      if (!response.hasMore || !response.nextCursor) break;
      cursor = response.nextCursor;
    }
  },

  async pushAll() {
    const tables: string[] = [
      // Products/customers/suppliers/categories/expenses are synchronized through
      // idempotent operations. Pushing their full cached rows can overwrite newer
      // stock, FIFO cost, or financial balances from another terminal.
      'employees',
      'branches',
      'offers',
      'settings',
      'auditLogs',
    ];

    for (const table of tables) {
      await this.pushTable(table);
    }
  },

  async pushRecord(tableName: string, record: any) {
    if (!getAuthToken()) return false;
    const reachable = await apiService.checkServerReachability(1800);
    if (reachable) {
      try {
        const serverRes = await this.sendRecordToServer(tableName, record);
        await this.reconcilePushedRecord(tableName, record, serverRes);
        return true;
      } catch (err) {
        console.error(`Failed to push ${tableName} record directly:`, err);
        await (db as any)[tableName].update(record.id || record.key, { syncStatus: 'pending' });
        return false;
      }
    } else {
      await (db as any)[tableName].update(record.id || record.key, { syncStatus: 'pending' });
      return false;
    }
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
      if (localRecord.id !== undefined && localRecord.id !== serverRes.id) {
        await table.delete(localRecord.id).catch(() => {});
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
      case 'products': {
        if (record.id && record.id > 1000000) return await apiService.createProduct(record);
        const productPayload = { ...record };
        // Stock and weighted cost are owned by stock movements/FIFO. Product
        // metadata sync must never overwrite them from a stale terminal.
        delete (productPayload as any).stockQuantity;
        delete (productPayload as any).costPrice;
        delete (productPayload as any).baseUnitCode;
        delete (productPayload as any).quantityPrecision;
        return await apiService.updateProduct(record.id, productPayload);
      }
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
    }
    return null;
  },

  async pushTable(tableName: string) {
    if (!(db as any)[tableName]) return;
    const pendingRecords = await (db as any)[tableName]
      .where('syncStatus')
      .anyOf(['pending', 'error'])
      .toArray();

    for (const record of pendingRecords) {
      try {
        const serverRes = await this.sendRecordToServer(tableName, record);
        await this.reconcilePushedRecord(tableName, record, serverRes);
      } catch (err: any) {
        console.error(`Failed to push ${tableName} record:`, record, err);
        if (err.response && err.response.status === 409) {
          await (db as any)[tableName].update(record.id || record.key, { syncStatus: 'conflict' });
        } else {
          await (db as any)[tableName].update(record.id || record.key, { syncStatus: 'error' });
        }
      }
    }
  },

  async pullAll() {
    if (!getAuthToken()) return;
    try {
      const reachable = await apiService.checkServerReachability(1200);
      if (!reachable) return;

      const pendingOpsCount = await db.syncOperations
        .where('status')
        .anyOf(['pending', 'error', 'syncing', 'conflict'])
        .count();

      // Only optimistic rows still marked pending may be reconciled after the
      // operation queue is clear. Keep error rows untouched: they may represent
      // failed entity writes from pushAll and must remain retryable.
      if (pendingOpsCount === 0) {
        for (const table of db.tables) {
          // The movement ledger is reconciled by its cursor endpoint. Keep local
          // movements pending until the matching server movement is actually pulled.
          if (table.name === 'inventoryMovements') continue;
          if (!table.schema.indexes.some((index: any) => index.name === 'syncStatus')) continue;
          await table.where('syncStatus').equals('pending').modify({ syncStatus: 'synced' });
        }
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
        { table: db.settings, api: () => apiService.getSettings(), excludeKeys: ['deviceRole', 'serverUrl', INVENTORY_MOVEMENT_CURSOR_KEY] },
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
        { table: db.inventoryAlerts, api: () => apiService.getInventoryAlerts(), noSyncStatus: true },
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
      ];

      (globalThis as any).__posApplyingOperation = true;
      try {
        for (const task of pullTasks) {
          try {
            const data = await task.api();
            if (!Array.isArray(data)) continue;

            if (task.noSyncStatus) {
              await task.table.bulkPut(data);
              continue;
            }

            const existingAll = await task.table.toArray();
            const existingById = new Map(existingAll.map((r: any) => [r.id || r.key, r]));

            const pendingLocal = await task.table
              .where('syncStatus')
              .anyOf(['pending', 'error', 'conflict'])
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
