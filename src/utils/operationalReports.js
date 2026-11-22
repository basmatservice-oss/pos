const amount = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};
const inRange = (value, start, end) => {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime();
};
const groupBy = (rows, keyOf, makeRow) => {
  const map = new Map();
  for (const source of rows) {
    const key = String(keyOf(source) || 'غير محدد');
    const row = map.get(key) || makeRow(source, key);
    row.count += 1;
    map.set(key, row);
  }
  return map;
};

/** Build operational reports from persisted business documents without recalculating historical costs. */
export function buildOperationalReports({
  startDate, endDate, orders = [], returns = [], purchases = [], purchaseItems = [], purchaseReturns = [], purchaseReturnItems = [],
  expenses = [], payrolls = [], employees = [], customers = [], suppliers = [],
  customerPayments = [], supplierPayments = [], inventoryMovements = [],
}) {
  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  const sales = orders.filter((row) => row.status !== 'void' && inRange(row.createdAt, start, end));
  const salesReturns = returns.filter((row) => inRange(row.createdAt, start, end));
  const buys = purchases.filter((row) => inRange(row.date || row.createdAt, start, end));
  const buyReturns = purchaseReturns.filter((row) => inRange(row.createdAt, start, end));
  const purchaseIds = new Set(buys.map((row) => String(row.id)));
  const purchaseReturnIds = new Set(buyReturns.map((row) => String(row.id)));
  const purchaseProductGroups = new Map();
  for (const item of purchaseItems) {
    if (!purchaseIds.has(String(item.purchaseId))) continue;
    const key = String(item.productId);
    const factor = amount(item.conversionToBase ?? item.conversionFactor ?? 1);
    const quantity = amount(item.baseQuantity ?? amount(item.quantity) * (factor > 0 ? factor : 1));
    const row = purchaseProductGroups.get(key) || {
      productId: item.productId, name: item.productName || 'صنف غير معروف',
      quantity: 0, returnedQuantity: 0, total: 0, returnedTotal: 0,
    };
    row.quantity += quantity;
    row.total += amount(item.total ?? item.originalTotal);
    purchaseProductGroups.set(key, row);
  }
  for (const item of purchaseReturnItems) {
    if (!purchaseReturnIds.has(String(item.purchaseReturnId))) continue;
    const key = String(item.productId);
    const row = purchaseProductGroups.get(key) || {
      productId: item.productId, name: item.productName || 'صنف غير معروف',
      quantity: 0, returnedQuantity: 0, total: 0, returnedTotal: 0,
    };
    row.returnedQuantity += amount(item.quantity);
    row.returnedTotal += amount(item.total);
    purchaseProductGroups.set(key, row);
  }
  const purchaseProductRows = [...purchaseProductGroups.values()]
    .map((row) => ({ ...row, netQuantity: row.quantity - row.returnedQuantity, netTotal: row.total - row.returnedTotal }))
    .sort((a, b) => b.netTotal - a.netTotal);
  const periodExpenses = expenses.filter((row) => inRange(row.date || row.createdAt, start, end));
  const periodPayroll = payrolls.filter((row) => inRange(row.paymentDate, start, end));
  const periodCustomerPayments = customerPayments.filter((row) => inRange(row.createdAt, start, end));
  const periodSupplierPayments = supplierPayments.filter((row) => inRange(row.createdAt, start, end));
  const movements = inventoryMovements.filter((row) => inRange(row.createdAt, start, end));

  const paymentTotals = { cash: 0, card: 0, credit: 0, mixed: 0, returnsCash: 0, returnsCard: 0, returnsCredit: 0 };
  for (const order of sales) {
    const total = amount(order.netAmount);
    if (order.paymentMethod === 'mixed') {
      paymentTotals.cash += amount(order.cashAmount);
      paymentTotals.card += amount(order.cardAmount);
      paymentTotals.mixed += Math.max(0, total - amount(order.cashAmount) - amount(order.cardAmount));
    } else if (Object.hasOwn(paymentTotals, order.paymentMethod)) paymentTotals[order.paymentMethod] += total;
  }
  for (const record of salesReturns) {
    const key = record.refundMethod === 'credit_adjustment' ? 'returnsCredit' : record.refundMethod === 'card' ? 'returnsCard' : 'returnsCash';
    paymentTotals[key] += amount(record.totalRefund);
  }
  paymentTotals.cashNet = paymentTotals.cash - paymentTotals.returnsCash;
  paymentTotals.cardNet = paymentTotals.card - paymentTotals.returnsCard;
  paymentTotals.creditNet = paymentTotals.credit - paymentTotals.returnsCredit;

  const staff = groupBy(sales, (row) => row.createdBy || 'غير محدد', (row, key) => ({
    name: key, count: 0, sales: 0, returns: 0, orderCount: 0,
  }));
  for (const [key, row] of staff) row.sales = sales.filter((sale) => String(sale.createdBy || 'غير محدد') === key)
    .reduce((sum, sale) => sum + amount(sale.netAmount) - amount(sale.taxAmount), 0);
  for (const record of salesReturns) {
    const order = orders.find((item) => String(item.id) === String(record.originalOrderId));
    if (!order) continue;
    const key = String(order.createdBy || 'غير محدد');
    const row = staff.get(key);
    if (row) row.returns += amount(record.totalRefund) - amount(record.taxAmount);
  }
  const staffRows = [...staff.values()].map((row) => ({ ...row, netSales: row.sales - row.returns }))
    .sort((a, b) => b.netSales - a.netSales);

  const customerMap = new Map(customers.map((row) => [String(row.id), row]));
  const customerGroups = new Map();
  for (const order of sales.filter((row) => row.customerId != null)) {
    const key = String(order.customerId);
    const customer = customerMap.get(key);
    const row = customerGroups.get(key) || { id: order.customerId, name: customer?.name || order.customerName || 'عميل', orders: 0, sales: 0, paid: 0 };
    row.orders += 1;
    row.sales += amount(order.netAmount);
    row.paid += amount(order.paidAmount);
    customerGroups.set(key, row);
  }
  for (const record of salesReturns) {
    const order = orders.find((row) => String(row.id) === String(record.originalOrderId));
    if (!order?.customerId) continue;
    const row = customerGroups.get(String(order.customerId));
    if (row) row.returns = (row.returns || 0) + amount(record.totalRefund);
  }
  const customerRows = [...customerGroups.values()]
    .map((row) => ({ ...row, returns: row.returns || 0, netSales: row.sales - (row.returns || 0) }))
    .sort((a, b) => b.netSales - a.netSales);

  const supplierGroups = new Map();
  for (const purchase of buys) {
    const key = String(purchase.supplierId ?? purchase.supplierName ?? 'غير محدد');
    const row = supplierGroups.get(key) || { id: purchase.supplierId, name: purchase.supplierName || 'مورد', invoices: 0, purchases: 0, paid: 0, returned: 0 };
    row.invoices += 1;
    row.purchases += amount(purchase.totalAmount);
    row.paid += amount(purchase.paidAmount);
    supplierGroups.set(key, row);
  }
  for (const record of buyReturns) {
    const key = String(record.supplierId ?? record.supplierName ?? 'غير محدد');
    const row = supplierGroups.get(key) || { id: record.supplierId, name: record.supplierName || 'مورد', invoices: 0, purchases: 0, paid: 0, returned: 0 };
    row.returned += amount(record.totalReturn);
    supplierGroups.set(key, row);
  }
  const supplierRows = [...supplierGroups.values()].map((row) => ({ ...row, netPurchases: row.purchases - row.returned }))
    .sort((a, b) => b.netPurchases - a.netPurchases);

  const expenseGroups = new Map();
  for (const expense of periodExpenses) {
    const key = String(expense.category || 'غير مصنف');
    expenseGroups.set(key, (expenseGroups.get(key) || 0) + amount(expense.amount));
  }
  const expenseRows = [...expenseGroups.entries()].map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  const movementGroups = new Map();
  for (const movement of movements) {
    const key = String(movement.movementType || movement.sourceType || 'حركة أخرى');
    const row = movementGroups.get(key) || { type: key, count: 0, quantityIn: 0, quantityOut: 0, netQuantity: 0, value: 0 };
    const delta = amount(movement.quantityDeltaBase);
    row.count += 1;
    if (delta > 0) row.quantityIn += delta;
    if (delta < 0) row.quantityOut += Math.abs(delta);
    row.netQuantity += delta;
    row.value += amount(movement.totalCost);
    movementGroups.set(key, row);
  }

  return {
    sales: { count: sales.length, gross: sales.reduce((sum, row) => sum + amount(row.netAmount), 0),
      netExTax: sales.reduce((sum, row) => sum + amount(row.netAmount) - amount(row.taxAmount), 0),
      returns: salesReturns.reduce((sum, row) => sum + amount(row.totalRefund), 0) },
    purchases: { count: buys.length, gross: buys.reduce((sum, row) => sum + amount(row.totalAmount), 0),
      paid: buys.reduce((sum, row) => sum + amount(row.paidAmount), 0),
      returns: buyReturns.reduce((sum, row) => sum + amount(row.totalReturn), 0) },
    payments: paymentTotals,
    staff: staffRows,
    customers: customerRows,
    suppliers: supplierRows,
    purchaseProducts: purchaseProductRows,
    expenses: expenseRows,
    payroll: { count: periodPayroll.length, total: periodPayroll.reduce((sum, row) => sum + amount(row.netSalary), 0) },
    customerCollections: periodCustomerPayments.reduce((sum, row) => sum + amount(row.amount), 0),
    supplierPayments: periodSupplierPayments.reduce((sum, row) => sum + amount(row.amount), 0),
    inventory: [...movementGroups.values()].sort((a, b) => b.count - a.count),
    employeePayroll: employees.map((employee) => ({ name: employee.name,
      total: periodPayroll.filter((row) => String(row.employeeId) === String(employee.id))
        .reduce((sum, row) => sum + amount(row.netSalary), 0) }))
      .filter((row) => row.total > 0).sort((a, b) => b.total - a.total),
  };
}
