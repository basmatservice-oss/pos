import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../drizzle/schema.ts';

const now = '2026-11-20T12:00:00.000Z';
const primaryKeys = {
  products: 'id', inventoryBatches: 'id', inventoryMovements: 'id', settings: 'id', suppliers: 'id',
  accounts: 'code', journalEntries: 'id', transactions: 'id', serviceRecipes: 'id',
  stocktakingSessions: 'id', stocktakingEntries: 'id',
};

function createMemoryElectronBridge() {
  const records = new Map();
  const operations = new Map();
  const entityMap = (entity) => {
    if (!records.has(entity)) records.set(entity, new Map());
    return records.get(entity);
  };
  const seed = (entity, record, syncState = 'local') => {
    const recordId = JSON.stringify(record[primaryKeys[entity]]);
    entityMap(entity).set(recordId, { recordId, record: structuredClone(record), syncState, updatedAt: Date.now() });
  };
  const checkGuards = (guards = {}) => {
    if (guards.ifAbsentEntity && guards.ifAbsentRecordId &&
        entityMap(guards.ifAbsentEntity).has(guards.ifAbsentRecordId)) return false;
    if (guards.ifAbsentEntity && guards.ifAbsentField) {
      const exists = [...entityMap(guards.ifAbsentEntity).values()]
        .some((row) => String(row.record[guards.ifAbsentField]) === String(guards.ifAbsentValue));
      if (exists) return false;
    }
    for (const guard of guards.ifMatchGuards || []) {
      const row = entityMap(guard.entity).get(guard.recordId);
      if (!row || String(row.record[guard.field]) !== String(guard.expectedValue)) return false;
    }
    return true;
  };
  const bridge = {
    async initialize() { return { ready: true }; },
    async getRecords(entity) { return [...entityMap(entity).values()].map((row) => structuredClone(row)); },
    async getRecord(entity, recordId) {
      const item = entityMap(entity).get(recordId);
      return item ? { found: true, item: structuredClone(item) } : { found: false };
    },
    async putRecords(items) {
      for (const item of items) entityMap(item.entity).set(item.recordId, {
        recordId: item.recordId, record: structuredClone(item.record), syncState: item.syncState || 'local', updatedAt: Date.now(),
      });
      return { saved: true, count: items.length };
    },
    async applyRecordChanges(changes, guards) {
      if (!checkGuards(guards)) return { applied: 0, count: changes.length, skipped: true };
      for (const change of changes) {
        if (change.action === 'delete') entityMap(change.entity).delete(change.recordId);
        else entityMap(change.entity).set(change.recordId, {
          recordId: change.recordId, record: structuredClone(change.record), syncState: change.syncState || 'local', updatedAt: Date.now(),
        });
      }
      return { applied: changes.length, count: changes.length, skipped: false };
    },
    async getMeta() { return {}; },
    async setMeta() { return { saved: true }; },
    async saveAndEnqueueOperation(operation) {
      operations.set(operation.operationId, { ...operation, status: operation.status || 'staging' });
      return { saved: true, queued: true, duplicate: false, operationId: operation.operationId };
    },
    async enqueueOperation(operation) { operations.set(operation.operationId, operation); return { queued: true, duplicate: false, operationId: operation.operationId }; },
    async mergeOperations() { return { inserted: 0, duplicates: 0, total: operations.size }; },
    async listOperations() { return { operations: [...operations.values()] }; },
    async updateOperation(id, status, message) {
      const row = operations.get(id);
      if (!row) return { updated: false };
      operations.set(id, { ...row, status, lastError: message });
      return { updated: true };
    },
    async retryOperation(id) { return { updated: operations.has(id) }; },
    async updateOperationPayload(id, payload) { const row = operations.get(id); if (!row) return { updated: false, rows: 0 }; operations.set(id, { ...row, payload }); return { updated: true, rows: 1 }; },
    async acknowledgeOperation(id) { const row = operations.get(id); if (!row) return { updated: false }; operations.set(id, { ...row, status: 'synced' }); return { updated: true }; },
    async deleteOperation(id) { return { deleted: operations.delete(id) }; },
  };
  return { bridge, seed, records };
}

