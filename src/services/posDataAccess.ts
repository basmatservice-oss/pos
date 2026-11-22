import { nativePosRepository, notifyNativeEntityChanges, type NativePosEntity, type NativePosSyncState } from '../native/nativePosRepository';
import { isNativeAndroid } from '../native/posLocalDatabase';
import { isElectronLocalClient } from '../native/electronPosRepository';
const isLocalSqlite = (): boolean => isNativeAndroid() || isElectronLocalClient();

const isWindowsServer = (): boolean => {
  if (typeof window === 'undefined' || !(window as any).electronAPI?.getDeviceRole) return false;
  return !isElectronLocalClient() && !isNativeAndroid();
};

const notifyWindowsServerEntityChange = (entity: NativePosEntity): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pos-server-record-changed', { detail: { entity } }));
  }
};

const SERVER_READ_ENDPOINTS: Partial<Record<NativePosEntity, string>> = {
  categories: '/categories',
  products: '/products',
  customers: '/customers',
  suppliers: '/suppliers',
  orders: '/orders',
  orderItems: '/orderItems',
  returns: '/returns',
  returnItems: '/returnItems',
  accounts: '/accounts',
  journalEntries: '/journalEntries',
  transactions: '/transactions',
  shifts: '/shifts',
  shiftMovements: '/shiftMovements',
  expenses: '/expenses',
  employees: '/employees',
  settings: '/settings',
  attendance: '/attendance',
  loyaltyTransactions: '/loyalty-transactions',
  payroll: '/payroll',
  branches: '/branches',
  offers: '/offers',
  purchases: '/purchases',
  purchaseItems: '/purchaseItems',
  purchaseReturns: '/purchaseReturns',
  purchaseReturnItems: '/purchaseReturnItems',
  customerPayments: '/customerPayments',
  supplierPayments: '/supplierPayments',
  auditLogs: '/auditLogs',
  stocktakingSessions: '/stocktakingSessions',
  stocktakingEntries: '/stocktakingEntries',
  inventoryBatches: '/inventoryBatches',
  serviceRecipes: '/serviceRecipes',
  exchangeRateHistory: '/exchangeRateHistory',
  fiscalPeriods: '/fiscalPeriods',
  inventoryAlerts: '/inventoryAlerts',
  inventoryMovements: '/inventoryMovements',
  unitDefinitions: '/unitDefinitions',
  productUnits: '/productUnits',
};

// Generic record writes are deliberately limited to metadata-only endpoints.
// Stock, costs, customer/supplier balances, shifts and source documents must use
// executeOperation so inventory/accounting effects cannot be bypassed.
const SERVER_UPDATE_ENDPOINTS: Partial<Record<NativePosEntity, (record: Record<string, unknown>) => string>> = {
  categories: (r) => `/categories/${encodeURIComponent(String(r.id))}`,
  products: (r) => `/products/${encodeURIComponent(String(r.id))}`,
  customers: (r) => `/customers/${encodeURIComponent(String(r.id))}`,
  suppliers: (r) => `/suppliers/${encodeURIComponent(String(r.id))}`,
  employees: (r) => `/employees/${encodeURIComponent(String(r.id))}`,
  attendance: (r) => `/attendance/${encodeURIComponent(String(r.id))}`,
  branches: (r) => `/branches/${encodeURIComponent(String(r.id))}`,
  offers: (r) => `/offers/${encodeURIComponent(String(r.id))}`,
};

