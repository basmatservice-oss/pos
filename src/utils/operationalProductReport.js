import { getImmutableSaleLineCostTotal } from './salesCostSnapshot.js';
/** Build a product-level operational sales report from completed orders and returns. */
export function buildOperationalProductReport({
  orders = [], orderItems = [], returns = [], returnItems = [], products = [],
  startDate, endDate, mode = 'all', selectedProductIds = [],
}) {
  const start = startDate instanceof Date ? startDate.getTime() : new Date(startDate).getTime();
  const end = endDate instanceof Date ? endDate.getTime() : new Date(endDate).getTime();
  const inRange = (value) => {
    const time = new Date(String(value || '')).getTime();
    return Number.isFinite(time) && time >= start && time <= end;
  };
  const validOrders = new Set(orders
    .filter((order) => order.status !== 'void' && inRange(order.createdAt))
    .map((order) => String(order.id)));
  const validReturns = new Set(returns
    .filter((record) => inRange(record.createdAt))
    .map((record) => String(record.id)));
  const productMap = new Map(products.map((product) => [Number(product.id), product]));
  const rows = new Map();

  for (const item of orderItems) {
    const productId = Number(item.productId);
    if (!productId || !validOrders.has(String(item.orderId))) continue;
    const product = productMap.get(productId);
    const row = rows.get(productId) || {
      productId, name: item.productName || product?.name || 'صنف غير معروف',
      itemType: item.itemType || product?.itemType || 'stock',
      quantitySold: 0, quantityReturned: 0, sales: 0, returnedSales: 0, cost: 0, returnedCost: 0, resalableReturnedCost: 0, missingCostSnapshot: false,
    };
    const quantity = Math.max(0, Number(item.quantity || 0));
    row.quantitySold += quantity;
    row.sales += Number(item.total ?? item.subTotal ?? 0) - Number(item.taxAmount || 0);
    const immutableCost = getImmutableSaleLineCostTotal(item);
    if (immutableCost === null) row.missingCostSnapshot = true;
    else row.cost += immutableCost;
    rows.set(productId, row);
  }

  for (const item of returnItems) {
    const productId = Number(item.productId);
    if (!productId || !validReturns.has(String(item.returnId))) continue;
    const product = productMap.get(productId);
    const row = rows.get(productId) || {
      productId,
      name: item.productName || product?.name || 'صنف غير معروف',
      itemType: product?.itemType || 'stock',
      quantitySold: 0, quantityReturned: 0, sales: 0, returnedSales: 0,
      cost: 0, returnedCost: 0, resalableReturnedCost: 0, missingCostSnapshot: false,
    };
    const quantity = Math.max(0, Number(item.quantity || 0));
    const returnAmount = Number(item.total || 0) - Number(item.taxAmount || 0);
    const returnCost = Math.max(0, Number(item.costPrice || 0)) * quantity;
    row.quantityReturned += quantity;
    row.returnedSales += returnAmount;
    row.returnedCost += returnCost;
    // Only resalable goods restore inventory and reverse COGS. Damaged goods
    // reverse revenue but remain a cost/loss; returns may belong to older periods.
    if (item.condition !== 'damaged') row.resalableReturnedCost += returnCost;
    rows.set(productId, row);
  }

  return [...rows.values()]
    .filter((row) => mode !== 'selected' || selectedProductIds.includes(row.productId))
    .map((row) => {
      const netCost = row.cost - row.resalableReturnedCost;
      const netSales = row.sales - row.returnedSales;
      return {
        ...row,
        netQuantity: row.quantitySold - row.quantityReturned,
        netSales,
        netCost,
        profit: row.missingCostSnapshot ? null : netSales - netCost,
      };
    })
    .sort((a, b) => b.netSales - a.netSales);
}
