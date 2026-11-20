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
