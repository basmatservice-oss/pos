import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalReports, matchesOperationalLinkedRecord } from '../src/utils/operationalReports.js';

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
    purchaseItems: [{ purchaseId: 'p1', productId: 10, productName: 'Product', quantity: 10, conversionFactor: 2, landedCostPerBaseUnit: 11, total: 200 }],
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
  assert.equal(result.purchaseProducts[0].netTotal, 180);
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
    orders: [{ id: 'old-sale', createdAt: '2026-11-10T10:00:00.000Z', netAmount: 100, paidAmount: 20, returnedAmount: 10, taxAmount: 20, paymentMethod: 'credit' }, { id: 'cash-sale', createdAt: '2026-11-10T11:00:00.000Z', shiftId: 'sh1', netAmount: 50, paidAmount: 50, cashAmount: 50, paymentMethod: 'cash' }],
    agingOrders: [
      { id: 'old-sale', createdAt: '2026-10-01T10:00:00.000Z', netAmount: 100, paidAmount: 40, returnedAmount: 20, customerName: 'Older Customer' },
      { id: 'very-old', createdAt: '2026-08-01T10:00:00.000Z', netAmount: 100, paidAmount: 0, customerName: 'Old Customer' },
    ],
    returns: [{ id: 'ret', originalOrderId: 'old-sale', shiftId: 'sh1', createdAt: '2026-11-10', totalRefund: 10, taxAmount: 2, refundMethod: 'cash' }, { id: 'future-ret', originalOrderId: 'old-sale', createdAt: '2026-12-10', totalRefund: 10 }],
    purchases: [{ id: 'old-purchase', supplierId: 9, supplierName: 'Old Supplier', date: '2026-08-01', totalAmount: 300, paidAmount: 100, returnedAmount: 20, extraCostsPaymentMethod: 'supplier', shippingCost: 20 }],
    purchaseReturns: [{ id: 'future-pr', originalPurchaseId: 'old-purchase', createdAt: '2026-12-10', totalReturn: 10 }],
    products: [{ id: 1, name: 'Stock Item' }],
    inventoryBatches: [
      { id: 'b1', productId: 1, remainingQuantity: 5, costPrice: 10, exchangeRate: 4, purchaseDate: '2026-08-01', expiryDate: '2026-12-10' },
      { id: 'b2', productId: 2, remainingQuantity: 2, costPrice: 0, purchaseDate: '2026-11-01' },
      { id: 'b3', productId: 3, remainingQuantity: 2, costPrice: 0, createdAt: '2026-08-01' },
      { id: 'b4', productId: 4, remainingQuantity: 9, costPrice: 20, purchaseDate: '2026-12-05' },
      { id: 'b5', productId: 5, remainingQuantity: 3, costPrice: 7 },
    ],
    inventoryMovements: [
      { productId: 1, movementType: 'sale', quantityDeltaBase: -4, totalCost: 40, createdAt: '2026-11-10' },
      { productId: 1, movementType: 'sale_return', quantityDeltaBase: 1, totalCost: 5, createdAt: '2026-11-12' },
      { productId: 1, movementType: 'sale_void', quantityDeltaBase: 1, totalCost: 2, createdAt: '2026-11-13' },
    ],
    customerPayments: [{ customerId: 7, shiftId: 'sh1', paymentMethod: 'cash', amount: 20, createdAt: '2026-11-10' }, { orderId: 'old-sale', customerId: 7, amount: 10, createdAt: '2026-12-05' }],
    supplierPayments: [{ supplierId: 9, shiftId: 'sh1', paymentMethod: 'cash', amount: 5, createdAt: '2026-11-10' }, { purchaseId: 'old-purchase', supplierId: 9, amount: 10, createdAt: '2026-12-05' }],
    expenses: [{ shiftId: 'sh1', paymentMethod: 'cash', amount: 8, date: '2026-11-10' }],
    shifts: [{ id: 'sh1', startTime: '2026-11-10', endTime: '2026-11-10T20:00:00Z', status: 'closed', openingCash: 50, expectedCash: 100, actualCash: 90 }],
    shiftMovements: [
      { shiftId: 'sh1', type: 'deposit', amount: 10 },
      { shiftId: 'sh1', type: 'withdrawal', amount: 5 },
    ],
    accounts: [{ code: '101-bank', name: 'Bank Account', balance: 500 }, { code: '1010', name: 'Cash Box', balance: 150 }],
    transactions: [
      { accountId: '101-bank', type: 'debit', amount: 100, createdAt: '2026-11-10' },
      { accountId: '101-bank', type: 'credit', amount: 30, createdAt: '2026-11-11' },
      { accountId: '1010', type: 'debit', amount: 80, createdAt: '2026-11-10' },
      { accountId: '1010', type: 'credit', amount: 20, createdAt: '2026-11-11' },
    ],
    attendance: [
      { date: '2026-11-10', status: 'present', totalHours: 8 },
      { date: '2026-11-11', status: 'late', totalHours: 6 },
    ],
  });
  assert.equal(result.receivablesAging.total, 160);
  assert.equal(result.receivablesAging.buckets['31-60 يوم'], 60);
  assert.equal(result.receivablesAging.buckets['أكثر من 90 يوم'], 100);
  assert.equal(result.payablesAging.total, 220);
  assert.equal(result.payablesAging.buckets['أكثر من 90 يوم'], 220);
  assert.equal(result.inventoryAging.totalValue, 71);
  assert.equal(result.inventoryAging.rows.some((row) => row.productId === 4), false, 'receipts after the report cutoff must be excluded');
  assert.equal(result.inventoryAging.buckets['تاريخ غير معروف'], 21, 'batches without a reliable purchase date must be separated from dated stock');
  assert.equal(result.inventoryAging.rows.find((row) => row.productId === 5).stockAgeDays, null);
  assert.equal(result.inventoryAging.rows.find((row) => row.productId === 5).status, 'عمر غير محدد');
  assert.equal(result.inventoryAging.rows[0].stockAgeDays, 121);
  assert.equal(result.inventoryAging.rows[0].expiring, 5);
  assert.equal(result.inventoryAging.rows[0].name, 'Stock Item');
  assert.equal(result.inventoryAging.rows[0].cogs, 33);
  assert.ok(Math.abs(result.inventoryAging.rows[0].turnoverRatio - (33 / 66.5)) < 1e-12);
  assert.equal(result.inventoryAging.rows[0].status, 'نشط');
  assert.equal(result.inventoryAging.rows.find((row) => row.productId === 2).status, 'لم يباع');
  assert.equal(result.inventoryAging.rows.find((row) => row.productId === 3).status, 'راكد');
  assert.equal(result.inventoryTurnover.staleProducts, 1);
  assert.equal(result.inventoryTurnover.cogs, 33);
  assert.equal(result.inventoryTurnover.beginningValue, 104);
  assert.equal(result.inventoryTurnover.averageValue, 87.5);
  assert.equal(result.inventoryTurnover.endingValue, 71);
  assert.ok(Math.abs(result.inventoryTurnover.ratio - (33 / 87.5)) < 1e-12);
  assert.equal(result.shifts.variance, -10);
  assert.equal(result.shifts.rows[0].deposits, 10);
  assert.equal(result.shifts.rows[0].withdrawals, 5);
  assert.equal(result.shifts.rows[0].cashSales, 50);
  assert.equal(result.shifts.rows[0].cashCollections, 20);
  assert.equal(result.shifts.rows[0].cashSupplierPayments, 5);
  assert.equal(result.shifts.rows[0].cashExpenses, 8);
  assert.equal(result.shifts.rows[0].cashRefunds, 10);
  assert.equal(result.shifts.rows[0].calculatedCash, 102);
  assert.equal(result.banks[0].debit, 100);
  assert.equal(result.banks[0].credit, 30);
  assert.equal(result.cashAccounts[0].balance, 150);
  assert.equal(result.cashAccounts[0].debit, 80);
  assert.equal(result.cashAccounts[0].credit, 20);
  assert.equal(result.taxes.netOutputTax, 18);
  assert.equal(result.attendance.records, 2);
  assert.equal(result.attendance.hours, 14);
});


