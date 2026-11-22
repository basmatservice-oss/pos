import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalProductReport } from '../src/utils/operationalProductReport.js';

const startDate = new Date('2026-11-01T00:00:00.000Z');
const endDate = new Date('2026-11-30T23:59:59.999Z');

test('reports net product sales, costs and profit after partial returns', () => {
  const rows = buildOperationalProductReport({
    startDate, endDate,
    orders: [
      { id: 'sale-1', status: 'completed', createdAt: '2026-11-10T10:00:00.000Z' },
      { id: 'void-1', status: 'void', createdAt: '2026-11-10T11:00:00.000Z' },
    ],
    orderItems: [
      { orderId: 'sale-1', productId: 7, productName: 'قهوة', quantity: 10, total: 115, taxAmount: 15, costPriceAtTimeOfSale: 6 },
      { orderId: 'void-1', productId: 7, productName: 'قهوة', quantity: 100, total: 1150, taxAmount: 150, costPriceAtTimeOfSale: 6 },
    ],
    returns: [{ id: 'return-1', createdAt: '2026-11-12T10:00:00.000Z' }],
    returnItems: [{ returnId: 'return-1', productId: 7, quantity: 2, total: 23, taxAmount: 3, costPrice: 6 }],
    products: [{ id: 7, name: 'قهوة', itemType: 'stock' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantitySold, 10);
  assert.equal(rows[0].quantityReturned, 2);
  assert.equal(rows[0].netQuantity, 8);
  assert.equal(rows[0].netSales, 80);
  assert.equal(rows[0].netCost, 48);
  assert.equal(rows[0].profit, 32);
});

test('filters product reports to the explicitly selected products', () => {
  const rows = buildOperationalProductReport({
    startDate, endDate, mode: 'selected', selectedProductIds: [2],
    orders: [{ id: 'sale-1', status: 'completed', createdAt: '2026-11-10T10:00:00.000Z' }],
    orderItems: [
      { orderId: 'sale-1', productId: 1, productName: 'A', quantity: 1, total: 10, costPriceAtTimeOfSale: 2 },
      { orderId: 'sale-1', productId: 2, productName: 'B', quantity: 1, total: 20, costPriceAtTimeOfSale: 5 },
    ],
  });
  assert.deepEqual(rows.map((row) => row.productId), [2]);
  assert.equal(rows[0].profit, 15);
});

test('never uses the current product cost to invent historical sale profit', () => {
  const rows = buildOperationalProductReport({
    startDate, endDate,
    orders: [{ id: 'sale-old', status: 'completed', createdAt: '2026-11-10T10:00:00.000Z' }],
    orderItems: [{
      orderId: 'sale-old', productId: 33, productName: 'صنف قديم',
      quantity: 2, total: 200, costPriceAtTimeOfSale: undefined,
    }],
    products: [{ id: 33, name: 'صنف قديم', costPrice: 999 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].netCost, 0);
  assert.equal(rows[0].profit, null);
  assert.equal(rows[0].missingCostSnapshot, true);
});

test('includes returns in the selected period even when the original sale was earlier', () => {
  const rows = buildOperationalProductReport({
    startDate, endDate,
    returns: [{ id: 'return-old-sale', createdAt: '2026-11-14T10:00:00.000Z' }],
    returnItems: [{
      returnId: 'return-old-sale', productId: 81, productName: 'صنف مرتجع',
      quantity: 2, total: 230, taxAmount: 30, costPrice: 70, condition: 'resalable',
    }],
    products: [{ id: 81, name: 'صنف مرتجع', itemType: 'stock' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantitySold, 0);
  assert.equal(rows[0].quantityReturned, 2);
  assert.equal(rows[0].netSales, -200);
  assert.equal(rows[0].netCost, -140);
  assert.equal(rows[0].profit, -60);
});

test('does not reverse cost for damaged returned goods', () => {
  const rows = buildOperationalProductReport({
    startDate, endDate,
    returns: [{ id: 'damaged-return', createdAt: '2026-11-14T10:00:00.000Z' }],
    returnItems: [{
      returnId: 'damaged-return', productId: 82, productName: 'صنف تالف',
      quantity: 1, total: 115, taxAmount: 15, costPrice: 60, condition: 'damaged',
    }],
  });
  assert.equal(rows[0].netSales, -100);
  assert.equal(rows[0].netCost, 0);
  assert.equal(rows[0].profit, -100);
});
