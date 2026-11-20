import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../drizzle/schema.ts';

const now = '2026-11-20T12:00:00.000Z';
const primaryKeys = {
  products: 'id', inventoryBatches: 'id', inventoryMovements: 'id', settings: 'id',
  accounts: 'code', journalEntries: 'id', transactions: 'id',
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

  const serverProduct = serverDb.select().from(schema.products).get();
  const localProduct = records.get('products').get(JSON.stringify(1)).record;
  assert.equal(localProduct.stockQuantity, serverProduct.stockQuantity);
  assert.equal(localProduct.stockQuantity, 6);
  assert.equal(serverReturn.result.returnRecord.totalCostReversed, 19);
  const localReturn = [...records.get('returns').values()].map((row) => row.record)[0];
  assert.equal(localReturn.totalCostReversed, serverReturn.result.returnRecord.totalCostReversed);
  assert.equal(localReturn.totalRefund, serverReturn.result.returnRecord.totalRefund);

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
  raw.close();
});
