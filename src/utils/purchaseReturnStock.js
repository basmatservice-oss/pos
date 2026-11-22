/**
 * Reserve stock for one purchase-return line while accounting for earlier
 * lines in the same request. The caller owns transaction rollback on false.
 */
export function reservePurchaseReturnStock(
  availableByProduct: Map<number, number>,
  productId: number,
  snapshotStock: unknown,
  requestedQuantity: number,
): boolean {
  const available = availableByProduct.has(productId)
    ? Number(availableByProduct.get(productId))
    : Number(snapshotStock || 0);
  if (!Number.isFinite(available) || !Number.isFinite(requestedQuantity) ||
      requestedQuantity <= 0 || available + 0.0001 < requestedQuantity) return false;
  availableByProduct.set(productId, Math.round((available - requestedQuantity) * 10000) / 10000);
  return true;
}
