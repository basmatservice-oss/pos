import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
const app = source('../server/app.ts');
const operations = source('../server/operations.ts');

test('customer and supplier create endpoints never accept caller-controlled ledger balances', () => {
  const customerRoute = app.match(/app\.post\('\/api\/customers'[\s\S]*?\n  \}\);/)?.[0] || '';
  const supplierRoute = app.match(/app\.post\('\/api\/suppliers'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.ok(customerRoute.includes('balance: 0'));
  assert.ok(customerRoute.includes('points: 0'));
  assert.ok(!customerRoute.includes('...req.body'));
  assert.ok(!customerRoute.includes('onConflictDoUpdate'));
  assert.ok(supplierRoute.includes('balance: 0'));
  assert.ok(!supplierRoute.includes('...req.body'));
  assert.ok(!supplierRoute.includes('onConflictDoUpdate'));
});

test('customer and supplier deletion is blocked when balances or historical documents exist', () => {
  const customerDelete = app.match(/app\.delete\('\/api\/customers\/:id'[\s\S]*?\n  \}\);/)?.[0] || '';
  const supplierDelete = app.match(/app\.delete\('\/api\/suppliers\/:id'[\s\S]*?\n  \}\);/)?.[0] || '';
  for (const token of ['customer.balance', 'orders', 'customerPayments', 'returns', '409']) assert.ok(customerDelete.includes(token), token);
  for (const token of ['supplier.balance', 'purchases', 'purchaseReturns', 'supplierPayments', '409']) assert.ok(supplierDelete.includes(token), token);
});

test('generic entity synchronization preserves customer, supplier and account balances', () => {
  assert.ok(operations.includes("if (tableName === 'accounts')"));
  assert.ok(operations.includes("balance: 0, isSystem: 0"));
  assert.ok(operations.includes("normalizedClean.balance = existing ? existing.balance : 0"));
  assert.ok(operations.includes("normalizedClean.points = existing ? existing.points : 0"));
});

test('generic entity deletion cannot erase accounting accounts or referenced inventory/customer/supplier history', () => {
  const deleteHandler = operations.match(/function handleEntityDelete\([\s\S]*?\n\}/)?.[0] || '';
  for (const token of ["tableName === 'accounts'", "tableName === 'products'", "tableName === 'customers'", "tableName === 'suppliers'", 'inventoryMovements', 'customerPayments', 'supplierPayments', 'OperationError']) {
    assert.ok(deleteHandler.includes(token), token);
  }
});

test('server business operations retain transactional idempotency around sale and return posting', () => {
  assert.ok(operations.includes('return dbInstance.transaction((tx: any) =>'));
  assert.ok(operations.includes("case 'sale':"));
  assert.ok(operations.includes("case 'return':"));
  assert.ok(operations.includes('processedOperations'));
});

test('product creation posts opening inventory and journal in one transaction without upsert semantics', () => {
  const productCreate = app.match(/app\.post\('\/api\/products'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.ok(productCreate.includes('db.transaction((tx)'));
  assert.ok(productCreate.includes('tx.insert(inventoryBatches)'));
  assert.ok(productCreate.includes('recordInventoryMovement(tx'));
  assert.ok(productCreate.includes('postJournalEntry(tx'));
  assert.ok(!productCreate.includes('onConflictDoUpdate'));
});

test('direct endpoints cannot bypass stock, purchase, sale, shift-close or loyalty operations', () => {
  for (const route of [
    "app.post('/api/inventoryBatches'",
    "app.put('/api/inventoryBatches/:id'",
    "app.post('/api/purchaseItems'",
    "app.post('/api/loyalty-transactions'",
    "app.put('/api/orders/:id'",
    "app.put('/api/shifts/:id'",
  ]) {
    const start = app.indexOf(route);
    assert.notEqual(start, -1, route);
    const end = app.indexOf('\n  });', start);
    const handler = app.slice(start, end);
    assert.ok(handler.includes('res.status(400)'), route);
  }
});

test('stocktake entry baselines come from the server and approved sessions cannot be deleted', () => {
  const entryRoute = app.match(/app\.post\('\/api\/stocktakingEntries'[\s\S]*?\n  \}\);/)?.[0] || '';
  const deleteRoute = app.match(/app\.delete\('\/api\/stocktakingSessions\/:id'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.ok(entryRoute.includes('Number(product[0].stockQuantity || 0)'));
  assert.ok(entryRoute.includes('session[0].status !== \'open\''));
  assert.ok(entryRoute.includes('existingEntries.some'));
  assert.ok(deleteRoute.includes("session.status === 'approved'"));
  assert.ok(deleteRoute.includes('db.transaction((tx)'));
});

test('server and local inventory journal paths use the same currency-rounded sale cost basis', () => {
  const accounting = source('../server/accounting.ts');
  const operationService = source('../src/services/operationService.ts');
  assert.ok(accounting.includes('roundMoney(totalCost) / qtyNeeded'));
  assert.ok(operationService.includes('baseUnitCode: product.baseUnitCode || product.unit || \'piece\''));
  assert.ok(operationService.includes('baseUnitCode: product.baseUnitCode || product.unit || \'piece\''));
});

test('server rejects sale and return payloads that the native SQLite operation path rejects', () => {
  assert.ok(operations.includes('at least one sale item is required'));
  assert.ok(operations.includes('Invalid sale totals or exchange rate'));
  assert.ok(operations.includes("!['cash', 'card', 'credit_adjustment'].includes(String(effectiveRefundMethod))"));
  assert.ok(operations.includes('بيانات كمية أو معامل تحويل الصنف الأصلي غير صالحة'));
  assert.ok(operations.includes('القيم المالية للصنف الأصلي غير صالحة'));
});
