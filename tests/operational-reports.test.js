import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalReports } from '../src/utils/operationalReports.js';

test('operational reports reconcile sales returns, split tenders, purchases and supplier returns', () => {
  const result = buildOperationalReports({
    startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-30T23:59:59.999Z',
    orders: [
      { id: 's1', createdAt: '2026-11-10', createdBy: 'Cashier A', customerId: 7, netAmount: 120, paidAmount: 60, taxAmount: 20, paymentMethod: 'mixed', cashAmount: 70, cardAmount: 50 },
      { id: 's2', createdAt: '2026-11-11', createdBy: 'Cashier B', netAmount: 50, taxAmount: 0, paymentMethod: 'credit' },
      { id: 'void', createdAt: '2026-11-12', createdBy: 'Cashier A', netAmount: 900, paymentMethod: 'cash', status: 'void' },
    ],
    returns: [{ id: 'r1', originalOrderId: 's1', createdAt: '2026-11-13', totalRefund: 12, taxAmount: 2, refundMethod: 'cash' }],
    purchases: [{ id: 'p1', supplierId: 4, supplierName: 'Supplier', date: '2026-11-10', totalAmount: 200, paidAmount: 100 }],
    purchaseReturns: [{ id: 'pr1', supplierId: 4, supplierName: 'Supplier', createdAt: '2026-11-14', totalReturn: 20 }],
    expenses: [{ category: 'Rent', amount: 30, date: '2026-11-10' }],
    customers: [{ id: 7, name: 'Customer' }],
    customerPayments: [{ customerId: 7, amount: 10, createdAt: '2026-11-15' }],
    supplierPayments: [{ supplierId: 4, amount: 25, createdAt: '2026-11-16' }],
    inventoryMovements: [{ movementType: 'sale', quantityDeltaBase: -3, totalCost: 15, createdAt: '2026-11-17' }],
  });
  assert.equal(result.sales.count, 2);
  assert.equal(result.sales.netExTax, 150);
  assert.equal(result.payments.cashNet, 58);
  assert.equal(result.payments.cardNet, 50);
  assert.equal(result.payments.creditNet, 50);
  assert.equal(result.purchases.gross, 200);
  assert.equal(result.purchases.returns, 20);
  assert.equal(result.suppliers[0].netPurchases, 180);
  assert.equal(result.staff.find((row) => row.name === 'Cashier A').netSales, 90);
  assert.equal(result.expenses[0].total, 30);
  assert.equal(result.customers[0].netSales, 108);
  assert.equal(result.customers[0].paid, 60);
  assert.equal(result.customerCollections, 10);
  assert.equal(result.supplierPayments, 25);
  assert.equal(result.inventory[0].quantityOut, 3);
});

test('operational reports exclude invalid dates and do not mutate source records', () => {
  const orders = [{ id: 'bad', createdAt: 'invalid', netAmount: 99, paymentMethod: 'cash' }];
  const result = buildOperationalReports({ startDate: '2026-11-01', endDate: '2026-11-30', orders });
  assert.equal(result.sales.count, 0);
  assert.equal(result.payments.cashNet, 0);
  assert.equal(orders[0].netAmount, 99);
});