function createServerDatabase() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE Product (
      id INTEGER PRIMARY KEY, barcode TEXT, name TEXT NOT NULL, categoryId INTEGER,
      costPrice REAL DEFAULT 0, sellingPrice REAL DEFAULT 0, costInUSD REAL, priceInUSD REAL,
      stockQuantity REAL DEFAULT 0, minStockLevel REAL DEFAULT 5, unit TEXT DEFAULT 'piece',
      conversionFactor REAL DEFAULT 1, itemType TEXT DEFAULT 'stock', allowFractions INTEGER DEFAULT 0,
      unitsJson TEXT, baseUnitCode TEXT, quantityPrecision INTEGER DEFAULT 0, isActive INTEGER DEFAULT 1,
      vatRate REAL DEFAULT 0, imageUrl TEXT, branchId INTEGER, expiryDate TEXT, batchNumber TEXT,
      isSynced INTEGER DEFAULT 0, updatedAt TEXT NOT NULL, createdAt TEXT
    );
    CREATE TABLE InventoryBatch (
      id TEXT PRIMARY KEY, productId INTEGER NOT NULL, purchaseId TEXT, quantity REAL NOT NULL,
      remainingQuantity REAL NOT NULL, costPrice REAL NOT NULL, currency TEXT, exchangeRate REAL DEFAULT 1,
      purchaseDate TEXT NOT NULL, expiryDate TEXT, batchNumber TEXT, branchId INTEGER,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE UnitDefinition (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT, dimension TEXT NOT NULL,
      decimalPlaces INTEGER DEFAULT 0, isFractional INTEGER DEFAULT 0, isSystem INTEGER DEFAULT 0,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE ProductUnit (
      id TEXT PRIMARY KEY, productId INTEGER NOT NULL, unitCode TEXT NOT NULL,
      conversionToBase REAL NOT NULL, isBaseUnit INTEGER DEFAULT 0, sellingPrice REAL,
      costPrice REAL, priceInUSD REAL DEFAULT 0, allowFractions INTEGER DEFAULT 0,
      barcode TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE InventoryMovement (
      id TEXT PRIMARY KEY, movementKey TEXT UNIQUE NOT NULL, productId INTEGER NOT NULL,
      movementType TEXT NOT NULL, sourceType TEXT NOT NULL, sourceId TEXT NOT NULL,
      quantityDeltaBase REAL NOT NULL, baseUnitCode TEXT, unitCost REAL DEFAULT 0,
      totalCost REAL DEFAULT 0, branchId INTEGER, operationId TEXT, reason TEXT, createdBy TEXT,
      isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE InventoryAlert (
      id TEXT PRIMARY KEY, productId INTEGER NOT NULL, productName TEXT NOT NULL,
      previousQty REAL NOT NULL, changeQty REAL NOT NULL, resultingQty REAL NOT NULL,
      operationId TEXT, deviceId TEXT, reason TEXT NOT NULL, resolved INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE Account (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, parentCode TEXT,
      balance REAL DEFAULT 0, isSystem INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE JournalEntry (
      id TEXT PRIMARY KEY, entryNumber TEXT, date TEXT, referenceId TEXT, referenceType TEXT,
      description TEXT NOT NULL, totalDebit REAL DEFAULT 0, totalCredit REAL DEFAULT 0,
      status TEXT DEFAULT 'posted', reversedEntryId TEXT, createdBy TEXT, branchId INTEGER,
      isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE "Transaction" (
      id TEXT PRIMARY KEY, journalEntryId TEXT NOT NULL, accountId TEXT NOT NULL,
      accountName TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL,
      debit REAL DEFAULT 0, credit REAL DEFAULT 0, description TEXT,
      orderId TEXT, purchaseId TEXT, returnId TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE Setting (
      id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE FiscalPeriod (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, startDate TEXT NOT NULL, endDate TEXT NOT NULL,
      status TEXT DEFAULT 'open', closedAt TEXT, closedBy TEXT, notes TEXT,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE ProcessedOperation (
      operationId TEXT PRIMARY KEY, deviceId TEXT, operationType TEXT NOT NULL,
      status TEXT DEFAULT 'completed', resultJson TEXT, createdAt TEXT
    );
    CREATE TABLE "Order" (
      id TEXT PRIMARY KEY, receiptNumber TEXT, totalAmount REAL NOT NULL, discountAmount REAL DEFAULT 0,
      taxAmount REAL DEFAULT 0, netAmount REAL NOT NULL, paidAmount REAL DEFAULT 0,
      cashAmount REAL DEFAULT 0, cardAmount REAL DEFAULT 0, returnedAmount REAL DEFAULT 0,
      paymentMethod TEXT NOT NULL, currency TEXT, exchangeRate REAL DEFAULT 1, customerId INTEGER,
      customerName TEXT, branchId INTEGER, shiftId TEXT, tableNumber TEXT, orderType TEXT,
      status TEXT NOT NULL, createdBy TEXT, deviceId TEXT, operationId TEXT,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE OrderItem (
      id INTEGER PRIMARY KEY AUTOINCREMENT, orderId TEXT NOT NULL, productId INTEGER NOT NULL,
      productName TEXT NOT NULL, quantity REAL NOT NULL, returnedQuantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'piece', conversionFactor REAL DEFAULT 1, itemType TEXT DEFAULT 'stock',
      unitPrice REAL NOT NULL, costPriceAtTimeOfSale REAL DEFAULT 0, discountAmount REAL DEFAULT 0,
      subTotal REAL NOT NULL, taxAmount REAL NOT NULL, total REAL NOT NULL,
      batchAllocations TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE "Return" (
      id TEXT PRIMARY KEY, returnNumber TEXT NOT NULL, originalOrderId TEXT NOT NULL,
      originalReceiptNumber TEXT, customerId INTEGER, customerName TEXT, branchId INTEGER, shiftId TEXT,
      refundMethod TEXT NOT NULL, currency TEXT, exchangeRate REAL DEFAULT 1, subTotal REAL DEFAULT 0,
      discountAmount REAL DEFAULT 0, taxAmount REAL DEFAULT 0, totalRefund REAL NOT NULL,
      totalCostReversed REAL DEFAULT 0, reason TEXT, createdBy TEXT, deviceId TEXT, operationId TEXT,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE ReturnItem (
      id TEXT PRIMARY KEY, returnId TEXT NOT NULL, orderItemId INTEGER, productId INTEGER NOT NULL,
      productName TEXT NOT NULL, quantity REAL NOT NULL, condition TEXT DEFAULT 'resalable',
      unitPrice REAL NOT NULL, costPrice REAL DEFAULT 0, taxAmount REAL DEFAULT 0,
      total REAL NOT NULL, batchAllocations TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE Supplier (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT,
      balance REAL DEFAULT 0, isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE Purchase (
      id TEXT PRIMARY KEY, supplierId INTEGER, supplierName TEXT, totalAmount REAL NOT NULL,
      paymentStatus TEXT DEFAULT 'unpaid', paymentMethod TEXT DEFAULT 'cash', paidAmount REAL DEFAULT 0,
      returnedAmount REAL DEFAULT 0, currency TEXT, exchangeRate REAL DEFAULT 1,
      shippingCost REAL DEFAULT 0, customsCost REAL DEFAULT 0, otherCosts REAL DEFAULT 0,
      extraCostsPaymentMethod TEXT DEFAULT 'cash',
      date TEXT NOT NULL, branchId INTEGER, deviceId TEXT, operationId TEXT,
      isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE PurchaseItem (
      id INTEGER PRIMARY KEY AUTOINCREMENT, purchaseId TEXT NOT NULL, productId INTEGER NOT NULL,
      productName TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT DEFAULT 'piece',
      conversionFactor REAL DEFAULT 1, costPrice REAL NOT NULL, landedCostPerBaseUnit REAL,
      total REAL NOT NULL, expiryDate TEXT, batchNumber TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE PurchaseReturn (
      id TEXT PRIMARY KEY, returnNumber TEXT NOT NULL, originalPurchaseId TEXT NOT NULL,
      supplierId INTEGER, supplierName TEXT, branchId INTEGER, shiftId TEXT,
      refundMethod TEXT NOT NULL, currency TEXT, exchangeRate REAL DEFAULT 1,
      totalReturn REAL NOT NULL, reason TEXT, createdBy TEXT,
      deviceId TEXT, operationId TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT NOT NULL
    );
    CREATE TABLE PurchaseReturnItem (
      id TEXT PRIMARY KEY, purchaseReturnId TEXT NOT NULL, productId INTEGER NOT NULL,
      productName TEXT NOT NULL, quantity REAL NOT NULL, costPrice REAL NOT NULL,
      total REAL NOT NULL, batchId TEXT, isSynced INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE AuditLog (
      id TEXT PRIMARY KEY, date TEXT, type TEXT NOT NULL, userName TEXT NOT NULL,
      action TEXT NOT NULL, operationName TEXT, productName TEXT, details TEXT,
      quantity REAL DEFAULT 0, value REAL DEFAULT 0, branchId INTEGER,
      previousValue TEXT, newValue TEXT, entityId TEXT, entityName TEXT
    );
  `);
  return { raw, db: drizzle(raw, { schema }) };
}

test('production SQLite FIFO and native SQLite FIFO produce identical sale and return valuation', async () => {
  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.window = { electronAPI: { isElectron: true, posLocalDatabase: bridge }, dispatchEvent() { return true; } };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };

  const [{ setElectronDeviceRole }, localInventory, serverAccounting] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/localInventoryEngine.ts'),
    import('../server/accounting.ts'),
  ]);
  setElectronDeviceRole('client');

  const { db: serverDb, raw } = createServerDatabase();
  const product = {
    id: 1, name: 'FIFO test product', barcode: null, categoryId: null, costPrice: 6,
    sellingPrice: 10, stockQuantity: 10, minStockLevel: 0, unit: 'piece', conversionFactor: 1,
    itemType: 'stock', allowFractions: 0, baseUnitCode: 'piece', quantityPrecision: 0,
    isActive: 1, vatRate: 0, branchId: 1, isSynced: 0, updatedAt: now, createdAt: now,
  };
  const batches = [
    { id: 'batch-1', productId: 1, purchaseId: 'purchase-1', quantity: 5, remainingQuantity: 5, costPrice: 5, purchaseDate: '2026-01-01', branchId: 1, isSynced: 0, createdAt: '2026-01-01', updatedAt: now },
    { id: 'batch-2', productId: 1, purchaseId: 'purchase-2', quantity: 5, remainingQuantity: 5, costPrice: 7, purchaseDate: '2026-02-01', branchId: 1, isSynced: 0, createdAt: '2026-02-01', updatedAt: now },
  ];
  serverDb.insert(schema.products).values(product).run();
  serverDb.insert(schema.inventoryBatches).values(batches).run();
  seed('products', product);
  for (const batch of batches) seed('inventoryBatches', batch);
  seed('settings', { id: 1, key: 'inventoryValuationMethod', value: 'fifo' });

  const params = {
    productId: 1, quantityInBaseUnits: 7, operationId: 'sale-op-1', deviceId: 'test-device',
    sourceId: 'order-1', movementKeySuffix: '0', movementType: 'sale', sourceType: 'order',
    branchId: 1, createdBy: 'test', createdAt: now, allowNegative: false, syncStatus: 'pending',
  };
  const serverSale = serverDb.transaction((tx) => serverAccounting.consumeInventoryFIFO(tx, { ...params, valuationMethod: 'fifo' }));
  const localSale = await localInventory.consumeLocalInventoryFIFO(params);
  assert.equal(localSale.totalCost, serverSale.totalCost);
  assert.equal(localSale.averageUnitCost, serverSale.averageUnitCost);
  assert.deepEqual(localSale.allocations, serverSale.allocations);
  assert.equal(localSale.totalCost, 39);
  assert.equal(localSale.averageUnitCost, 39 / 7);

  const restoreParams = {
    productId: 1, quantityInBaseUnits: 3, allocations: localSale.allocations, fallbackCost: 6,
    operationId: 'return-op-1', deviceId: 'test-device', sourceId: 'return-1',
    movementKeySuffix: '0', movementType: 'sale_return', sourceType: 'return',
    branchId: 1, reason: 'resalable return', createdBy: 'test', createdAt: now, syncStatus: 'pending',
  };
  const serverRestore = serverDb.transaction((tx) => serverAccounting.restoreInventoryFIFO(tx, {
    ...restoreParams, valuationMethod: 'fifo',
  }));
  const localRestore = await localInventory.restoreLocalInventoryFIFO(restoreParams);
  assert.equal(localRestore, serverRestore.totalCostRestored);
  assert.equal(localRestore, 19);

  const serverProduct = serverDb.select().from(schema.products).get();
  const localProduct = records.get('products').get(JSON.stringify(1)).record;
  assert.equal(localProduct.stockQuantity, serverProduct.stockQuantity);
  assert.equal(localProduct.stockQuantity, 6);

  const serverBatches = serverDb.select().from(schema.inventoryBatches).all().sort((a, b) => a.id.localeCompare(b.id));
  const localBatches = [...records.get('inventoryBatches').values()].map((row) => row.record).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(localBatches.map((x) => [x.id, x.remainingQuantity, x.costPrice]), serverBatches.map((x) => [x.id, x.remainingQuantity, x.costPrice]));

  const serverMovements = serverDb.select().from(schema.inventoryMovements).all().sort((a, b) => a.movementKey.localeCompare(b.movementKey));
  const localMovements = [...records.get('inventoryMovements').values()].map((row) => row.record).sort((a, b) => a.movementKey.localeCompare(b.movementKey));
  assert.deepEqual(
    localMovements.map((x) => [x.movementKey, x.quantityDeltaBase, x.baseUnitCode, x.unitCost, x.totalCost]),
    serverMovements.map((x) => [x.movementKey, x.quantityDeltaBase, x.baseUnitCode, x.unitCost, x.totalCost]),
  );

  raw.close();
});

test('weighted-average sale and return valuation match between server and native SQLite', async () => {
  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.window = { electronAPI: { isElectron: true, posLocalDatabase: bridge }, dispatchEvent() { return true; } };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  const [{ setElectronDeviceRole }, localInventory, serverAccounting] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/localInventoryEngine.ts'),
    import('../server/accounting.ts'),
  ]);
  setElectronDeviceRole('client');
  const { db: serverDb, raw } = createServerDatabase();
  const product = {
    id: 2, name: 'Weighted-average product', barcode: null, categoryId: null, costPrice: 6,
    sellingPrice: 10, stockQuantity: 10, minStockLevel: 0, unit: 'piece', conversionFactor: 1,
    itemType: 'stock', allowFractions: 0, baseUnitCode: 'piece', quantityPrecision: 0,
    isActive: 1, vatRate: 0, branchId: 1, isSynced: 0, updatedAt: now, createdAt: now,
  };
  const batches = [
    { id: 'weighted-batch-1', productId: 2, purchaseId: 'p-1', quantity: 5, remainingQuantity: 5, costPrice: 5, purchaseDate: '2026-01-01', branchId: 1, isSynced: 0, createdAt: '2026-01-01', updatedAt: now },
    { id: 'weighted-batch-2', productId: 2, purchaseId: 'p-2', quantity: 5, remainingQuantity: 5, costPrice: 7, purchaseDate: '2026-02-01', branchId: 1, isSynced: 0, createdAt: '2026-02-01', updatedAt: now },
  ];
  serverDb.insert(schema.products).values(product).run();
  serverDb.insert(schema.inventoryBatches).values(batches).run();
  seed('products', product);
  for (const batch of batches) seed('inventoryBatches', batch);
  seed('settings', { id: 1, key: 'inventoryValuationMethod', value: 'weighted_average' });

  const params = {
    productId: 2, quantityInBaseUnits: 4, operationId: 'weighted-sale', deviceId: 'test-device',
    sourceId: 'weighted-order', movementKeySuffix: '0', movementType: 'sale', sourceType: 'order',
    branchId: 1, createdBy: 'test', createdAt: now, allowNegative: false, syncStatus: 'pending',
  };
  const serverSale = serverDb.transaction((tx) => serverAccounting.consumeInventoryFIFO(tx, { ...params, valuationMethod: 'weighted_average' }));
  const localSale = await localInventory.consumeLocalInventoryFIFO(params);
  assert.equal(localSale.totalCost, serverSale.totalCost);
  assert.equal(localSale.averageUnitCost, serverSale.averageUnitCost);
  assert.deepEqual(localSale.allocations, serverSale.allocations);
  assert.equal(localSale.totalCost, 24);

  const restoreParams = {
    productId: 2, quantityInBaseUnits: 2, allocations: localSale.allocations, fallbackCost: 6,
    operationId: 'weighted-return', deviceId: 'test-device', sourceId: 'weighted-return-1',
    movementKeySuffix: '0', movementType: 'sale_return', sourceType: 'return',
    branchId: 1, reason: 'weighted return', createdBy: 'test', createdAt: now, syncStatus: 'pending',
  };
  const serverRestore = serverDb.transaction((tx) => serverAccounting.restoreInventoryFIFO(tx, {
    ...restoreParams, valuationMethod: 'weighted_average',
  }));
  const localRestore = await localInventory.restoreLocalInventoryFIFO(restoreParams);
  assert.equal(localRestore, serverRestore.totalCostRestored);
  assert.equal(localRestore, 12);

  const serverProduct = serverDb.select().from(schema.products).get();
  const localProduct = records.get('products').get(JSON.stringify(2)).record;
  assert.equal(localProduct.stockQuantity, serverProduct.stockQuantity);
  assert.equal(localProduct.costPrice, serverProduct.costPrice);
  assert.equal(localProduct.costPrice, 6);
  const serverBatches = serverDb.select().from(schema.inventoryBatches).all().sort((a, b) => a.id.localeCompare(b.id));
  const localBatches = [...records.get('inventoryBatches').values()].map((row) => row.record).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(localBatches.map((x) => [x.id, x.remainingQuantity, x.costPrice]), serverBatches.map((x) => [x.id, x.remainingQuantity, x.costPrice]));
  raw.close();
});

test('server and native SQLite journal engines post matching sale, COGS, return and COGS-reversal entries', async () => {
  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.window = { electronAPI: { isElectron: true, posLocalDatabase: bridge }, dispatchEvent() { return true; } };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };

  const [{ setElectronDeviceRole }, localAccounting, serverAccounting] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/localAccountingEngine.ts'),
    import('../server/accounting.ts'),
  ]);
  setElectronDeviceRole('client');
  const { db: serverDb, raw } = createServerDatabase();
  const accountRows = [
    ['1010', 'Cash', 'asset'], ['1020', 'Card', 'asset'], ['1100', 'Receivables', 'asset'],
    ['1200', 'Inventory', 'asset'], ['2100', 'Payables', 'liability'], ['2200', 'VAT payable', 'liability'],
    ['3100', 'Capital', 'equity'], ['3200', 'Retained earnings', 'equity'],
    ['4100', 'Sales', 'revenue'], ['4200', 'Sales returns', 'revenue'], ['4300', 'Discounts', 'revenue'],
    ['5100', 'COGS', 'expense'], ['5200', 'Expenses', 'expense'], ['5300', 'Payroll', 'expense'],
    ['5400', 'Inventory adjustment', 'expense'],
  ].map(([code, name, type]) => ({ code, name, type, balance: 0, isSystem: 1, createdAt: now, updatedAt: now }));
  serverDb.insert(schema.accounts).values(accountRows).run();
  for (const account of accountRows) seed('accounts', account);

  const entries = [
    { referenceId: 'order-1', referenceType: 'order', entryKey: 'sale-revenue', description: 'Sale revenue', lines: [
      { accountCode: '1010', debit: 23, credit: 0, orderId: 'order-1' },
      { accountCode: '4100', debit: 0, credit: 20, orderId: 'order-1' },
      { accountCode: '2200', debit: 0, credit: 3, orderId: 'order-1' },
    ] },
    { referenceId: 'order-1', referenceType: 'order', entryKey: 'sale-cogs', description: 'Sale COGS', lines: [
      { accountCode: '5100', debit: 39, credit: 0, orderId: 'order-1' },
      { accountCode: '1200', debit: 0, credit: 39, orderId: 'order-1' },
    ] },
    { referenceId: 'return-1', referenceType: 'return', entryKey: 'return-refund', description: 'Return refund', lines: [
      { accountCode: '4200', debit: 10, credit: 0, orderId: 'order-1', returnId: 'return-1' },
      { accountCode: '2200', debit: 1.5, credit: 0, orderId: 'order-1', returnId: 'return-1' },
      { accountCode: '1010', debit: 0, credit: 11.5, orderId: 'order-1', returnId: 'return-1' },
    ] },
    { referenceId: 'return-1', referenceType: 'return', entryKey: 'return-cogs', description: 'Return COGS reversal', lines: [
      { accountCode: '1200', debit: 19, credit: 0, orderId: 'order-1', returnId: 'return-1' },
      { accountCode: '5100', debit: 0, credit: 19, orderId: 'order-1', returnId: 'return-1' },
    ] },
  ];

  for (const entry of entries) {
    serverDb.transaction((tx) => serverAccounting.postJournalEntry(tx, {
      referenceId: entry.referenceId, referenceType: entry.referenceType,
      description: entry.description, lines: entry.lines, createdBy: 'test', date: now,
    }));
    await localAccounting.postLocalJournalEntry({
      referenceId: entry.referenceId, referenceType: entry.referenceType, entryKey: entry.entryKey,
      description: entry.description, lines: entry.lines, createdBy: 'test', date: now,
    });
  }

  const serverAccounts = serverDb.select().from(schema.accounts).all().sort((a, b) => a.code.localeCompare(b.code));
  const localAccounts = [...records.get('accounts').values()].map((row) => row.record).sort((a, b) => a.code.localeCompare(b.code));
  assert.deepEqual(localAccounts.map((x) => [x.code, x.balance]), serverAccounts.map((x) => [x.code, x.balance]));

  const serverEntries = serverDb.select().from(schema.journalEntries).all();
  const localEntries = [...records.get('journalEntries').values()].map((row) => row.record);
  for (const entry of entries) {
    const serverHeader = serverEntries.find((x) => x.referenceId === entry.referenceId && x.description === entry.description);
    const localHeader = localEntries.find((x) => x.referenceId === entry.referenceId && x.description === entry.description);
    assert.ok(serverHeader);
    assert.ok(localHeader);
    assert.equal(localHeader.totalDebit, serverHeader.totalDebit);
    assert.equal(localHeader.totalCredit, serverHeader.totalCredit);
    const serverLines = serverDb.select().from(schema.transactions).all()
      .filter((x) => x.journalEntryId === serverHeader.id)
      .map((x) => [x.accountId, x.debit, x.credit]).sort((a, b) => a[0].localeCompare(b[0]));
    const localLines = [...records.get('transactions').values()].map((row) => row.record)
      .filter((x) => x.journalEntryId === localHeader.id)
      .map((x) => [x.accountId, x.debit, x.credit]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(localLines, serverLines);
  }
  raw.close();
});

test('end-to-end server business operations and native SQLite operations match for sale, partial return, FIFO and COGS', async () => {
  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.navigator = { onLine: true, userAgent: 'node-test' };
  const localStorageShim = { getItem() { return null; }, setItem() {} };
  globalThis.localStorage = localStorageShim;
  globalThis.window = {
    location: { hostname: 'localhost', protocol: 'http:', port: '3000', origin: 'http://localhost:3000' },
    navigator: globalThis.navigator,
    localStorage: localStorageShim,
    addEventListener() {},
    removeEventListener() {},
    electronAPI: { isElectron: true, posLocalDatabase: bridge },
    dispatchEvent() { return true; },
  };

  const [{ setElectronDeviceRole }, { dispatchOperation }, { executeBusinessOperation }] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/operationService.ts'),
    import('../server/operations.ts'),
  ]);
  setElectronDeviceRole('client');

  const { db: serverDb, raw } = createServerDatabase();
  const product = {
    id: 1, name: 'Parity product', barcode: null, categoryId: null, costPrice: 6,
    sellingPrice: 23 / 7, stockQuantity: 10, minStockLevel: 0, unit: 'piece',
    conversionFactor: 1, itemType: 'stock', allowFractions: 0, baseUnitCode: 'piece',
    quantityPrecision: 0, isActive: 1, vatRate: 0, branchId: 1, isSynced: 0,
    updatedAt: now, createdAt: now,
  };
  const batches = [
    { id: 'parity-batch-1', productId: 1, purchaseId: 'p-1', quantity: 5, remainingQuantity: 5, costPrice: 5, purchaseDate: '2026-01-01', branchId: 1, isSynced: 0, createdAt: '2026-01-01', updatedAt: now },
    { id: 'parity-batch-2', productId: 1, purchaseId: 'p-2', quantity: 5, remainingQuantity: 5, costPrice: 7, purchaseDate: '2026-02-01', branchId: 1, isSynced: 0, createdAt: '2026-02-01', updatedAt: now },
  ];
  const accountRows = [
    ['1010', 'Cash', 'asset'], ['1020', 'Card', 'asset'], ['1100', 'Receivables', 'asset'],
    ['1200', 'Inventory', 'asset'], ['2100', 'Payables', 'liability'], ['2200', 'VAT', 'liability'],
    ['3100', 'Capital', 'equity'], ['3200', 'Retained earnings', 'equity'],
    ['4100', 'Sales', 'revenue'], ['4200', 'Sales returns', 'revenue'], ['4300', 'Discounts', 'revenue'],
    ['5100', 'COGS', 'expense'], ['5200', 'Expenses', 'expense'], ['5300', 'Payroll', 'expense'],
    ['5400', 'Inventory adjustment', 'expense'],
  ].map(([code, name, type]) => ({ code, name, type, balance: 0, isSystem: 1, createdAt: now, updatedAt: now }));
  const settingRows = [
    { id: 1, key: 'deviceRole', value: 'client', isSynced: 0, createdAt: now, updatedAt: now },
    { id: 2, key: 'inventoryValuationMethod', value: 'fifo', isSynced: 0, createdAt: now, updatedAt: now },
    { id: 3, key: 'offlineStockPolicy', value: 'allow_with_alert', isSynced: 0, createdAt: now, updatedAt: now },
    { id: 4, key: 'currency', value: 'ر.س', isSynced: 0, createdAt: now, updatedAt: now },
  ];
  serverDb.insert(schema.products).values(product).run();
  serverDb.insert(schema.inventoryBatches).values(batches).run();
  serverDb.insert(schema.accounts).values(accountRows).run();
  serverDb.insert(schema.settings).values(settingRows).run();
  seed('products', product);
  for (const batch of batches) seed('inventoryBatches', batch);
  for (const account of accountRows) seed('accounts', account);
  for (const setting of settingRows) seed('settings', setting);

  const salePayload = {
    operationId: 'sale-op-parity', deviceId: 'parity-device',
    order: {
      id: 'parity-order', receiptNumber: 'INV-PARITY', totalAmount: 20, taxAmount: 3,
      netAmount: 23, paymentMethod: 'cash', currency: 'ر.س', exchangeRate: 1,
      branchId: 1, createdBy: 'tester', createdAt: now,
    },
    items: [{
      productId: 1, productName: 'Parity product', quantity: 7, unit: 'piece',
      conversionFactor: 1, itemType: 'stock', unitPrice: 23 / 7,
      discountAmount: 0, subTotal: 20, taxAmount: 3, total: 23,
    }],
  };
  const serverSale = executeBusinessOperation(serverDb, 'sale', salePayload, {
    operationId: salePayload.operationId, deviceId: salePayload.deviceId, userName: 'tester',
  });
  await dispatchOperation('sale', salePayload, 1);
  const serverOrderItem = serverSale.result.items[0];
  const localOrderItem = [...records.get('orderItems').values()].map((row) => row.record)[0];
  assert.equal(serverOrderItem.costPriceAtTimeOfSale, localOrderItem.costPriceAtTimeOfSale);
  assert.equal(serverOrderItem.costPriceAtTimeOfSale, 5.5714);

  const serverReturnPayload = {
    id: 'parity-return', returnNumber: 'RET-PARITY', originalOrderId: 'parity-order',
    items: [{ orderItemId: serverOrderItem.id, productId: 1, quantity: 3, condition: 'resalable' }],
    refundMethod: 'cash', reason: 'parity fixture', returnDate: now,
  };
  const localReturnPayload = {
    ...serverReturnPayload,
    items: [{ ...serverReturnPayload.items[0], orderItemId: localOrderItem.id }],
    operationId: 'return-op-parity', deviceId: 'parity-device',
  };
  const serverReturn = executeBusinessOperation(serverDb, 'return', serverReturnPayload, {
    operationId: 'return-op-parity', deviceId: 'parity-device', userName: 'tester',
  });
  await dispatchOperation('return', localReturnPayload, 1);

  const serverDamagedPayload = {
    id: 'parity-return-damaged', returnNumber: 'RET-PARITY-D', originalOrderId: 'parity-order',
    items: [{ orderItemId: serverOrderItem.id, productId: 1, quantity: 1, condition: 'damaged' }],
    refundMethod: 'cash', reason: 'damaged parity fixture', returnDate: now,
  };
  const localDamagedPayload = {
    ...serverDamagedPayload,
    items: [{ ...serverDamagedPayload.items[0], orderItemId: localOrderItem.id }],
    operationId: 'return-op-parity-damaged', deviceId: 'parity-device',
  };
  const serverDamagedReturn = executeBusinessOperation(serverDb, 'return', serverDamagedPayload, {
    operationId: 'return-op-parity-damaged', deviceId: 'parity-device', userName: 'tester',
  });
  await dispatchOperation('return', localDamagedPayload, 1);

  const serverProduct = serverDb.select().from(schema.products).get();
  const localProduct = records.get('products').get(JSON.stringify(1)).record;
  assert.equal(localProduct.stockQuantity, serverProduct.stockQuantity);
  assert.equal(localProduct.stockQuantity, 6);
  assert.equal(serverReturn.result.returnRecord.totalCostReversed, 19);
  const localReturns = [...records.get('returns').values()].map((row) => row.record);
  const localReturn = localReturns.find((row) => row.id === 'parity-return');
  const localDamagedReturn = localReturns.find((row) => row.id === 'parity-return-damaged');
  assert.equal(localReturn.totalCostReversed, serverReturn.result.returnRecord.totalCostReversed);
  assert.equal(localReturn.totalRefund, serverReturn.result.returnRecord.totalRefund);
  assert.equal(localDamagedReturn.totalCostReversed, serverDamagedReturn.result.returnRecord.totalCostReversed);
  assert.equal(localDamagedReturn.totalCostReversed, 5.57);
  assert.equal(serverProduct.stockQuantity, 6, 'damaged return must not re-enter sellable stock');

  const serverOrder = serverDb.select().from(schema.orders).get();
  const localOrder = records.get('orders').get(JSON.stringify('parity-order')).record;
  assert.equal(localOrder.status, serverOrder.status);
  assert.equal(localOrder.status, 'partially_returned');
  assert.equal(localOrder.returnedAmount, serverOrder.returnedAmount);

  const serverBatches = serverDb.select().from(schema.inventoryBatches).all().sort((a, b) => a.id.localeCompare(b.id));
  const localBatches = [...records.get('inventoryBatches').values()].map((row) => row.record).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(localBatches.map((x) => [x.id, x.remainingQuantity, x.costPrice]), serverBatches.map((x) => [x.id, x.remainingQuantity, x.costPrice]));

  const serverAccounts = serverDb.select().from(schema.accounts).all().sort((a, b) => a.code.localeCompare(b.code));
  const localAccounts = [...records.get('accounts').values()].map((row) => row.record).sort((a, b) => a.code.localeCompare(b.code));
  assert.deepEqual(localAccounts.map((x) => [x.code, x.balance]), serverAccounts.map((x) => [x.code, x.balance]));

  const serverEntries = serverDb.select().from(schema.journalEntries).all();
  const localEntries = [...records.get('journalEntries').values()].map((row) => row.record);
  assert.equal(localEntries.length, serverEntries.length);
  for (const serverHeader of serverEntries) {
    const serverLines = serverDb.select().from(schema.transactions).all()
      .filter((x) => x.journalEntryId === serverHeader.id)
      .map((x) => [x.accountId, x.debit, x.credit]).sort((a, b) => a[0].localeCompare(b[0]));
    const localHeader = localEntries.find((x) => x.referenceId === serverHeader.referenceId &&
      x.referenceType === serverHeader.referenceType &&
      x.totalDebit === serverHeader.totalDebit && x.totalCredit === serverHeader.totalCredit &&
      (() => {
        const candidateLines = [...records.get('transactions').values()].map((row) => row.record)
          .filter((line) => line.journalEntryId === x.id)
          .map((line) => [line.accountId, line.debit, line.credit]).sort((a, b) => a[0].localeCompare(b[0]));
        return JSON.stringify(candidateLines) === JSON.stringify(serverLines);
      })());
    assert.ok(localHeader, 'matching local journal header and posting lines');
    assert.equal(localHeader.totalDebit, serverHeader.totalDebit);
    assert.equal(localHeader.totalCredit, serverHeader.totalCredit);
    const localLines = [...records.get('transactions').values()].map((row) => row.record)
      .filter((x) => x.journalEntryId === localHeader.id)
      .map((x) => [x.accountId, x.debit, x.credit]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(localLines, serverLines);
  }

  const serverMovements = serverDb.select().from(schema.inventoryMovements).all().sort((a, b) => a.movementKey.localeCompare(b.movementKey));
  const localMovements = [...records.get('inventoryMovements').values()].map((row) => row.record).sort((a, b) => a.movementKey.localeCompare(b.movementKey));
  assert.deepEqual(
    localMovements.map((x) => [x.movementKey, x.quantityDeltaBase, x.baseUnitCode, x.unitCost, x.totalCost]),
    serverMovements.map((x) => [x.movementKey, x.quantityDeltaBase, x.baseUnitCode, x.unitCost, x.totalCost]),
  );
  // Full purchase -> sale -> sale return -> purchase return parity on the same
  // server database and native SQLite repository used by the sale/return test.
  const purchasedProduct = { ...product, id: 2, name: 'Purchased parity product', costPrice: 10, costInUSD: 5, sellingPrice: 15, stockQuantity: 0 };
  const supplier = { id: 92, name: 'Parity supplier', balance: 0, isSynced: 0, createdAt: now, updatedAt: now };
  const productUpsertPayload = { table: 'products', allowProductPriceUpdate: true, record: purchasedProduct };
  const serverCreatedProduct = executeBusinessOperation(serverDb, 'entity_upsert', productUpsertPayload, {
    operationId: 'product-create-op-parity-2', deviceId: 'parity-device', userName: 'tester',
  });
  await dispatchOperation('entity_upsert', productUpsertPayload, 1);
  assert.equal(serverCreatedProduct.result.id, 2);
  assert.equal(records.get('products').get(JSON.stringify(2)).record.name, purchasedProduct.name);

  serverDb.insert(schema.suppliers).values(supplier).run();
  seed('suppliers', supplier);

  const purchasePayload = {
    operationId: 'purchase-op-parity-2', deviceId: 'parity-device',
    purchase: {
      id: 'parity-purchase-2', supplierId: 92, supplierName: supplier.name,
      totalAmount: 100, paidAmount: 0, paymentMethod: 'cash', currency: 'ر.س',
      exchangeRate: 1, date: now, branchId: 1,
    },
    items: [{
      productId: 2, productName: purchasedProduct.name, quantity: 10, unit: 'piece',
      conversionFactor: 1, costPrice: 10,
    }],
  };
  const serverPurchase = executeBusinessOperation(serverDb, 'purchase', purchasePayload, {
    operationId: purchasePayload.operationId, deviceId: purchasePayload.deviceId, userName: 'tester',
  });
  await dispatchOperation('purchase', purchasePayload, 1);
  assert.equal(serverPurchase.result.items[0].landedCostPerBaseUnit, 10);
  const localCreatedPurchase = records.get('purchases').get(JSON.stringify('parity-purchase-2')).record;
  assert.ok(localCreatedPurchase.updatedAt, 'local purchase must persist an update version for later guarded returns');
  assert.equal(records.get('products').get(JSON.stringify(2)).record.stockQuantity, 10);

  const purchaseSalePayload = {
    operationId: 'purchase-sale-op-parity-2', deviceId: 'parity-device',
    order: {
      id: 'parity-purchase-sale-2', receiptNumber: 'INV-PURCHASE-PARITY',
      totalAmount: 60, taxAmount: 0, netAmount: 60, paidAmount: 60, cashAmount: 60,
      paymentMethod: 'cash', currency: 'ر.س', exchangeRate: 1, branchId: 1,
      createdBy: 'tester', createdAt: now,
    },
    items: [{
      productId: 2, productName: purchasedProduct.name, quantity: 4, unit: 'piece',
      conversionFactor: 1, itemType: 'stock', unitPrice: 15,
      discountAmount: 0, subTotal: 60, taxAmount: 0, total: 60,
    }],
  };
  const serverPurchaseSale = executeBusinessOperation(serverDb, 'sale', purchaseSalePayload, {
    operationId: purchaseSalePayload.operationId, deviceId: purchaseSalePayload.deviceId, userName: 'tester',
  });
  await dispatchOperation('sale', purchaseSalePayload, 1);
  const localPurchaseSaleItem = [...records.get('orderItems').values()].map((row) => row.record)
    .find((row) => String(row.orderId) === 'parity-purchase-sale-2');
  assert.equal(serverPurchaseSale.result.items[0].costPriceAtTimeOfSale, 10);
  assert.equal(localPurchaseSaleItem.costPriceAtTimeOfSale, 10);

  const purchaseSaleReturnPayload = {
    id: 'parity-purchase-sale-return-2', returnNumber: 'RET-PURCHASE-PARITY',
    originalOrderId: 'parity-purchase-sale-2',
    items: [{ orderItemId: serverPurchaseSale.result.items[0].id, productId: 2, quantity: 2, condition: 'resalable' }],
    refundMethod: 'cash', reason: 'purchase parity sale return', returnDate: now,
  };
  const localPurchaseSaleReturnPayload = {
    ...purchaseSaleReturnPayload,
    items: [{ ...purchaseSaleReturnPayload.items[0], orderItemId: localPurchaseSaleItem.id }],
    operationId: 'purchase-sale-return-op-parity-2', deviceId: 'parity-device',
  };
  executeBusinessOperation(serverDb, 'return', purchaseSaleReturnPayload, {
    operationId: 'purchase-sale-return-op-parity-2', deviceId: 'parity-device', userName: 'tester',
  });
  await dispatchOperation('return', localPurchaseSaleReturnPayload, 1);

  // Exercise the same weighted-average and FX anchor rules on both paths
  // specifically during purchase return (the earlier sale/return fixture uses FIFO).
  raw.prepare('UPDATE Setting SET value = ? WHERE key = ?').run('weighted_average', 'inventoryValuationMethod');
  serverDb.insert(schema.settings).values({
    id: 5, key: 'exchangeRate', value: '2', isSynced: 0, createdAt: now, updatedAt: now,
  }).run();
  seed('settings', { id: 2, key: 'inventoryValuationMethod', value: 'weighted_average', isSynced: 0, createdAt: now, updatedAt: now });
  seed('settings', { id: 5, key: 'exchangeRate', value: '2', isSynced: 0, createdAt: now, updatedAt: now });

  const purchaseReturnPayload = {
    id: 'parity-purchase-return-2', returnNumber: 'PR-PARITY',
    originalPurchaseId: 'parity-purchase-2', refundMethod: 'credit_adjustment',
    items: [{ productId: 2, productName: purchasedProduct.name, quantity: 3 }],
    reason: 'purchase parity return',
  };
  const serverPurchaseReturn = executeBusinessOperation(serverDb, 'purchase_return', purchaseReturnPayload, {
    operationId: 'purchase-return-op-parity-2', deviceId: 'parity-device', userName: 'tester',
  });
  await dispatchOperation('purchase_return', {
    ...purchaseReturnPayload, operationId: 'purchase-return-op-parity-2', deviceId: 'parity-device',
  }, 1);

  const serverPurchasedProduct = serverDb.select().from(schema.products).all().find((row) => row.id === 2);
  const localPurchasedProduct = records.get('products').get(JSON.stringify(2)).record;
  assert.equal(serverPurchasedProduct.stockQuantity, 5);
  assert.equal(localPurchasedProduct.stockQuantity, serverPurchasedProduct.stockQuantity);
  assert.equal(serverPurchasedProduct.costInUSD, 5);
  assert.equal(localPurchasedProduct.costInUSD, serverPurchasedProduct.costInUSD,
    'native purchase return must rebase the linked USD cost anchor using the active exchange rate');
  const serverPurchaseRecord = serverDb.select().from(schema.purchases).get();
  const localPurchaseRecord = records.get('purchases').get(JSON.stringify('parity-purchase-2')).record;
  assert.equal(serverPurchaseRecord.returnedAmount, 30);
  assert.equal(localPurchaseRecord.returnedAmount, serverPurchaseRecord.returnedAmount);
  const serverSupplier = serverDb.select().from(schema.suppliers).get();
  const localSupplier = records.get('suppliers').get(JSON.stringify(92)).record;
  assert.equal(serverSupplier.balance, 70);
  assert.equal(localSupplier.balance, serverSupplier.balance);
  const serverPurchaseBatch = serverDb.select().from(schema.inventoryBatches).all().find((row) => row.purchaseId === 'parity-purchase-2');
  const localPurchaseBatch = [...records.get('inventoryBatches').values()].map((row) => row.record)
    .find((row) => row.purchaseId === 'parity-purchase-2');
  assert.equal(serverPurchaseBatch.remainingQuantity, 5);
  assert.equal(localPurchaseBatch.remainingQuantity, serverPurchaseBatch.remainingQuantity);
  assert.equal(serverPurchaseReturn.result.purchaseReturn.totalReturn, 30);

  const { buildOperationalReports } = await import('../src/utils/operationalReports.js');
  const reportStart = new Date('2025-01-01T00:00:00.000Z');
  const reportEnd = new Date('2027-01-01T00:00:00.000Z');
  const serverReport = buildOperationalReports({
    startDate: reportStart, endDate: reportEnd,
    orders: serverDb.select().from(schema.orders).all(),
    returns: serverDb.select().from(schema.returns).all(),
    purchases: serverDb.select().from(schema.purchases).all(),
    purchaseItems: serverDb.select().from(schema.purchaseItems).all(),
    purchaseReturns: serverDb.select().from(schema.purchaseReturns).all(),
    purchaseReturnItems: serverDb.select().from(schema.purchaseReturnItems).all(),
    inventoryMovements: serverDb.select().from(schema.inventoryMovements).all(),
    inventoryBatches: serverDb.select().from(schema.inventoryBatches).all(),
    products: serverDb.select().from(schema.products).all(),
  });
  const localRows = (entity) => [...records.get(entity).values()].map((row) => row.record);
  const localReport = buildOperationalReports({
    startDate: reportStart, endDate: reportEnd,
    orders: localRows('orders'), returns: localRows('returns'),
    purchases: localRows('purchases'), purchaseItems: localRows('purchaseItems'),
    purchaseReturns: localRows('purchaseReturns'), purchaseReturnItems: localRows('purchaseReturnItems'),
    inventoryMovements: localRows('inventoryMovements'), inventoryBatches: localRows('inventoryBatches'),
    products: localRows('products'),
  });
  assert.equal(localReport.sales.gross, serverReport.sales.gross);
  assert.equal(localReport.sales.returns, serverReport.sales.returns);
  assert.equal(localReport.purchases.gross - localReport.purchases.returns, serverReport.purchases.gross - serverReport.purchases.returns);
  assert.equal(localReport.purchaseProducts[0].netQuantity, serverReport.purchaseProducts[0].netQuantity);
  assert.equal(localReport.purchaseProducts[0].netTotal, serverReport.purchaseProducts[0].netTotal);
  assert.equal(localReport.inventoryAging.totalValue, serverReport.inventoryAging.totalValue);
  assert.equal(localReport.inventoryTurnover.cogs, serverReport.inventoryTurnover.cogs);
  assert.equal(localReport.inventoryTurnover.ratio, serverReport.inventoryTurnover.ratio);
  raw.close();
});


test('server purchase, sale and purchase return remain balanced and reject duplicate legacy-stock over-return lines', async () => {
  const { executeBusinessOperation } = await import('../server/operations.ts');
  const { db: serverDb, raw } = createServerDatabase();
  const product = {
    id: 91, name: 'Purchase-sale-return test item', barcode: null, categoryId: null,
    costPrice: 10, sellingPrice: 15, stockQuantity: 0, minStockLevel: 0, unit: 'piece',
    conversionFactor: 1, itemType: 'stock', allowFractions: 0, baseUnitCode: 'piece',
    quantityPrecision: 0, isActive: 1, vatRate: 0, branchId: 1, isSynced: 0,
    updatedAt: now, createdAt: now,
  };
  serverDb.insert(schema.products).values(product).run();
  serverDb.insert(schema.suppliers).values({
    id: 91, name: 'Purchase return supplier', balance: 0, updatedAt: now,
  }).run();
  serverDb.insert(schema.settings).values({
    id: 91, key: 'inventoryValuationMethod', value: 'fifo', isSynced: 0, createdAt: now, updatedAt: now,
  }).run();
  const accountRows = [
    ['1010', 'Cash', 'asset'], ['1020', 'Card', 'asset'], ['1100', 'Receivables', 'asset'],
    ['1200', 'Inventory', 'asset'], ['2100', 'Payables', 'liability'], ['2200', 'VAT', 'liability'],
    ['3100', 'Capital', 'equity'], ['3200', 'Retained earnings', 'equity'],
    ['4100', 'Sales', 'revenue'], ['4200', 'Sales returns', 'revenue'], ['4300', 'Discounts', 'revenue'],
    ['5100', 'COGS', 'expense'], ['5200', 'Expenses', 'expense'], ['5300', 'Payroll', 'expense'],
    ['5400', 'Inventory adjustment', 'expense'],
  ].map(([code, name, type]) => ({ code, name, type, balance: 0, isSystem: 1, createdAt: now, updatedAt: now }));
  serverDb.insert(schema.accounts).values(accountRows).run();

  const purchaseResult = executeBusinessOperation(serverDb, 'purchase', {
    purchase: {
      id: 'legacy-purchase-91', supplierId: 91, supplierName: 'Purchase return supplier',
      totalAmount: 200, paidAmount: 0, paymentMethod: 'cash', currency: 'SDG',
      exchangeRate: 1, date: now, branchId: 1,
    },
    items: [{
      productId: 91, productName: product.name, quantity: 20, unit: 'piece',
      conversionFactor: 1, costPrice: 10,
    }],
  }, { operationId: 'purchase-op-91', deviceId: 'test-device', userName: 'tester' });
  assert.equal(purchaseResult.result.purchase.id, 'legacy-purchase-91');
  assert.equal(purchaseResult.result.items[0].landedCostPerBaseUnit, 10);
  assert.equal(serverDb.select().from(schema.products).get().stockQuantity, 20);
  assert.equal(serverDb.select().from(schema.suppliers).get().balance, 200);

  const saleResult = executeBusinessOperation(serverDb, 'sale', {
    order: {
      id: 'sale-after-purchase-91', receiptNumber: 'SALE-91', totalAmount: 150,
      taxAmount: 0, netAmount: 150, paidAmount: 150, cashAmount: 150,
      paymentMethod: 'cash', currency: 'SDG', exchangeRate: 1, branchId: 1,
      createdBy: 'tester', createdAt: now,
    },
    items: [{
      productId: 91, productName: product.name, quantity: 10, unit: 'piece',
      conversionFactor: 1, itemType: 'stock', unitPrice: 15,
      discountAmount: 0, subTotal: 150, taxAmount: 0, total: 150,
    }],
  }, { operationId: 'sale-after-purchase-op-91', deviceId: 'test-device', userName: 'tester' });
  assert.equal(saleResult.result.items[0].costPriceAtTimeOfSale, 10);
  assert.equal(serverDb.select().from(schema.products).get().stockQuantity, 10);

  // Simulate an older installation with valid remaining stock but no batch layers.
  // This exercises the fallback path where repeated lines must share one stock reservation.
  raw.exec('DELETE FROM InventoryBatch');
  const duplicatePayload = {
    id: 'duplicate-purchase-return-91', returnNumber: 'PR-91-DUP',
    originalPurchaseId: 'legacy-purchase-91', refundMethod: 'credit_adjustment',
    items: [
      { productId: 91, productName: product.name, quantity: 6, costPrice: 10 },
      { productId: 91, productName: product.name, quantity: 6, costPrice: 10 },
    ],
  };
  assert.throws(() => executeBusinessOperation(serverDb, 'purchase_return', duplicatePayload, {
    operationId: 'purchase-return-op-duplicate-91', deviceId: 'test-device', userName: 'tester',
  }), /المخزون المتاح لا يكفي/);
  assert.equal(serverDb.select().from(schema.products).get().stockQuantity, 10);
  assert.equal(serverDb.select().from(schema.purchases).get().returnedAmount, 0);
  assert.equal(serverDb.select().from(schema.purchaseReturns).all().length, 0);
  assert.equal(serverDb.select().from(schema.purchaseReturnItems).all().length, 0);

  const validResult = executeBusinessOperation(serverDb, 'purchase_return', {
    id: 'valid-purchase-return-91', returnNumber: 'PR-91-OK',
    originalPurchaseId: 'legacy-purchase-91', refundMethod: 'credit_adjustment',
    items: [{ productId: 91, productName: product.name, quantity: 10, costPrice: 10 }],
  }, {
    operationId: 'purchase-return-op-valid-91', deviceId: 'test-device', userName: 'tester',
  });
  assert.equal(validResult.result.purchaseReturn.totalReturn, 100);
  assert.equal(serverDb.select().from(schema.products).get().stockQuantity, 0);
  assert.equal(serverDb.select().from(schema.purchases).get().returnedAmount, 100);
  assert.equal(serverDb.select().from(schema.suppliers).get().balance, 100);
  const purchaseReturnEntry = serverDb.select().from(schema.journalEntries).all()
    .find((entry) => entry.referenceType === 'purchase_return');
  assert.ok(purchaseReturnEntry);
  assert.equal(purchaseReturnEntry.totalDebit, purchaseReturnEntry.totalCredit);
  const movementTypes = serverDb.select().from(schema.inventoryMovements).all().map((row) => row.movementType);
  assert.ok(movementTypes.includes('purchase_receipt'));
  assert.ok(movementTypes.includes('sale'));
  assert.ok(movementTypes.includes('purchase_return'));
  raw.close();
});

test('native SQLite rejects a service-with-materials sale when its recipe is missing, matching server validation', async () => {
  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.navigator = { onLine: true, userAgent: 'node-test' };
  const localStorageShim = { getItem() { return null; }, setItem() {} };
  globalThis.localStorage = localStorageShim;
  globalThis.window = {
    location: { hostname: 'localhost', protocol: 'http:', port: '3000', origin: 'http://localhost:3000' },
    navigator: globalThis.navigator,
    localStorage: localStorageShim,
    addEventListener() {},
    removeEventListener() {},
    electronAPI: { isElectron: true, posLocalDatabase: bridge },
    dispatchEvent() { return true; },
  };

  const [{ setElectronDeviceRole }, { dispatchOperation }] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/operationService.ts'),
  ]);
  setElectronDeviceRole('client');
  seed('products', {
    id: 51, name: 'Unconfigured service', barcode: null, categoryId: null,
    costPrice: 0, sellingPrice: 100, stockQuantity: 0, minStockLevel: 0,
    unit: 'piece', conversionFactor: 1, itemType: 'service_with_materials',
    allowFractions: 0, baseUnitCode: 'piece', quantityPrecision: 0,
    isActive: 1, vatRate: 0, branchId: 1, isSynced: 0, updatedAt: now, createdAt: now,
  });

  const payload = {
    operationId: 'missing-service-recipe-op',
    deviceId: 'service-recipe-device',
    order: {
      id: 'missing-service-recipe-order', receiptNumber: 'INV-SERVICE-MISSING',
      totalAmount: 100, taxAmount: 0, netAmount: 100, paymentMethod: 'cash',
      currency: 'SDG', exchangeRate: 1, branchId: 1, createdBy: 'tester', createdAt: now,
    },
    items: [{
      productId: 51, productName: 'Unconfigured service', quantity: 1,
      unit: 'piece', conversionFactor: 1, itemType: 'service_with_materials',
      unitPrice: 100, discountAmount: 0, subTotal: 100, taxAmount: 0, total: 100,
    }],
  };

  await assert.rejects(
    () => dispatchOperation('sale', payload, 1),
    /تحتاج إلى وصفة مواد خام قبل بيعها/,
  );
  assert.equal(records.get('orders')?.size || 0, 0, 'rejected service sale must not create an order');
  assert.equal(records.get('inventoryMovements')?.size || 0, 0, 'rejected service sale must not consume stock');
});


test('service recipes and bundles consume identical FIFO materials and preserve sale cost snapshots in server and native SQLite', async () => {
  const { executeBusinessOperation } = await import('../server/operations.ts');
  const { db: serverDb, raw } = createServerDatabase();
  raw.exec(`
    CREATE TABLE ServiceRecipe (
      id TEXT PRIMARY KEY, parentProductId INTEGER NOT NULL, ingredientProductId INTEGER NOT NULL,
      ingredientName TEXT, quantity REAL NOT NULL, unit TEXT, isSynced INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT NOT NULL
    );
  `);
  const accountRows = [
    ['1010', 'Cash', 'asset'], ['1020', 'Card', 'asset'], ['1100', 'Receivables', 'asset'],
    ['1200', 'Inventory', 'asset'], ['2100', 'Payables', 'liability'], ['2200', 'VAT', 'liability'],
    ['3100', 'Capital', 'equity'], ['3200', 'Retained earnings', 'equity'],
    ['4100', 'Sales', 'revenue'], ['4200', 'Sales returns', 'revenue'], ['4300', 'Discounts', 'revenue'],
    ['5100', 'COGS', 'expense'], ['5200', 'Expenses', 'expense'], ['5300', 'Payroll', 'expense'],
    ['5400', 'Inventory adjustment', 'expense'],
  ].map(([code, name, type]) => ({ code, name, type, balance: 0, isSystem: 1, createdAt: now, updatedAt: now }));
  serverDb.insert(schema.accounts).values(accountRows).run();

  const products = [
    { id: 61, name: 'Recipe service', itemType: 'service_with_materials', stockQuantity: 0, costPrice: 0, sellingPrice: 30 },
    { id: 62, name: 'Recipe bundle', itemType: 'bundle', stockQuantity: 0, costPrice: 0, sellingPrice: 30 },
    { id: 63, name: 'Stock bundle', itemType: 'bundle', stockQuantity: 5, costPrice: 7, sellingPrice: 20 },
    { id: 64, name: 'Recipe ingredient', itemType: 'stock', stockQuantity: 10, costPrice: 2.6, sellingPrice: 5 },
  ].map((product) => ({
    ...product, barcode: null, categoryId: null, minStockLevel: 0, unit: 'piece',
    conversionFactor: 1, allowFractions: 0, baseUnitCode: 'piece', quantityPrecision: 0,
    isActive: 1, vatRate: 0, branchId: 1, isSynced: 0, updatedAt: now, createdAt: now,
  }));
  serverDb.insert(schema.products).values(products).run();

  const batches = [
    { id: 'recipe-ing-a', productId: 64, quantity: 4, remainingQuantity: 4, costPrice: 2, purchaseDate: now },
    { id: 'recipe-ing-b', productId: 64, quantity: 6, remainingQuantity: 6, costPrice: 3, purchaseDate: now },
    { id: 'stock-bundle-batch', productId: 63, quantity: 5, remainingQuantity: 5, costPrice: 7, purchaseDate: now },
  ].map((batch) => ({
    ...batch, purchaseId: null, currency: 'SDG', exchangeRate: 1, expiryDate: null,
    batchNumber: null, branchId: 1, isSynced: 0, createdAt: now, updatedAt: now,
  }));
  serverDb.insert(schema.inventoryBatches).values(batches).run();

  const recipes = [
    { id: 'recipe-service-61', parentProductId: 61, ingredientProductId: 64, ingredientName: 'Recipe ingredient', quantity: 2, unit: 'piece', isSynced: 0, createdAt: now, updatedAt: now },
    { id: 'recipe-bundle-62', parentProductId: 62, ingredientProductId: 64, ingredientName: 'Recipe ingredient', quantity: 2, unit: 'piece', isSynced: 0, createdAt: now, updatedAt: now },
  ];
  for (const recipe of recipes) {
    raw.prepare('INSERT INTO ServiceRecipe (id,parentProductId,ingredientProductId,ingredientName,quantity,unit,isSynced,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(recipe.id, recipe.parentProductId, recipe.ingredientProductId, recipe.ingredientName, recipe.quantity, recipe.unit, recipe.isSynced, recipe.createdAt, recipe.updatedAt);
  }

  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.navigator = { onLine: true, userAgent: 'node-test' };
  const localStorageShim = { getItem() { return null; }, setItem() {} };
  globalThis.localStorage = localStorageShim;
  globalThis.window = {
    location: { hostname: 'localhost', protocol: 'http:', port: '3000', origin: 'http://localhost:3000' },
    navigator: globalThis.navigator, localStorage: localStorageShim,
    addEventListener() {}, removeEventListener() {},
    electronAPI: { isElectron: true, posLocalDatabase: bridge },
    dispatchEvent() { return true; },
  };
  const [{ setElectronDeviceRole }, { dispatchOperation }] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/operationService.ts'),
  ]);
  setElectronDeviceRole('client');
  for (const product of products) seed('products', product);
  for (const batch of batches) seed('inventoryBatches', batch);
  for (const recipe of recipes) seed('serviceRecipes', recipe);

  const payload = {
    operationId: 'recipe-bundle-fifo-parity-op', deviceId: 'recipe-parity-device',
    order: {
      id: 'recipe-bundle-fifo-parity-order', receiptNumber: 'INV-RECIPE-PARITY',
      totalAmount: 80, taxAmount: 0, netAmount: 80, paymentMethod: 'cash',
      currency: 'SDG', exchangeRate: 1, branchId: 1, createdBy: 'tester', createdAt: now,
    },
    items: [
      { productId: 61, productName: 'Recipe service', quantity: 1, unit: 'piece', conversionFactor: 1, itemType: 'service_with_materials', unitPrice: 30, discountAmount: 0, subTotal: 30, taxAmount: 0, total: 30 },
      { productId: 62, productName: 'Recipe bundle', quantity: 1, unit: 'piece', conversionFactor: 1, itemType: 'bundle', unitPrice: 30, discountAmount: 0, subTotal: 30, taxAmount: 0, total: 30 },
      { productId: 63, productName: 'Stock bundle', quantity: 1, unit: 'piece', conversionFactor: 1, itemType: 'bundle', unitPrice: 20, discountAmount: 0, subTotal: 20, taxAmount: 0, total: 20 },
    ],
  };
  const serverResult = executeBusinessOperation(serverDb, 'sale', payload, {
    operationId: payload.operationId, deviceId: payload.deviceId, userName: 'tester', userRole: 'admin',
  });
  await dispatchOperation('sale', payload, 1);

  const serverItems = serverResult.result.items;
  const localItems = [...records.get('orderItems').values()].map((row) => row.record)
    .filter((row) => String(row.orderId) === payload.order.id)
    .sort((a, b) => Number(a.productId) - Number(b.productId));
  const expectedCosts = new Map([[61, 4], [62, 4], [63, 7]]);
  for (const serverItem of serverItems) {
    const localItem = localItems.find((row) => Number(row.productId) === Number(serverItem.productId));
    assert.ok(localItem, 'native SQLite must persist each sale line');
    assert.equal(Number(serverItem.costPriceAtTimeOfSale), expectedCosts.get(Number(serverItem.productId)));
    assert.equal(Number(localItem.costPriceAtTimeOfSale), Number(serverItem.costPriceAtTimeOfSale));
  }

  const serverIngredient = serverDb.select().from(schema.products).all().find((row) => row.id === 64);
  const localIngredient = records.get('products').get(JSON.stringify(64)).record;
  assert.equal(serverIngredient.stockQuantity, 6);
  assert.equal(localIngredient.stockQuantity, serverIngredient.stockQuantity);
  const serverStockBundle = serverDb.select().from(schema.products).all().find((row) => row.id === 63);
  const localStockBundle = records.get('products').get(JSON.stringify(63)).record;
  assert.equal(localStockBundle.stockQuantity, serverStockBundle.stockQuantity);
  assert.equal(serverStockBundle.stockQuantity, 4);

  const serverBatches = serverDb.select().from(schema.inventoryBatches).all().sort((a, b) => a.id.localeCompare(b.id));
  const localBatches = [...records.get('inventoryBatches').values()].map((row) => row.record)
    .filter((row) => ['recipe-ing-a', 'recipe-ing-b', 'stock-bundle-batch'].includes(row.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(localBatches.map((row) => [row.id, row.remainingQuantity]), serverBatches.map((row) => [row.id, row.remainingQuantity]));
  const serverMovements = serverDb.select().from(schema.inventoryMovements).all()
    .map((row) => [row.productId, row.quantityDeltaBase, row.totalCost]).sort((a, b) => Number(a[0]) - Number(b[0]));
  const localMovements = [...records.get('inventoryMovements').values()].map((row) => row.record)
    .filter((row) => String(row.sourceId) === payload.order.id)
    .map((row) => [row.productId, row.quantityDeltaBase, row.totalCost]).sort((a, b) => Number(a[0]) - Number(b[0]));
  assert.deepEqual(localMovements, serverMovements);
  const serverCogs = serverItems.reduce((sum, row) => sum + Number(row.costPriceAtTimeOfSale) * Number(row.quantity), 0);
  const localCogs = localItems.reduce((sum, row) => sum + Number(row.costPriceAtTimeOfSale) * Number(row.quantity), 0);
  assert.equal(serverCogs, 15);
  assert.equal(localCogs, serverCogs);
  raw.close();
});


test('native SQLite stocktake increase and weighted-average decrease match server valuation and journals', async () => {
  const { executeBusinessOperation } = await import('../server/operations.ts');
  const { db: serverDb, raw } = createServerDatabase();
  raw.exec(`
    CREATE TABLE StocktakingSession (
      id TEXT PRIMARY KEY, status TEXT DEFAULT 'open', createdAt TEXT, createdBy TEXT,
      branchId INTEGER, isSynced INTEGER DEFAULT 0
    );
    CREATE TABLE StocktakingEntry (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, productId INTEGER NOT NULL,
      productName TEXT NOT NULL, barcode TEXT, systemQuantity REAL NOT NULL,
      actualQuantity REAL NOT NULL, scannedBy TEXT, scannedAt TEXT, isSynced INTEGER DEFAULT 0
    );
  `);
  const accountRows = [
    ['1010', 'Cash', 'asset'], ['1020', 'Card', 'asset'], ['1100', 'Receivables', 'asset'],
    ['1200', 'Inventory', 'asset'], ['2100', 'Payables', 'liability'], ['2200', 'VAT', 'liability'],
    ['3100', 'Capital', 'equity'], ['3200', 'Retained earnings', 'equity'],
    ['4100', 'Sales', 'revenue'], ['4200', 'Sales returns', 'revenue'], ['4300', 'Discounts', 'revenue'],
    ['5100', 'COGS', 'expense'], ['5200', 'Expenses', 'expense'], ['5300', 'Payroll', 'expense'],
    ['5400', 'Inventory adjustment', 'expense'],
  ].map(([code, name, type]) => ({ code, name, type, balance: 0, isSystem: 1, createdAt: now, updatedAt: now }));
  serverDb.insert(schema.accounts).values(accountRows).run();

  const products = [
    { id: 71, name: 'Stocktake increase item', costPrice: 4, stockQuantity: 5 },
    { id: 72, name: 'Stocktake decrease item', costPrice: 3.2, stockQuantity: 10 },
  ].map((product) => ({
    ...product, barcode: null, categoryId: null, sellingPrice: 6, minStockLevel: 0,
    unit: 'piece', conversionFactor: 1, itemType: 'stock', allowFractions: 0,
    baseUnitCode: 'piece', quantityPrecision: 0, isActive: 1, vatRate: 0,
    branchId: 1, isSynced: 0, updatedAt: now, createdAt: now,
  }));
  serverDb.insert(schema.products).values(products).run();
  const batches = [
    { id: 'stocktake-decrease-a', productId: 72, quantity: 4, remainingQuantity: 4, costPrice: 2, purchaseDate: now },
    { id: 'stocktake-decrease-b', productId: 72, quantity: 6, remainingQuantity: 6, costPrice: 4, purchaseDate: now },
  ].map((batch) => ({
    ...batch, purchaseId: null, currency: 'SDG', exchangeRate: 1, expiryDate: null,
    batchNumber: null, branchId: 1, isSynced: 0, createdAt: now, updatedAt: now,
  }));
  serverDb.insert(schema.inventoryBatches).values(batches).run();
  serverDb.insert(schema.settings).values({
    id: 71, key: 'inventoryValuationMethod', value: 'weighted_average',
    isSynced: 0, createdAt: now, updatedAt: now,
  }).run();
  const session = { id: 'stocktake-weighted-parity', status: 'open', createdAt: now, createdBy: 'tester', branchId: 1, isSynced: 0 };
  const entries = [
    { id: 'stocktake-entry-increase', sessionId: session.id, productId: 71, productName: products[0].name, systemQuantity: 5, actualQuantity: 9, scannedBy: 'tester', scannedAt: now, isSynced: 0 },
    { id: 'stocktake-entry-decrease', sessionId: session.id, productId: 72, productName: products[1].name, systemQuantity: 10, actualQuantity: 6, scannedBy: 'tester', scannedAt: now, isSynced: 0 },
  ];
  serverDb.insert(schema.stocktakingSessions).values(session).run();
  serverDb.insert(schema.stocktakingEntries).values(entries).run();

  const { bridge, seed, records } = createMemoryElectronBridge();
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.navigator = { onLine: true, userAgent: 'node-test' };
  const localStorageShim = { getItem() { return null; }, setItem() {} };
  globalThis.localStorage = localStorageShim;
  globalThis.window = {
    location: { hostname: 'localhost', protocol: 'http:', port: '3000', origin: 'http://localhost:3000' },
    navigator: globalThis.navigator, localStorage: localStorageShim,
    addEventListener() {}, removeEventListener() {},
    electronAPI: { isElectron: true, posLocalDatabase: bridge },
    dispatchEvent() { return true; },
  };
  const [{ setElectronDeviceRole }, { dispatchOperation }] = await Promise.all([
    import('../src/native/electronPosRepository.ts'),
    import('../src/services/operationService.ts'),
  ]);
  setElectronDeviceRole('client');
  for (const product of products) seed('products', product);
  for (const batch of batches) seed('inventoryBatches', batch);
  seed('settings', { id: 71, key: 'inventoryValuationMethod', value: 'weighted_average', createdAt: now, updatedAt: now });
  seed('stocktakingSessions', session);
  for (const entry of entries) seed('stocktakingEntries', entry);

  const payload = {
    sessionId: session.id, operationId: 'stocktake-weighted-parity-op',
    deviceId: 'stocktake-parity-device', createdBy: 'tester',
  };
  executeBusinessOperation(serverDb, 'stocktake_approve', payload, {
    operationId: payload.operationId, deviceId: payload.deviceId, userName: 'tester', userRole: 'admin',
  });
  await dispatchOperation('stocktake_approve', payload, 1);

  const serverProducts = serverDb.select().from(schema.products).all().sort((a, b) => a.id - b.id);
  const localProducts = [...records.get('products').values()].map((row) => row.record).sort((a, b) => a.id - b.id);
  assert.deepEqual(localProducts.map((row) => [row.id, row.stockQuantity, row.costPrice]),
    serverProducts.map((row) => [row.id, row.stockQuantity, row.costPrice]));
  assert.deepEqual(localProducts.map((row) => [row.id, row.stockQuantity]), [[71, 9], [72, 6]]);

  const serverBatches = serverDb.select().from(schema.inventoryBatches).all()
    .filter((row) => row.productId === 72).sort((a, b) => a.id.localeCompare(b.id));
  const localBatches = [...records.get('inventoryBatches').values()].map((row) => row.record)
    .filter((row) => row.productId === 72).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(localBatches.map((row) => [row.id, row.remainingQuantity, row.costPrice]),
    serverBatches.map((row) => [row.id, row.remainingQuantity, row.costPrice]));
  assert.deepEqual(localBatches.map((row) => [row.remainingQuantity, row.costPrice]), [[0, 3.2], [6, 3.2]]);

  const serverMovements = serverDb.select().from(schema.inventoryMovements).all()
    .map((row) => [row.productId, row.movementType, row.quantityDeltaBase, row.unitCost, row.totalCost])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const localMovements = [...records.get('inventoryMovements').values()].map((row) => row.record)
    .filter((row) => row.sourceId === session.id)
    .map((row) => [row.productId, row.movementType, row.quantityDeltaBase, row.unitCost, row.totalCost])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  assert.deepEqual(localMovements, serverMovements);
  assert.equal(serverMovements.find((row) => row[0] === 71)[4], 16);
  assert.equal(serverMovements.find((row) => row[0] === 72)[4], 12.8);

  const serverJournal = serverDb.select().from(schema.journalEntries).all()
    .find((row) => row.referenceType === 'stocktake' && row.referenceId === session.id);
  const localJournal = [...records.get('journalEntries').values()].map((row) => row.record)
    .find((row) => row.referenceType === 'stocktake' && row.referenceId === session.id);
  assert.ok(serverJournal && localJournal);
  assert.equal(serverJournal.totalDebit, 3.2);
  assert.equal(serverJournal.totalCredit, 3.2);
  assert.equal(localJournal.totalDebit, serverJournal.totalDebit);
  assert.equal(localJournal.totalCredit, serverJournal.totalCredit);
  assert.equal(records.get('stocktakingSessions').get(JSON.stringify(session.id)).record.status, 'approved');
  raw.close();
});