const SERVER_UPDATE_FIELDS: Partial<Record<NativePosEntity, readonly string[]>> = {
  categories: ['name', 'color', 'icon', 'branchId'],
  products: ['name', 'barcode', 'categoryId', 'sellingPrice', 'priceInUSD', 'vatRate', 'minStockLevel',
    'unit', 'baseUnitCode', 'itemType', 'allowFractions', 'unitsJson', 'quantityPrecision',
    'isActive', 'imageUrl', 'branchId', 'expiryDate', 'batchNumber'],
  customers: ['name', 'phone', 'email', 'branchId'],
  suppliers: ['name', 'phone', 'email', 'address'],
  employees: ['name', 'username', 'role', 'phone', 'salary', 'salaryType', 'branchId',
    'permissions', 'password', 'pinCode', 'mustChangePassword', 'deviceType', 'joinDate', 'status'],
  attendance: ['employeeId', 'employeeName', 'date', 'checkIn', 'checkOut', 'totalHours', 'branchId', 'status'],
  branches: ['name', 'address', 'phone', 'email', 'status', 'isActive'],
  offers: ['name', 'type', 'value', 'isActive', 'applicableProducts', 'minPurchaseAmount',
    'buyProductId', 'buyQuantity', 'getProductId', 'getQuantity', 'discountPercentage',
    'discountAmount', 'startDate', 'endDate', 'status', 'branchId'],
};

const SERVER_DELETE_ENDPOINTS: Partial<Record<NativePosEntity, (key: unknown) => string>> = {
  categories: (key) => `/categories/${encodeURIComponent(String(key))}`,
  employees: (key) => `/employees/${encodeURIComponent(String(key))}`,
  branches: (key) => `/branches/${encodeURIComponent(String(key))}`,
  offers: (key) => `/offers/${encodeURIComponent(String(key))}`,
  purchases: (key) => `/purchases/${encodeURIComponent(String(key))}`,
  expenses: (key) => `/expenses/${encodeURIComponent(String(key))}`,
  serviceRecipes: (key) => `/serviceRecipes/${encodeURIComponent(String(key))}`,
};

type PosRecord = Record<string, unknown>;

const SERVER_PRIMARY_KEY_FIELDS: Partial<Record<NativePosEntity, string>> = {
  accounts: 'code',
  unitDefinitions: 'code',
  settings: 'key',
};

async function getWindowsServerRecords<T extends PosRecord>(entity: NativePosEntity): Promise<T[]> {
  // Held orders are transient UI drafts and are intentionally not persisted by the server.
  if (entity === 'heldOrders') return [];
  const endpoint = SERVER_READ_ENDPOINTS[entity];
  if (!endpoint) throw new Error(`No authoritative Windows Server read endpoint is registered for ${entity}`);
  const { apiService } = await import('./apiService');
  if (entity !== 'inventoryMovements') return await apiService.get(endpoint) as T[];

  const records: T[] = [];
  let offset = 0;
  while (true) {
    const page = await apiService.get(`${endpoint}?offset=${offset}&limit=2000`);
    if (Array.isArray(page)) {
      records.push(...page as T[]);
      break;
    }
    if (!Array.isArray(page?.items)) {
      throw new Error('Windows Server returned an invalid inventory movements page');
    }
    records.push(...page.items as T[]);
    if (page.nextOffset === null || page.nextOffset === undefined) break;
    const nextOffset = Number(page.nextOffset);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new Error('Windows Server returned an invalid inventory movements cursor');
    }
    offset = nextOffset;
  }
  return records;
}

/** Read one business record from the active platform's authoritative database. */
export async function getPosRecord<T extends object = PosRecord>(
  entity: NativePosEntity,
  key: unknown,
): Promise<T | undefined> {
  if (isLocalSqlite()) return (await nativePosRepository.get(entity, key)) as T | undefined;
  if (isWindowsServer()) {
    const records = await getWindowsServerRecords(entity) as unknown as T[];
    const keyField = SERVER_PRIMARY_KEY_FIELDS[entity] || 'id';
    return records.find((record) => (record as PosRecord)[keyField] === key || (entity === 'settings' && (record as PosRecord).id === key));
  }
  const { db } = await import('../db/db');
  return await db.table(entity).get(key as any) as T | undefined;
}