test('linked payment and return filters inherit missing branch and party IDs from their source document', () => {
  const parent = { id: 41, branchId: 3, customerId: 8, supplierId: 12 };
  assert.equal(matchesOperationalLinkedRecord({ orderId: 41 }, parent, {
    branchFilter: '3', partyFilter: '8', partyField: 'customerId',
  }), true);
  assert.equal(matchesOperationalLinkedRecord({ purchaseId: 41 }, parent, {
    branchFilter: '3', partyFilter: '12', partyField: 'supplierId',
  }), true);
  assert.equal(matchesOperationalLinkedRecord({ branchId: 4, customerId: 8 }, parent, {
    branchFilter: '3', partyFilter: '8', partyField: 'customerId',
  }), false);
  assert.equal(matchesOperationalLinkedRecord({ orderId: 999 }, null, {
    branchFilter: '3', partyFilter: '8', partyField: 'customerId',
  }), false);
  assert.equal(matchesOperationalLinkedRecord({ orderId: 41 }, parent, {
    branchFilter: 'all', partyFilter: 'all', partyField: 'customerId',
  }), true);
});

test('inventory aging averages only batches with known dates and reports the unknown-date quantity separately', () => {
  const result = buildOperationalReports({
    startDate: '2026-11-01T00:00:00.000Z',
    endDate: '2026-11-30T23:59:59.999Z',
    products: [{ id: 90, name: 'Mixed-date stock' }],
    inventoryBatches: [
      { id: 'dated', productId: 90, remainingQuantity: 2, costPrice: 10, purchaseDate: '2026-11-01' },
      { id: 'undated', productId: 90, remainingQuantity: 3, costPrice: 10 },
    ],
  });

  const row = result.inventoryAging.rows.find((item) => item.productId === 90);
  assert.equal(row.value, 50);
  assert.equal(row.stockAgeDays, 29, 'unknown-date quantity must not dilute the known-date weighted age');
  assert.equal(row.unknownDateQuantity, 3);
  assert.equal(row.status, 'عمر غير مكتمل', 'mixed-date stock must remain visibly qualified');
  assert.equal(result.inventoryAging.buckets['0-30 يوم'], 20);
  assert.equal(result.inventoryAging.buckets['تاريخ غير معروف'], 30);
});

