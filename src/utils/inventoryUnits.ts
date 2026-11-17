/**
 * Historical unit helpers for reports.
 *
 * New movement rows keep both the entered quantity and the converted base
 * quantity. Older rows are interpreted with their recorded legacy conversion
 * factor, falling back to the product's legacy box factor when necessary.
 */
export function getHistoricalBaseQuantity(item: any, product?: any): number {
  const quantity = Number(item?.quantity ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;

  if (item?.baseQuantity !== null && item?.baseQuantity !== undefined) {
    const stored = Number(item.baseQuantity);
    if (Number.isFinite(stored) && stored > 0) return stored;
  }

  const legacyUnit = String(item?.unit || item?.selectedUnit || '');
  const storedFactor = Number(item?.conversionFactor);
  const productFactor = Number(product?.conversionFactor);
  // Older OrderItem rows defaulted conversionFactor to 1 even when the product
  // was sold by box. Prefer a meaningful recorded factor, then the product's
  // legacy box factor when the line only contains that schema default.
  const legacyFactor = legacyUnit === 'box'
    ? (Number.isFinite(storedFactor) && storedFactor > 1
        ? storedFactor
        : Number.isFinite(productFactor) && productFactor > 1
          ? productFactor
          : Number.isFinite(storedFactor) && storedFactor > 0 ? storedFactor : 1)
    : Number.isFinite(storedFactor) && storedFactor > 0 ? storedFactor : 1;
  const factor = Number(item?.conversionToBase ?? legacyFactor);
  return quantity * (Number.isFinite(factor) && factor > 0 ? factor : 1);
}

/**
 * COGS snapshots are stored per entered sale unit. When a historical snapshot
 * is absent, the product cost is per base unit and must be multiplied by the
 * converted base quantity rather than the entered quantity.
 */
export function getHistoricalCostAmount(item: any, product?: any): number {
  const quantity = Number(item?.quantity ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;

  const snapshot = item?.costPriceAtTimeOfSale;
  if (snapshot !== null && snapshot !== undefined) {
    const unitCost = Number(snapshot);
    if (Number.isFinite(unitCost) && unitCost >= 0) return unitCost * quantity;
  }

  const baseUnitCost = Number(product?.costPrice ?? 0);
  return Number.isFinite(baseUnitCost) && baseUnitCost >= 0
    ? baseUnitCost * getHistoricalBaseQuantity(item, product)
    : 0;
}
