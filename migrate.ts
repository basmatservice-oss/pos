import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Determine the best path for the database
export const getDbPath = () => {
  if (process.env.POS_DB_PATH) {
    const dir = path.dirname(process.env.POS_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return process.env.POS_DB_PATH;
  }

  // In AI Studio or Linux, always use the project root for simplicity
  if (process.platform !== 'win32') {
    return path.join(process.cwd(), 'dev.db');
  }

  if (process.env.NODE_ENV === 'production') {
    const appDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Smart POS Studio');
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true });
    }
    return path.join(appDataDir, 'dev.db');
  }
  return path.join(process.cwd(), 'dev.db');
};

function ensureColumn(sqlite: Database.Database, table: string, column: string, definition: string) {
  const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

export function ensureSchemaUpgrades(sqlite: Database.Database) {
  // 1. Ensure newly added tables exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "ServiceRecipe" (
      "id" text PRIMARY KEY NOT NULL,
      "parentProductId" integer NOT NULL,
      "ingredientProductId" integer NOT NULL,
      "ingredientName" text,
      "quantity" real NOT NULL,
      "unit" text DEFAULT 'piece',
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "InventoryBatch" (
      "id" text PRIMARY KEY NOT NULL,
      "productId" integer NOT NULL,
      "purchaseId" text,
      "quantity" real NOT NULL,
      "remainingQuantity" real NOT NULL,
      "costPrice" real NOT NULL,
      "currency" text,
      "exchangeRate" real DEFAULT 1,
      "purchaseDate" text NOT NULL,
      "expiryDate" text,
      "batchNumber" text,
      "branchId" integer,
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "Return" (
      "id" text PRIMARY KEY NOT NULL,
      "returnNumber" text NOT NULL,
      "originalOrderId" text NOT NULL,
      "originalReceiptNumber" text,
      "customerId" integer,
      "customerName" text,
      "branchId" integer,
      "shiftId" text,
      "refundMethod" text NOT NULL,
      "currency" text,
      "exchangeRate" real DEFAULT 1,
      "subTotal" real DEFAULT 0,
      "discountAmount" real DEFAULT 0,
      "taxAmount" real DEFAULT 0,
      "totalRefund" real NOT NULL,
      "totalCostReversed" real DEFAULT 0,
      "reason" text,
      "createdBy" text,
      "deviceId" text,
      "operationId" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "ReturnItem" (
      "id" text PRIMARY KEY NOT NULL,
      "returnId" text NOT NULL,
      "orderItemId" integer,
      "productId" integer NOT NULL,
      "productName" text NOT NULL,
      "quantity" real NOT NULL,
      "condition" text DEFAULT 'resalable',
      "unitPrice" real NOT NULL,
      "costPrice" real DEFAULT 0,
      "taxAmount" real DEFAULT 0,
      "total" real NOT NULL,
      "batchAllocations" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "Account" (
      "code" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "type" text NOT NULL,
      "parentCode" text,
      "balance" real DEFAULT 0,
      "isSystem" integer DEFAULT 1,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "ProcessedOperation" (
      "operationId" text PRIMARY KEY NOT NULL,
      "deviceId" text,
      "operationType" text NOT NULL,
      "status" text DEFAULT 'completed',
      "resultJson" text,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "InventoryAlert" (
      "id" text PRIMARY KEY NOT NULL,
      "productId" integer NOT NULL,
      "productName" text NOT NULL,
      "previousQty" real NOT NULL,
      "changeQty" real NOT NULL,
      "resultingQty" real NOT NULL,
      "operationId" text,
      "deviceId" text,
      "reason" text NOT NULL,
      "resolved" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "ShiftMovement" (
      "id" text PRIMARY KEY NOT NULL,
      "shiftId" text NOT NULL,
      "type" text NOT NULL,
      "amount" real NOT NULL,
      "reason" text,
      "createdBy" text,
      "branchId" integer,
      "operationId" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "PurchaseReturn" (
      "id" text PRIMARY KEY NOT NULL,
      "returnNumber" text NOT NULL,
      "originalPurchaseId" text NOT NULL,
      "supplierId" integer,
      "supplierName" text,
      "branchId" integer,
      "shiftId" text,
      "refundMethod" text NOT NULL,
      "currency" text,
      "exchangeRate" real DEFAULT 1,
      "totalReturn" real NOT NULL,
      "reason" text,
      "createdBy" text,
      "deviceId" text,
      "operationId" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "PurchaseReturnItem" (
      "id" text PRIMARY KEY NOT NULL,
      "purchaseReturnId" text NOT NULL,
      "productId" integer NOT NULL,
      "productName" text NOT NULL,
      "quantity" real NOT NULL,
      "costPrice" real NOT NULL,
      "total" real NOT NULL,
      "batchId" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "CustomerPayment" (
      "id" text PRIMARY KEY NOT NULL,
      "customerId" integer NOT NULL,
      "customerName" text,
      "orderId" text,
      "amount" real NOT NULL,
      "paymentMethod" text NOT NULL,
      "notes" text,
      "shiftId" text,
      "branchId" integer,
      "createdBy" text,
      "operationId" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "SupplierPayment" (
      "id" text PRIMARY KEY NOT NULL,
      "supplierId" integer NOT NULL,
      "supplierName" text,
      "purchaseId" text,
      "amount" real NOT NULL,
      "paymentMethod" text NOT NULL,
      "notes" text,
      "shiftId" text,
      "branchId" integer,
      "createdBy" text,
      "operationId" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "ExchangeRateHistory" (
      "id" text PRIMARY KEY NOT NULL,
      "currency" text NOT NULL,
      "rate" real NOT NULL,
      "source" text DEFAULT 'manual',
      "effectiveFrom" text NOT NULL,
      "notes" text,
      "createdBy" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );

    CREATE TABLE IF NOT EXISTS "FiscalPeriod" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "startDate" text NOT NULL,
      "endDate" text NOT NULL,
      "status" text DEFAULT 'open',
      "closedAt" text,
      "closedBy" text,
      "notes" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "UnitDefinition" (
      "code" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "symbol" text,
      "dimension" text NOT NULL,
      "decimalPlaces" integer DEFAULT 0,
      "isFractional" integer DEFAULT 0,
      "isSystem" integer DEFAULT 0,
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "ProductUnit" (
      "id" text PRIMARY KEY NOT NULL,
      "productId" integer NOT NULL,
      "unitCode" text NOT NULL,
      "conversionToBase" real NOT NULL,
      "isBaseUnit" integer DEFAULT 0,
      "sellingPrice" real,
      "barcode" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text,
      "updatedAt" text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "InventoryMovement" (
      "id" text PRIMARY KEY NOT NULL,
      "movementKey" text UNIQUE NOT NULL,
      "productId" integer NOT NULL,
      "movementType" text NOT NULL,
      "sourceType" text NOT NULL,
      "sourceId" text NOT NULL,
      "quantityDeltaBase" real NOT NULL,
      "baseUnitCode" text,
      "unitCost" real DEFAULT 0,
      "totalCost" real DEFAULT 0,
      "branchId" integer,
      "operationId" text,
      "reason" text,
      "createdBy" text,
      "isSynced" integer DEFAULT 0,
      "createdAt" text
    );
  `);

  // 2. Ensure new columns on existing tables
  ensureColumn(sqlite, 'Product', 'costInUSD', 'real');
  ensureColumn(sqlite, 'Product', 'priceInUSD', 'real');
  ensureColumn(sqlite, 'Product', 'minStockLevel', 'real DEFAULT 5');
  ensureColumn(sqlite, 'Product', 'unit', "text DEFAULT 'piece'");
  ensureColumn(sqlite, 'Product', 'conversionFactor', 'real DEFAULT 1');
  ensureColumn(sqlite, 'Product', 'itemType', "text DEFAULT 'stock'");
  ensureColumn(sqlite, 'Product', 'allowFractions', 'integer DEFAULT 0');
  ensureColumn(sqlite, 'Product', 'unitsJson', 'text');
  ensureColumn(sqlite, 'Product', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'Product', 'quantityPrecision', 'integer DEFAULT 0');
  ensureColumn(sqlite, 'Product', 'isActive', 'integer DEFAULT 1');
  ensureColumn(sqlite, 'Product', 'expiryDate', 'text');
  ensureColumn(sqlite, 'Product', 'batchNumber', 'text');

  ensureColumn(sqlite, 'InventoryBatch', 'currency', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'exchangeRate', 'real DEFAULT 1');
  ensureColumn(sqlite, 'InventoryBatch', 'unitCode', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'conversionToBase', 'real DEFAULT 1');
  ensureColumn(sqlite, 'InventoryBatch', 'baseQuantity', 'real');

  ensureColumn(sqlite, 'Order', 'paidAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'cashAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'cardAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'returnedAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'currency', 'text');
  ensureColumn(sqlite, 'Order', 'exchangeRate', 'real DEFAULT 1');
  ensureColumn(sqlite, 'Order', 'shiftId', 'text');
  ensureColumn(sqlite, 'Order', 'deviceId', 'text');
  ensureColumn(sqlite, 'Order', 'operationId', 'text');

  ensureColumn(sqlite, 'OrderItem', 'returnedQuantity', 'real DEFAULT 0');
  ensureColumn(sqlite, 'OrderItem', 'unit', "text DEFAULT 'piece'");
  ensureColumn(sqlite, 'OrderItem', 'conversionFactor', 'real DEFAULT 1');
  ensureColumn(sqlite, 'OrderItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'OrderItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'OrderItem', 'conversionToBase', 'real DEFAULT 1');
  ensureColumn(sqlite, 'OrderItem', 'baseQuantity', 'real');
  ensureColumn(sqlite, 'OrderItem', 'itemType', "text DEFAULT 'stock'");
  ensureColumn(sqlite, 'OrderItem', 'costPriceAtTimeOfSale', 'real DEFAULT 0');
  ensureColumn(sqlite, 'OrderItem', 'discountAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'OrderItem', 'batchAllocations', 'text');

  ensureColumn(sqlite, 'Return', 'currency', 'text');
  ensureColumn(sqlite, 'Return', 'exchangeRate', 'real DEFAULT 1');
  ensureColumn(sqlite, 'ReturnItem', 'condition', "text DEFAULT 'resalable'");
  ensureColumn(sqlite, 'ReturnItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'ReturnItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'ReturnItem', 'conversionToBase', 'real DEFAULT 1');
  ensureColumn(sqlite, 'ReturnItem', 'baseQuantity', 'real');

  ensureColumn(sqlite, 'Employee', 'mustChangePassword', 'integer DEFAULT 0');
  ensureColumn(sqlite, 'Employee', 'salaryType', "text DEFAULT 'monthly'");

  ensureColumn(sqlite, 'Expense', 'paymentMethod', "text DEFAULT 'cash'");
  ensureColumn(sqlite, 'Expense', 'shiftId', 'text');

  ensureColumn(sqlite, 'Payroll', 'salaryType', "text DEFAULT 'monthly'");
  ensureColumn(sqlite, 'Payroll', 'paymentMethod', "text DEFAULT 'cash'");
  ensureColumn(sqlite, 'Payroll', 'branchId', 'integer');

  ensureColumn(sqlite, 'Offer', 'value', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Offer', 'isActive', 'integer DEFAULT 1');
  ensureColumn(sqlite, 'Offer', 'applicableProducts', 'text');
  ensureColumn(sqlite, 'Offer', 'minPurchaseAmount', 'real DEFAULT 0');

  ensureColumn(sqlite, 'Branch', 'email', 'text');
  ensureColumn(sqlite, 'Branch', 'isActive', 'integer DEFAULT 1');

  ensureColumn(sqlite, 'Purchase', 'paymentMethod', "text DEFAULT 'cash'");
  ensureColumn(sqlite, 'Purchase', 'returnedAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Purchase', 'currency', 'text');
  ensureColumn(sqlite, 'Purchase', 'currencyCode', 'text');
  ensureColumn(sqlite, 'Purchase', 'baseCurrencyCode', 'text');
  ensureColumn(sqlite, 'Purchase', 'originalTotalAmount', 'real');
  ensureColumn(sqlite, 'Purchase', 'originalPaidAmount', 'real');
  ensureColumn(sqlite, 'Purchase', 'exchangeRate', 'real DEFAULT 1');
  ensureColumn(sqlite, 'Purchase', 'shippingCost', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Purchase', 'customsCost', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Purchase', 'otherCosts', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Purchase', 'deviceId', 'text');
  ensureColumn(sqlite, 'Purchase', 'operationId', 'text');

  ensureColumn(sqlite, 'PurchaseItem', 'unit', "text DEFAULT 'piece'");
  ensureColumn(sqlite, 'PurchaseItem', 'conversionFactor', 'real DEFAULT 1');
  ensureColumn(sqlite, 'PurchaseItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'conversionToBase', 'real DEFAULT 1');
  ensureColumn(sqlite, 'PurchaseItem', 'baseQuantity', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'originalTotal', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'landedCostPerBaseUnit', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'expiryDate', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'batchNumber', 'text');

  ensureColumn(sqlite, 'PurchaseReturn', 'currency', 'text');
  ensureColumn(sqlite, 'PurchaseReturn', 'exchangeRate', 'real DEFAULT 1');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'conversionToBase', 'real DEFAULT 1');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'baseQuantity', 'real');

  ensureColumn(sqlite, 'StocktakingEntry', 'unitCode', 'text');
  ensureColumn(sqlite, 'StocktakingEntry', 'baseUnitCode', 'text');

  ensureColumn(sqlite, 'AuditLog', 'operationName', 'text');
  ensureColumn(sqlite, 'AuditLog', 'productName', 'text');
  ensureColumn(sqlite, 'AuditLog', 'unitCode', 'text');
  ensureColumn(sqlite, 'AuditLog', 'quantity', 'real DEFAULT 0');
  ensureColumn(sqlite, 'AuditLog', 'value', 'real DEFAULT 0');
  ensureColumn(sqlite, 'AuditLog', 'branchId', 'integer');

  ensureColumn(sqlite, 'JournalEntry', 'entryNumber', 'text');
  ensureColumn(sqlite, 'JournalEntry', 'status', "text DEFAULT 'posted'");
  ensureColumn(sqlite, 'JournalEntry', 'reversedEntryId', 'text');
  ensureColumn(sqlite, 'JournalEntry', 'createdBy', 'text');
  ensureColumn(sqlite, 'JournalEntry', 'branchId', 'integer');
  ensureColumn(sqlite, 'JournalEntry', 'createdAt', 'text');

  ensureColumn(sqlite, 'Transaction', 'debit', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Transaction', 'credit', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Transaction', 'orderId', 'text');
  ensureColumn(sqlite, 'Transaction', 'purchaseId', 'text');
  ensureColumn(sqlite, 'Transaction', 'returnId', 'text');
  ensureColumn(sqlite, 'Transaction', 'createdAt', 'text');

  // Helpful indexes for performance
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS "idx_batch_product_rem" ON "InventoryBatch" ("productId", "remainingQuantity", "purchaseDate");
    CREATE INDEX IF NOT EXISTS "idx_orderitem_order" ON "OrderItem" ("orderId");
    CREATE INDEX IF NOT EXISTS "idx_return_order" ON "Return" ("originalOrderId");
    CREATE INDEX IF NOT EXISTS "idx_tx_journal" ON "Transaction" ("journalEntryId");
    CREATE INDEX IF NOT EXISTS "idx_order_op" ON "Order" ("operationId");
    CREATE INDEX IF NOT EXISTS "idx_shift_mov_shift" ON "ShiftMovement" ("shiftId");
    CREATE INDEX IF NOT EXISTS "idx_pur_ret_orig" ON "PurchaseReturn" ("originalPurchaseId");
    CREATE INDEX IF NOT EXISTS "idx_cust_pay_cust" ON "CustomerPayment" ("customerId");
    CREATE INDEX IF NOT EXISTS "idx_sup_pay_sup" ON "SupplierPayment" ("supplierId");
    CREATE INDEX IF NOT EXISTS "idx_recipe_parent" ON "ServiceRecipe" ("parentProductId");
    CREATE INDEX IF NOT EXISTS "idx_fx_currency_date" ON "ExchangeRateHistory" ("currency", "effectiveFrom");
    CREATE INDEX IF NOT EXISTS "idx_fiscal_dates" ON "FiscalPeriod" ("startDate", "endDate", "status");
    CREATE INDEX IF NOT EXISTS "idx_inv_mov_prod_date" ON "InventoryMovement" ("productId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_prod_unit_prod" ON "ProductUnit" ("productId", "unitCode");
  `);
}

export async function runMigrations() {
  const dbPath = getDbPath();
  console.log('Running migrations on:', dbPath);

  const sqlite = new Database(dbPath);
  try {
    const integrity = sqlite.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${integrity}`);
    }

    const db = drizzle(sqlite);

    const migrationsFolder = process.env.NODE_ENV === 'production'
      ? [
          path.join(process.cwd(), 'drizzle', 'migrations'),
          path.join(__dirname, '..', 'drizzle', 'migrations'),
          path.join(process.resourcesPath || '', 'app.asar.unpacked', 'drizzle', 'migrations'),
        ].find((candidate) =>
          fs.existsSync(path.join(candidate, 'meta', '_journal.json'))
        )
      : path.resolve(process.cwd(), 'drizzle', 'migrations');

    if (!migrationsFolder || !fs.existsSync(path.join(migrationsFolder, 'meta', '_journal.json'))) {
      throw new Error(
        'Drizzle migrations are missing or incomplete. Expected drizzle/migrations/meta/_journal.json; checked packaged application paths.'
      );
    }

    console.log('Starting migrate() from:', migrationsFolder);
    migrate(db, { migrationsFolder });
    console.log('migrate() finished.');

    console.log('Ensuring schema upgrades...');
    ensureSchemaUpgrades(sqlite);
    console.log('Migrations & upgrades applied successfully.');
  } finally {
    sqlite.close();
  }
}