/** Read from SQLite on Android/Windows Client and the authoritative API on Windows Server. */
export async function getPosRecords<T extends object = PosRecord>(
  entity: NativePosEntity,
): Promise<T[]> {
  let records: T[];
  if (isLocalSqlite()) {
    records = await nativePosRepository.getAll(entity) as unknown as T[];
  } else if (isWindowsServer()) {
    records = await getWindowsServerRecords(entity) as unknown as T[];
  } else {
    const { db } = await import('../db/db');
    records = await db.table(entity).toArray() as T[];
  }

  // ProductUnit + UnitDefinition are the normalized catalog. Project them into
  // the legacy Product.unitsJson shape at the data boundary so existing POS,
  // barcode, purchase and return screens share one canonical source without
  // rewriting historical OrderItem/ReturnItem snapshots.
  if (entity === 'products' && records.length) {
    try {
      const [unitRows, definitions] = await Promise.all([
        getPosRecords<Record<string, any>>('productUnits'),
        getPosRecords<Record<string, any>>('unitDefinitions'),
      ]);
      if (unitRows.length) {
        const namesByCode = new Map(definitions.map((definition) => [String(definition.code), String(definition.name || '')]));
        const rowsByProduct = new Map<string, Record<string, any>[]>();
        for (const row of unitRows) {
          const key = String(row.productId);
          const list = rowsByProduct.get(key) || [];
          list.push(row);
          rowsByProduct.set(key, list);
        }
        records = records.map((record) => {
          const product = record as Record<string, any>;
          const normalized = rowsByProduct.get(String(product.id));
          if (!normalized) return record; // legacy-only product: retain unitsJson fallback
          const extras = normalized.filter((unit) => !Boolean(unit.isBaseUnit)).map((unit) => ({
            name: namesByCode.get(String(unit.unitCode)) || String(unit.unitCode),
            barcode: unit.barcode || undefined,
            conversionFactor: Number(unit.conversionToBase),
            sellingPrice: unit.sellingPrice == null ? undefined : Number(unit.sellingPrice),
            costPrice: unit.costPrice == null ? undefined : Number(unit.costPrice),
            priceInUSD: Number(unit.priceInUSD || 0),
            allowFractions: Boolean(unit.allowFractions),
          }));
          return { ...product, unitsJson: JSON.stringify(extras) } as T;
        });
      }
    } catch (error) {
      // A partially synchronized catalog must not make all product reads fail.
      console.warn('Normalized product-unit catalog unavailable; using legacy product unit metadata:', error);
    }
  }
  return records;
}

/** Equality-filtered reads use the platform's authoritative data source. */
export async function getPosRecordsWhereEquals<T extends object = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T[]> {
  if (isLocalSqlite()) return await nativePosRepository.whereEquals(entity, field, value) as unknown as T[];
  if (isWindowsServer()) {
    const records = await getPosRecords<T>(entity);
    return records.filter((record) => (record as PosRecord)[field] === value);
  }
  const { db } = await import('../db/db');
  return await db.table(entity).where(field).equals(value as any).toArray() as T[];
}

/** Return the first equality match using the platform's primary data store. */
export async function getFirstPosRecordWhereEquals<T extends object = PosRecord>(
  entity: NativePosEntity,
  field: string,
  value: string | number | boolean,
): Promise<T | undefined> {
  if (isLocalSqlite()) return (await nativePosRepository.firstWhereEquals(entity, field, value)) as T | undefined;
  if (isWindowsServer()) return (await getPosRecordsWhereEquals<T>(entity, field, value))[0];
  const { db } = await import('../db/db');
  return await db.table(entity).where(field).equals(value as any).first() as T | undefined;
}

