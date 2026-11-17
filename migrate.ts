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
    CREATE TABLE IF NOT EXISTS "InventoryBatch" (
      "id" text PRIMARY KEY NOT NULL,
      "productId" integer NOT NULL,
      "purchaseId" text,
      "quantity" integer NOT NULL,
      "remainingQuantity" integer NOT NULL,
      "costPrice" real NOT NULL,
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
      "quantity" integer NOT NULL,
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
      "previousQty" integer NOT NULL,
      "changeQty" integer NOT NULL,
      "resultingQty" integer NOT NULL,
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
      "quantity" integer NOT NULL,
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
  `);

  // 2. Ensure new columns on existing tables
  ensureColumn(sqlite, 'Product', 'costInUSD', 'real');
  ensureColumn(sqlite, 'Product', 'priceInUSD', 'real');
  ensureColumn(sqlite, 'Product', 'minStockLevel', 'integer DEFAULT 5');
  ensureColumn(sqlite, 'Product', 'unit', "text DEFAULT 'piece'");
  ensureColumn(sqlite, 'Product', 'conversionFactor', 'integer DEFAULT 1');
  ensureColumn(sqlite, 'Product', 'expiryDate', 'text');
  ensureColumn(sqlite, 'Product', 'batchNumber', 'text');

  ensureColumn(sqlite, 'Order', 'paidAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'cashAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'cardAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'returnedAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'Order', 'shiftId', 'text');
  ensureColumn(sqlite, 'Order', 'deviceId', 'text');
  ensureColumn(sqlite, 'Order', 'operationId', 'text');

  ensureColumn(sqlite, 'OrderItem', 'returnedQuantity', 'integer DEFAULT 0');
  ensureColumn(sqlite, 'OrderItem', 'unit', "text DEFAULT 'piece'");
  ensureColumn(sqlite, 'OrderItem', 'conversionFactor', 'integer DEFAULT 1');
  ensureColumn(sqlite, 'OrderItem', 'costPriceAtTimeOfSale', 'real DEFAULT 0');
  ensureColumn(sqlite, 'OrderItem', 'discountAmount', 'real DEFAULT 0');
  ensureColumn(sqlite, 'OrderItem', 'batchAllocations', 'text');

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
  ensureColumn(sqlite, 'Purchase', 'deviceId', 'text');
  ensureColumn(sqlite, 'Purchase', 'operationId', 'text');

  ensureColumn(sqlite, 'AuditLog', 'operationName', 'text');
  ensureColumn(sqlite, 'AuditLog', 'productName', 'text');
  ensureColumn(sqlite, 'AuditLog', 'quantity', 'integer DEFAULT 0');
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

  // Currency foundation: no seeded/default base currency and no rewriting of legacy amounts.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "Currency" (
      "code" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "symbol" text,
      "decimalPlaces" integer NOT NULL DEFAULT 2,
      "isActive" integer NOT NULL DEFAULT 1,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "ExchangeRate" (
      "id" text PRIMARY KEY NOT NULL,
      "baseCurrencyCode" text NOT NULL,
      "quoteCurrencyCode" text NOT NULL,
      "rate" real NOT NULL CHECK ("rate" > 0),
      "effectiveAt" text NOT NULL,
      "source" text NOT NULL,
      "approvedBy" text,
      "approvedAt" text,
      "createdBy" text,
      "createdAt" text NOT NULL,
      "isSynced" integer NOT NULL DEFAULT 0,
      CHECK ("baseCurrencyCode" <> "quoteCurrencyCode")
    );
    CREATE INDEX IF NOT EXISTS "idx_exchange_rate_pair_effective"
      ON "ExchangeRate" ("baseCurrencyCode", "quoteCurrencyCode", "effectiveAt");
  `);

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

    let migrationsFolder = path.resolve(process.cwd(), 'drizzle', 'migrations');
    if (process.env.NODE_ENV === 'production') {
      const possiblePaths = [
        path.join(process.cwd(), 'resources', 'app', 'drizzle', 'migrations'),
        path.join(process.cwd(), 'drizzle', 'migrations'),
        path.join(__dirname, '..', 'drizzle', 'migrations'),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          migrationsFolder = p;
          break;
        }
      }
    }

    if (fs.existsSync(migrationsFolder)) {
      console.log('Starting migrate()...');
      migrate(db, { migrationsFolder });
      console.log('migrate() finished.');
    } else {
      console.warn('Migrations folder not found at:', migrationsFolder);
    }

    console.log('Ensuring schema upgrades...');
    ensureSchemaUpgrades(sqlite);
    console.log('Migrations & upgrades applied successfully.');
  } finally {
    sqlite.close();
  }
}
