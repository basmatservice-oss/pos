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

function backfillInventoryMovementLedger(sqlite: Database.Database) {
  const hasSettings = sqlite.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Setting'`
  ).get();
  if (!hasSettings) return;

  const marker = sqlite.prepare('SELECT value FROM "Setting" WHERE key = ?')
    .get('inventoryMovementBackfillV1') as { value?: string } | undefined;
  if (marker?.value === 'completed') return;

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO "InventoryMovement" (
      "id", "movementKey", "productId", "branchId", "movementType", "sourceType",
      "sourceId", "sourceLineId", "operationId", "deviceId", "createdBy",
      "inputQuantity", "unitCode", "baseUnitCode", "conversionToBase",
      "quantityDeltaBase", "unitCost", "totalCost", "batchAllocations",
      "reason", "createdAt"
    ) VALUES (
      @id, @movementKey, @productId, @branchId, @movementType, @sourceType,
      @sourceId, @sourceLineId, @operationId, @deviceId, @createdBy,
      @inputQuantity, @unitCode, @baseUnitCode, @conversionToBase,
      @quantityDeltaBase, @unitCost, @totalCost, @batchAllocations,
      @reason, @createdAt
    )
  `);

  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const allocationCost = (raw: any): number | null => {
      if (!raw) return null;
      try {
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const total = rows.reduce((sum: number, row: any) => {
          const quantity = Number(row?.quantity);
          const cost = Number(row?.costPrice);
          if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(cost) || cost < 0) {
            return NaN;
          }
          return sum + quantity * cost;
        }, 0);
        return Number.isFinite(total) ? total : null;
      } catch {
        return null;
      }
    };

    const save = (movement: any) => {
      const movementKey = [
        movement.movementType,
        movement.sourceType,
        movement.sourceId,
        movement.sourceLineId == null ? movement.productId : String(movement.sourceLineId),
      ].join(':');
      const operationId = movement.operationId;
      insert.run({
        id: `${operationId}:${movementKey}`,
        movementKey,
        productId: Number(movement.productId),
        branchId: movement.branchId == null ? null : Number(movement.branchId),
        movementType: movement.movementType,
        sourceType: movement.sourceType,
        sourceId: String(movement.sourceId),
        sourceLineId: movement.sourceLineId == null ? null : String(movement.sourceLineId),
        operationId,
        deviceId: movement.deviceId || null,
        createdBy: movement.createdBy || null,
        inputQuantity: movement.inputQuantity == null ? null : Number(movement.inputQuantity),
        unitCode: movement.unitCode || null,
        baseUnitCode: movement.baseUnitCode || null,
        conversionToBase: Number(movement.conversionToBase || 1),
        quantityDeltaBase: Number(movement.quantityDeltaBase),
        unitCost: Number(movement.unitCost || 0),
        totalCost: Math.abs(Number(movement.totalCost || 0)),
        batchAllocations: movement.batchAllocations || null,
        reason: 'legacy_backfill',
        createdAt: movement.createdAt || now,
      });
    };

    const batches = sqlite.prepare(`
      SELECT id, productId, purchaseId, quantity, baseQuantity, costPrice,
             unitCode, baseUnitCode, conversionToBase, branchId, purchaseDate, createdAt
      FROM "InventoryBatch"
      WHERE purchaseId IS NOT NULL
         OR id LIKE 'opening-%'
         OR id LIKE 'stocktake-%'
    `).all() as any[];

    for (const batch of batches) {
      const quantity = Number(batch.baseQuantity ?? batch.quantity ?? 0);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      const unitCost = Number(batch.costPrice || 0);
      const isPurchase = Boolean(batch.purchaseId);
      const isStocktake = !isPurchase && String(batch.id).startsWith('stocktake-');
      const movementType = isPurchase
        ? 'purchase_receipt'
        : isStocktake ? 'stocktake_increase' : 'opening_balance';
      const sourceType = isPurchase ? 'purchase' : isStocktake ? 'stocktake' : 'product';
      const batchId = String(batch.id);
      const stocktakeSessionId = isStocktake
        ? batchId.slice('stocktake-'.length, batchId.length - String(batch.productId).length - 1)
        : null;
      const sourceId = isPurchase ? String(batch.purchaseId) : isStocktake ? String(stocktakeSessionId) : String(batch.productId);
      const operationId = `legacy:batch:${batch.id}`;
      const factor = Number(batch.conversionToBase || 1);
      save({
        productId: batch.productId,
        branchId: batch.branchId,
        movementType,
        sourceType,
        sourceId,
        sourceLineId: batch.id,
        operationId,
        inputQuantity: quantity / (factor > 0 ? factor : 1),
        unitCode: batch.unitCode,
        baseUnitCode: batch.baseUnitCode,
        conversionToBase: factor,
        quantityDeltaBase: quantity,
        unitCost,
        totalCost: quantity * unitCost,
        batchAllocations: JSON.stringify([{ batchId: batch.id, quantity, costPrice: unitCost }]),
        createdAt: batch.purchaseDate || batch.createdAt || now,
      });
    }

    const sales = sqlite.prepare(`
      SELECT oi.id, oi.orderId, oi.productId, oi.quantity, oi.unitCode, oi.baseUnitCode,
             oi.conversionToBase, oi.conversionFactor, oi.baseQuantity,
             oi.costPriceAtTimeOfSale, oi.batchAllocations,
             o.branchId, o.deviceId, o.createdBy, o.createdAt, o.updatedAt, o.status
      FROM "OrderItem" oi
      LEFT JOIN "Order" o ON o.id = oi.orderId
    `).all() as any[];

    for (const item of sales) {
      const quantity = Number(item.quantity || 0);
      const factor = Number(item.conversionToBase ?? item.conversionFactor ?? 1);
      const safeFactor = factor > 0 ? factor : 1;
      const baseQuantity = Number(item.baseQuantity ?? quantity * safeFactor);
      if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) continue;
      const inputCost = Number(item.costPriceAtTimeOfSale || 0);
      const allocations = item.batchAllocations || null;
      const totalCost = allocationCost(allocations) ?? inputCost * quantity;
      save({
        productId: item.productId,
        branchId: item.branchId,
        movementType: 'sale',
        sourceType: 'order',
        sourceId: String(item.orderId),
        sourceLineId: item.id,
        operationId: `legacy:sale:${item.id}`,
        deviceId: item.deviceId,
        createdBy: item.createdBy,
        inputQuantity: quantity,
        unitCode: item.unitCode,
        baseUnitCode: item.baseUnitCode,
        conversionToBase: safeFactor,
        quantityDeltaBase: -baseQuantity,
        unitCost: totalCost / baseQuantity,
        totalCost,
        batchAllocations: allocations,
        createdAt: item.createdAt || item.updatedAt || now,
      });

      if (item.status === 'void') {
        save({
          productId: item.productId,
          branchId: item.branchId,
          movementType: 'sale_void',
          sourceType: 'order_void',
          sourceId: String(item.orderId),
          sourceLineId: item.id,
          operationId: `legacy:void:${item.orderId}`,
          deviceId: item.deviceId,
          createdBy: item.createdBy,
          inputQuantity: quantity,
          unitCode: item.unitCode,
          baseUnitCode: item.baseUnitCode,
          conversionToBase: safeFactor,
          quantityDeltaBase: baseQuantity,
          unitCost: totalCost / baseQuantity,
          totalCost,
          batchAllocations: allocations,
          createdAt: item.updatedAt || item.createdAt || now,
        });
      }
    }

    const returns = sqlite.prepare(`
      SELECT ri.id, ri.returnId, ri.productId, ri.quantity, ri.unitCode, ri.baseUnitCode,
             ri.conversionToBase, ri.baseQuantity, ri.costPrice, ri.batchAllocations,
             r.branchId, r.createdAt
      FROM "ReturnItem" ri
      LEFT JOIN "Return" r ON r.id = ri.returnId
    `).all() as any[];

    for (const item of returns) {
      const quantity = Number(item.quantity || 0);
      const factor = Number(item.conversionToBase || 1);
      const safeFactor = factor > 0 ? factor : 1;
      const baseQuantity = Number(item.baseQuantity ?? quantity * safeFactor);
      if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) continue;
      const totalCost = allocationCost(item.batchAllocations) ?? Number(item.costPrice || 0) * quantity;
      save({
        productId: item.productId,
        branchId: item.branchId,
        movementType: 'sale_return',
        sourceType: 'return',
        sourceId: String(item.returnId),
        sourceLineId: item.id,
        operationId: `legacy:return:${item.id}`,
        inputQuantity: quantity,
        unitCode: item.unitCode,
        baseUnitCode: item.baseUnitCode,
        conversionToBase: safeFactor,
        quantityDeltaBase: baseQuantity,
        unitCost: totalCost / baseQuantity,
        totalCost,
        batchAllocations: item.batchAllocations,
        createdAt: item.createdAt || now,
      });
    }

    const purchaseReturns = sqlite.prepare(`
      SELECT pri.id, pri.purchaseReturnId, pri.productId, pri.quantity, pri.unitCode,
             pri.baseUnitCode, pri.conversionToBase, pri.baseQuantity, pri.costPrice,
             pri.batchId, pr.branchId, pr.createdAt
      FROM "PurchaseReturnItem" pri
      LEFT JOIN "PurchaseReturn" pr ON pr.id = pri.purchaseReturnId
    `).all() as any[];

    for (const item of purchaseReturns) {
      const quantity = Number(item.quantity || 0);
      const factor = Number(item.conversionToBase || 1);
      const safeFactor = factor > 0 ? factor : 1;
      const baseQuantity = Number(item.baseQuantity ?? quantity * safeFactor);
      if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) continue;
      const unitCost = Number(item.costPrice || 0) / safeFactor;
      const totalCost = baseQuantity * unitCost;
      save({
        productId: item.productId,
        branchId: item.branchId,
        movementType: 'purchase_return',
        sourceType: 'purchase_return',
        sourceId: String(item.purchaseReturnId),
        sourceLineId: item.id,
        operationId: `legacy:purchase-return:${item.id}`,
        inputQuantity: quantity,
        unitCode: item.unitCode,
        baseUnitCode: item.baseUnitCode,
        conversionToBase: safeFactor,
        quantityDeltaBase: -baseQuantity,
        unitCost,
        totalCost,
        batchAllocations: item.batchId
          ? JSON.stringify([{ batchId: item.batchId, quantity: baseQuantity, costPrice: unitCost }])
          : null,
        createdAt: item.createdAt || now,
      });
    }

    sqlite.prepare(`
      INSERT INTO "Setting" ("key", "value", "isSynced", "createdAt", "updatedAt")
      VALUES (?, 'completed', 1, ?, ?)
      ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"
    `).run('inventoryMovementBackfillV1', now, now);
  });

  transaction();
}

export function ensureSchemaUpgrades(sqlite: Database.Database) {
  // Unit definitions and per-product conversion units (additive; legacy unit fields remain intact).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "UnitDefinition" (
      "code" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "symbol" text,
      "dimension" text NOT NULL,
      "decimalPlaces" integer NOT NULL DEFAULT 0,
      "isFractional" integer NOT NULL DEFAULT 0,
      "isActive" integer NOT NULL DEFAULT 1,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "ProductUnit" (
      "id" text PRIMARY KEY NOT NULL,
      "productId" integer NOT NULL,
      "unitCode" text NOT NULL,
      "conversionToBase" real NOT NULL CHECK ("conversionToBase" > 0),
      "isBaseUnit" integer NOT NULL DEFAULT 0,
      "sellingPrice" real,
      "barcode" text,
      "isActive" integer NOT NULL DEFAULT 1,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_product_unit_product" ON "ProductUnit" ("productId", "isActive");
  `);

  // 1. Ensure newly added tables exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "InventoryBatch" (
      "id" text PRIMARY KEY NOT NULL,
      "productId" integer NOT NULL,
      "purchaseId" text,
      "quantity" real NOT NULL,
      "remainingQuantity" real NOT NULL,
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
      "quantity" real NOT NULL,
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
  `);

  // 2. Ensure new columns on existing tables
  ensureColumn(sqlite, 'Product', 'costInUSD', 'real');
  ensureColumn(sqlite, 'Product', 'priceInUSD', 'real');
  ensureColumn(sqlite, 'Product', 'minStockLevel', 'integer DEFAULT 5');
  ensureColumn(sqlite, 'Product', 'unit', "text DEFAULT 'piece'");
  ensureColumn(sqlite, 'Product', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'Product', 'quantityPrecision', 'integer DEFAULT 0');
  ensureColumn(sqlite, 'Product', 'conversionFactor', 'real DEFAULT 1');
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
  ensureColumn(sqlite, 'OrderItem', 'conversionFactor', 'real DEFAULT 1');
  ensureColumn(sqlite, 'OrderItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'OrderItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'OrderItem', 'conversionToBase', 'real');
  ensureColumn(sqlite, 'OrderItem', 'baseQuantity', 'real');
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
  ensureColumn(sqlite, 'Purchase', 'currencyCode', 'text');
  ensureColumn(sqlite, 'Purchase', 'baseCurrencyCode', 'text');
  ensureColumn(sqlite, 'Purchase', 'exchangeRate', 'real');
  ensureColumn(sqlite, 'Purchase', 'exchangeRateId', 'text');
  ensureColumn(sqlite, 'Purchase', 'originalTotalAmount', 'real');
  ensureColumn(sqlite, 'Purchase', 'originalPaidAmount', 'real');

  ensureColumn(sqlite, 'PurchaseItem', 'originalCostPrice', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'originalTotal', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'currencyCode', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'exchangeRate', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'exchangeRateId', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'PurchaseItem', 'conversionToBase', 'real');
  ensureColumn(sqlite, 'PurchaseItem', 'baseQuantity', 'real');

  ensureColumn(sqlite, 'InventoryBatch', 'originalCostPrice', 'real');
  ensureColumn(sqlite, 'InventoryBatch', 'currencyCode', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'exchangeRate', 'real');
  ensureColumn(sqlite, 'InventoryBatch', 'exchangeRateId', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'unitCode', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'InventoryBatch', 'conversionToBase', 'real');
  ensureColumn(sqlite, 'InventoryBatch', 'baseQuantity', 'real');


  ensureColumn(sqlite, 'ReturnItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'ReturnItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'ReturnItem', 'conversionToBase', 'real');
  ensureColumn(sqlite, 'ReturnItem', 'baseQuantity', 'real');

  ensureColumn(sqlite, 'PurchaseReturnItem', 'unitCode', 'text');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'conversionToBase', 'real');
  ensureColumn(sqlite, 'PurchaseReturnItem', 'baseQuantity', 'real');

  ensureColumn(sqlite, 'StocktakingEntry', 'unitCode', 'text');
  ensureColumn(sqlite, 'StocktakingEntry', 'baseUnitCode', 'text');
  ensureColumn(sqlite, 'AuditLog', 'unitCode', 'text');
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

  // Immutable, idempotent inventory movement ledger. Existing stock/FIFO tables remain authoritative.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "InventoryMovement" (
      "id" text PRIMARY KEY NOT NULL,
      "movementKey" text NOT NULL,
      "productId" integer NOT NULL,
      "branchId" integer,
      "movementType" text NOT NULL,
      "sourceType" text NOT NULL,
      "sourceId" text NOT NULL,
      "sourceLineId" text,
      "operationId" text NOT NULL,
      "deviceId" text,
      "createdBy" text,
      "inputQuantity" real,
      "unitCode" text,
      "baseUnitCode" text,
      "conversionToBase" real NOT NULL DEFAULT 1,
      "quantityDeltaBase" real NOT NULL,
      "unitCost" real NOT NULL DEFAULT 0,
      "totalCost" real NOT NULL DEFAULT 0,
      "batchAllocations" text,
      "reason" text,
      "createdAt" text NOT NULL
    );
    DROP INDEX IF EXISTS "idx_inventory_movement_operation_key";
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_inventory_movement_key"
      ON "InventoryMovement" ("movementKey");
    CREATE INDEX IF NOT EXISTS "idx_inventory_movement_product_date"
      ON "InventoryMovement" ("productId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_inventory_movement_branch_date"
      ON "InventoryMovement" ("branchId", "createdAt");
    CREATE INDEX IF NOT EXISTS "idx_inventory_movement_created_at"
      ON "InventoryMovement" ("createdAt", "id");
    CREATE INDEX IF NOT EXISTS "idx_inventory_movement_source"
      ON "InventoryMovement" ("sourceType", "sourceId");
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

  backfillInventoryMovementLedger(sqlite);
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
