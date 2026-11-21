/**
 * Build the selectable units for one product from its current persisted unit data.
 * Unit names are de-duplicated case-insensitively and the product's base unit is
 * never silently aliased to "piece" (which caused mass/volume items to appear countable).
 */
export function getProductUnitOptions(product = {}) {
  const baseUnitName = String(product.unit || 'piece').trim() || 'piece';
  const base = {
    name: baseUnitName,
    barcode: product.barcode,
    conversionFactor: 1,
    sellingPrice: Number(product.sellingPrice || 0),
    costPrice: Number(product.costPrice || 0),
    allowFractions: Boolean(product.allowFractions),
  };

  const units = [base];
  const seen = new Set([baseUnitName.toLocaleLowerCase()]);
  const addUnit = (unit) => {
    const name = String(unit?.name || '').trim();
    const key = name.toLocaleLowerCase();
    const factor = Number(unit?.conversionFactor);
    if (!name || seen.has(key) || !Number.isFinite(factor) || factor <= 0) return;
    const sellingPrice = unit.sellingPrice == null
      ? Number(product.sellingPrice || 0) * factor
      : Number(unit.sellingPrice);
    const costPrice = unit.costPrice == null
      ? undefined
      : Number(unit.costPrice);
    if (!Number.isFinite(sellingPrice) || (costPrice !== undefined && !Number.isFinite(costPrice))) return;
    seen.add(key);
    units.push({
      name,
      barcode: unit.barcode ? String(unit.barcode) : undefined,
      conversionFactor: factor,
      sellingPrice,
      costPrice,
      allowFractions: Boolean(unit.allowFractions),
    });
  };

  if (product.unitsJson) {
    try {
      const parsed = JSON.parse(product.unitsJson);
      if (Array.isArray(parsed)) parsed.forEach(addUnit);
    } catch {
      // Ignore malformed legacy unit metadata; the base unit remains usable.
    }
  }

  // Preserve the historical box conversion only when no explicit box exists.
  const legacyBoxFactor = Number(product.conversionFactor || 1);
  if (legacyBoxFactor > 1 && !seen.has('box')) {
    addUnit({
      name: 'box',
      conversionFactor: legacyBoxFactor,
      sellingPrice: Number(product.sellingPrice || 0) * legacyBoxFactor,
      costPrice: Number(product.costPrice || 0) * legacyBoxFactor,
      allowFractions: false,
    });
  }

  return units;
}

/** Resolve a scanned code against both the product barcode and its sellable unit barcodes. */
export function findProductBarcodeMatch(products = [], barcode) {
  const code = String(barcode || '').trim();
  if (!code) return undefined;
  for (const product of products) {
    if (String(product?.barcode || '').trim() === code) return { product };
    const matchedUnit = getProductUnitOptions(product).find((unit) => String(unit.barcode || '').trim() === code);
    if (matchedUnit) return { product, matchedUnit };
  }
  return undefined;
}
