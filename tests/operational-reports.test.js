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
    purchaseItems: [{ purchaseId: 'p1', productId: 10, productName: 'Product', quantity: 10, conversionFactor: 2, total: 200 }],
    purchaseReturns: [{ id: 'pr1', supplierId: 4, supplierName: 'Supplier', createdAt: '2026-11-14', totalReturn: 20 }],
    purchaseReturnItems: [{ purchaseReturnId: 'pr1', productId: 10, productName: 'Product', quantity: 4, total: 40 }],
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
  assert.equal(result.purchaseProducts[0].netQuantity, 16);
  assert.equal(result.purchaseProducts[0].netTotal, 160);
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


test('advanced operational reports calculate stock age, approximate turnover, debt aging, shifts, banks and taxes', () => {
  const result = buildOperationalReports({
    startDate: '2026-11-01T00:00:00.000Z',
    endDate: '2026-11-30T23:59:59.999Z',
    orders: [{ id: 'old-sale', createdAt: '2026-10-01T10:00:00.000Z', netAmount: 100, paidAmount: 20, returnedAmount: 10, taxAmount: 20, paymentMethod: 'credit' }],
    agingOrders: [
      { id: 'old-sale', createdAt: '2026-10-01T10:00:00.000Z', netAmount: 100, paidAmount: 20, returnedAmount: 10, customerName: 'Older Customer' },
      { id: 'very-old', createdAt: '2026-08-01T10:00:00.000Z', netAmount: 100, paidAmount: 0, customerName: 'Old Customer' },
    ],
    returns: [{ id: 'ret', originalOrderId: 'old-sale', createdAt: '2026-11-10', totalRefund: 10, taxAmount: 2, refundMethod: 'cash' }],
    purchases: [{ id: 'old-purchase', supplierId: 9, supplierName: 'Old Supplier', date: '2026-08-01', totalAmount: 300, paidAmount: 100, returnedAmount: 20 }],
    inventoryBatches: [{ id: 'b1', productId: 1, remainingQuantity: 5, costPrice: 10, exchangeRate: 1, purchaseDate: '2026-08-01', expiryDate: '2026-12-10' }],
    inventoryMovements: [
      { productId: 1, movementType: 'sale', quantityDeltaBase: -4, totalCost: 40, createdAt: '2026-11-10' },
      { productId: 1, movementType: 'sale_return', quantityDeltaBase: 1, totalCost: 5, createdAt: '2026-11-12' },
    ],
    shifts: [{ id: 'sh1', startTime: '2026-11-10', endTime: '2026-11-10T20:00:00Z', status: 'closed', openingCash: 50, expectedCash: 100, actualCash: 90 }],
    shiftMovements: [
      { shiftId: 'sh1', type: 'deposit', amount: 10 },
      { shiftId: 'sh1', type: 'withdrawal', amount: 5 },
    ],
    accounts: [{ code: '101-bank', name: 'Bank Account', balance: 500 }],
    transactions: [
      { accountId: '101-bank', type: 'debit', amount: 100, createdAt: '2026-11-10' },
      { accountId: '101-bank', type: 'credit', amount: 30, createdAt: '2026-11-11' },
    ],
    attendance: [
      { date: '2026-11-10', status: 'present', totalHours: 8 },
      { date: '2026-11-11', status: 'late', totalHours: 6 },
    ],
  });
  assert.equal(result.receivablesAging.total, 170);
  assert.equal(result.receivablesAging.buckets['31-60 يوم'], 70);
  assert.equal(result.receivablesAging.buckets['أكثر من 90 يوم'], 100);
  assert.equal(result.payablesAging.total, 180);
  assert.equal(result.payablesAging.buckets['أكثر من 90 يوم'], 180);
  assert.equal(result.inventoryAging.totalValue, 50);
  assert.equal(result.inventoryAging.rows[0].stockAgeDays, 121);
  assert.equal(result.inventoryAging.rows[0].expiring, 5);
  assert.equal(result.inventoryTurnover.cogs, 35);
  assert.equal(result.inventoryTurnover.ratio, 0.7);
  assert.equal(result.shifts.variance, -10);
  assert.equal(result.shifts.rows[0].deposits, 10);
  assert.equal(result.shifts.rows[0].withdrawals, 5);
  assert.equal(result.banks[0].debit, 100);
  assert.equal(result.banks[0].credit, 30);
  assert.equal(result.taxes.netOutputTax, 18);
  assert.equal(result.attendance.records, 2);
  assert.equal(result.attendance.hours, 14);
});