/** Persist one record through the active platform's primary database. */
export async function putPosRecord<T extends PosRecord = PosRecord>(
  entity: NativePosEntity,
  record: T,
  syncState: NativePosSyncState = 'local',
): Promise<void> {
  if (isLocalSqlite()) {
    await nativePosRepository.put(entity, record, syncState);
    return;
  }
  if (isWindowsServer()) {
    const { apiService } = await import('./apiService');
    if (entity === 'settings') {
      if (typeof record.key !== 'string') throw new Error('Windows Server settings require a logical key');
      await apiService.updateSetting(record.key, { value: record.value });
      notifyWindowsServerEntityChange(entity);
      return;
    }
    const endpoint = SERVER_UPDATE_ENDPOINTS[entity]?.(record);
    if (!endpoint || record.id == null) {
      throw new Error(`No safe Windows Server update endpoint is registered for ${entity}`);
    }
    const allowedFields = SERVER_UPDATE_FIELDS[entity];
    if (!allowedFields) throw new Error(`Windows Server generic updates are disabled for ${entity}; use its business operation endpoint`);
    const safeRecord: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(record, field)) safeRecord[field] = record[field];
    }
    if (!Object.keys(safeRecord).length) throw new Error(`No safe metadata fields were supplied for ${entity}`);
    await apiService.put(endpoint, safeRecord);
    notifyWindowsServerEntityChange(entity);
    return;
  }
  const { db } = await import('../db/db');
  await db.table(entity).put(record as any);
}

/** Delete one record from the active platform's primary database. */
export async function deletePosRecord(
  entity: NativePosEntity,
  key: unknown,
): Promise<void> {
  if (isLocalSqlite()) {
    const deleted = await nativePosRepository.delete(entity, key);
    if (!deleted) throw new Error(`Could not delete ${entity} record from SQLite`);
    return;
  }
  if (isWindowsServer()) {
    const { apiService } = await import('./apiService');
    if (entity === 'settings') {
      const setting = await getPosRecord<any>('settings', key);
      if (setting?.key) {
        await apiService.delete(`/settings/${encodeURIComponent(String(setting.key))}`);
        notifyWindowsServerEntityChange(entity);
      }
      return;
    }
    const endpoint = SERVER_DELETE_ENDPOINTS[entity]?.(key);
    if (!endpoint) throw new Error(`No safe Windows Server delete endpoint is registered for ${entity}`);
    await apiService.delete(endpoint);
    notifyWindowsServerEntityChange(entity);
    return;
  }
  const { db } = await import('../db/db');
  await db.table(entity).delete(key as any);
}

let generatedSettingId = 0;

/** Upsert a setting by its logical key while retaining the native/Dexie primary id. */
export async function putPosSetting(
  key: string,
  value: unknown,
  syncStatus: NativePosSyncState = 'local',
): Promise<void> {
  const matches = await getPosRecordsWhereEquals<any>('settings', 'key', key);
  const existing = matches[0];
  const now = new Date().toISOString();
  const id = existing?.id ?? (Date.now() * 1000 + (++generatedSettingId % 1000));
  const record = {
    ...existing,
    id,
    key,
    value,
    syncStatus,
    updatedAt: now,
  };

  if (isLocalSqlite()) {
    // Keep logical-key deduplication and the replacement in one SQLite transaction.
    const changes = [
      ...matches.slice(1).filter((item) => item.id != null).map((item) => ({
        action: 'delete' as const, entity: 'settings' as const, key: item.id,
      })),
      { action: 'put' as const, entity: 'settings' as const, record, syncState: syncStatus },
    ];
    const applied = await nativePosRepository.applyChanges(changes);
    if (applied !== changes.length) throw new Error('SQLite did not confirm the complete settings upsert');
    notifyNativeEntityChanges(['settings']);
    return;
  }

  for (const duplicate of matches.slice(1)) {
    if (duplicate.id != null) await deletePosRecord('settings', duplicate.id);
  }
  await putPosRecord('settings', record, syncStatus);
}

/** Remove every row for a logical setting key. */
export async function deletePosSettingsByKey(key: string): Promise<void> {
  const matches = await getPosRecordsWhereEquals<any>('settings', 'key', key);
  if (isLocalSqlite()) {
    const changes = matches.filter((record) => record.id != null).map((record) => ({
      action: 'delete' as const, entity: 'settings' as const, key: record.id,
    }));
    if (!changes.length) return;
    const deleted = await nativePosRepository.applyChanges(changes);
    if (deleted !== changes.length) throw new Error('SQLite did not confirm deletion of every matching setting');
    notifyNativeEntityChanges(['settings']);
    return;
  }
  for (const record of matches) {
    if (record.id != null) await deletePosRecord('settings', record.id);
  }
}