test('staff performance resolves employee IDs and usernames to one employee row', () => {
  const result = buildOperationalReports({
    startDate: '2026-11-01T00:00:00.000Z',
    endDate: '2026-11-30T23:59:59.999Z',
    employees: [{ id: 12, username: 'cashier01', name: 'Cashier One' }],
    orders: [
      { id: 'staff-sale-1', createdAt: '2026-11-10', createdBy: '12', netAmount: 120, taxAmount: 20 },
      { id: 'staff-sale-2', createdAt: '2026-11-11', createdBy: 'cashier01', netAmount: 60, taxAmount: 10 },
      { id: 'staff-sale-3', createdAt: '2026-11-12', createdBy: 'Legacy Cashier', netAmount: 30, taxAmount: 0 },
    ],
    returns: [
      { id: 'staff-return', originalOrderId: 'staff-sale-1', createdAt: '2026-11-13', totalRefund: 12, taxAmount: 2 },
    ],
  });

  assert.equal(result.staff.length, 2);
  const employee = result.staff.find((row) => row.name === 'Cashier One');
  assert.equal(employee.count, 2);
  assert.equal(employee.orderCount, 2);
  assert.equal(employee.sales, 150);
  assert.equal(employee.returns, 10);
  assert.equal(employee.netSales, 140);
  assert.equal(result.staff.find((row) => row.name === 'Legacy Cashier').count, 1);
});

test('purchase returns in the selected period remain visible when the original purchase predates the period', () => {
  const result = buildOperationalReports({
    startDate: '2026-11-01T00:00:00.000Z',
    endDate: '2026-11-30T23:59:59.999Z',
    purchases: [{ id: 'older-purchase', supplierId: 31, supplierName: 'Legacy Supplier', date: '2026-10-15', totalAmount: 500, paidAmount: 500 }],
    purchaseItems: [{ purchaseId: 'older-purchase', productId: 44, productName: 'Returned Cartons', quantity: 5, conversionFactor: 12, landedCostPerBaseUnit: 4, total: 240 }],
    purchaseReturns: [{ id: 'period-return', originalPurchaseId: 'older-purchase', supplierId: 31, supplierName: 'Legacy Supplier', createdAt: '2026-11-12', totalReturn: 96 }],
    purchaseReturnItems: [{ purchaseReturnId: 'period-return', productId: 44, productName: 'Returned Cartons', quantity: 24, costPrice: 4, total: 96, batchId: 'original-batch' }],
  });

  assert.equal(result.purchases.count, 0, 'the original purchase must not be counted as a current-period purchase');
  assert.equal(result.purchases.returns, 96);
  assert.equal(result.purchaseProducts.length, 1);
  assert.equal(result.purchaseProducts[0].quantity, 0);
  assert.equal(result.purchaseProducts[0].returnedQuantity, 24, 'purchase return quantity is stored in base units');
  assert.equal(result.purchaseProducts[0].netQuantity, -24);
  assert.equal(result.purchaseProducts[0].netTotal, -96, 'the return uses its persisted historical batch cost');
  assert.equal(result.suppliers[0].netPurchases, -96);
});

test('inventory aging keeps stale status when some remaining batches have unknown dates', () => {
  const result = buildOperationalReports({
    startDate: '2026-11-01T00:00:00.000Z',
    endDate: '2026-11-30T23:59:59.999Z',
    inventoryBatches: [
      { id: 'old-known', productId: 91, remainingQuantity: 2, costPrice: 10, purchaseDate: '2026-08-01' },
      { id: 'unknown', productId: 91, remainingQuantity: 1, costPrice: 10 },
    ],
  });
  const row = result.inventoryAging.rows.find((item) => item.productId === 91);
  assert.equal(row.stockAgeDays, 121);
  assert.equal(row.unknownDateQuantity, 1);
  assert.equal(row.status, 'راكد', 'known old stock must not lose its stale classification because another batch is undated');
});
