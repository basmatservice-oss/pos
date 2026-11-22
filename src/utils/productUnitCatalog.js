/**
 * Canonical, deterministic representation of legacy Product.unitsJson entries.
 * ProductUnit + UnitDefinition become the normalized catalog; unitsJson remains
 * a compatibility payload during the staged rollout and for old clients.
 */
export function normalizeUnitCode(name, dimension = 'legacy') {
  const normalized = String(name || '').trim().toLocaleLowerCase();
  const scope = String(dimension || 'legacy').trim().toLocaleLowerCase();
  if (!normalized) return '';
  const encode = (value) => Array.from(value).map((char) => char.codePointAt(0).toString(16)).join('_');
  return `u_${encode(scope)}__${encode(normalized)}`;
}

export function buildCanonicalProductUnits(product = {}) {
  const productId = Number(product.id);
  if (!Number.isSafeInteger(productId) || productId <= 0) return { definitions: [], units: [] };
  const dimension = String(product.baseUnitCode || 'legacy').trim() || 'legacy';
  const now = product.updatedAt || new Date().toISOString();
  const definitions = new Map();
  const units = new Map();
  const add = (source, isBase = false) => {
    const name = String(source?.name || '').trim();
    const conversionToBase = isBase ? 1 : Number(source?.conversionFactor);
    if (!name || !Number.isFinite(conversionToBase) || conversionToBase <= 0) return;
    const unitCode = normalizeUnitCode(name, dimension);
    if (!unitCode) return;
    definitions.set(unitCode, {
      code: unitCode, name, symbol: source?.symbol ? String(source.symbol) : null,
      dimension, decimalPlaces: Number.isInteger(Number(source?.decimalPlaces)) ? Number(source.decimalPlaces) : (source?.allowFractions ? 3 : 0),
      isFractional: source?.allowFractions ? 1 : 0, isSystem: isBase ? 1 : 0,
      isSynced: 0, createdAt: now, updatedAt: now,
    });
    units.set(unitCode, {
      id: `product-${productId}-${unitCode}`, productId, unitCode,
      conversionToBase,
      isBaseUnit: isBase ? 1 : 0,
      sellingPrice: Number.isFinite(Number(source?.sellingPrice)) ? Number(source.sellingPrice) : (isBase ? Number(product.sellingPrice || 0) : null),
      costPrice: Number.isFinite(Number(source?.costPrice)) ? Number(source.costPrice) : (isBase ? Number(product.costPrice || 0) : null),
      priceInUSD: Number.isFinite(Number(source?.priceInUSD)) ? Number(source.priceInUSD) : 0,
      barcode: source?.barcode ? String(source.barcode).trim() : (isBase ? (product.barcode || null) : null),
      allowFractions: source?.allowFractions ? 1 : 0,
      isSynced: 0, createdAt: now, updatedAt: now,
    });
  };
  add({
    name: product.unit || 'piece',
    sellingPrice: product.sellingPrice,
    costPrice: product.costPrice,
    barcode: product.barcode,
    allowFractions: Boolean(product.allowFractions),
  }, true);
  if (product.unitsJson) {
    try {
      const parsed = JSON.parse(product.unitsJson);
      if (Array.isArray(parsed)) parsed.forEach((unit) => add(unit, false));
    } catch {
      // Never destroy or reinterpret malformed legacy JSON; base unit still migrates.
    }
  }
  const legacyFactor = Number(product.conversionFactor || 1);
  if (legacyFactor > 1 && !Array.from(units.values()).some((unit) =>
    definitions.get(unit.unitCode)?.name.toLocaleLowerCase() === 'box'
  )) add({ name: 'box', conversionFactor: legacyFactor, sellingPrice: Number(product.sellingPrice || 0) * legacyFactor,
    costPrice: Number(product.costPrice || 0) * legacyFactor }, false);
  return { definitions: Array.from(definitions.values()), units: Array.from(units.values()) };
}
