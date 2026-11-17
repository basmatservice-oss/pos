export type UnitDimension = 'count' | 'mass' | 'volume' | 'length' | 'area' | 'time' | 'service';

const UNIT_DIMENSIONS = new Set<UnitDimension>(['count', 'mass', 'volume', 'length', 'area', 'time', 'service']);

export function normalizeUnitDefinition(input: any) {
  const code = String(input?.code || '').trim().toLowerCase();
  const name = String(input?.name || '').trim();
  const symbol = input?.symbol == null ? null : String(input.symbol).trim() || null;
  const dimension = String(input?.dimension || '').trim().toLowerCase() as UnitDimension;
  const decimalPlaces = Number(input?.decimalPlaces ?? 0);
  if (!/^[a-z][a-z0-9_-]{0,19}$/.test(code) || !name || !UNIT_DIMENSIONS.has(dimension) ||
      !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) {
    throw new TypeError('Invalid unit definition');
  }
  return { code, name, symbol, dimension, decimalPlaces, isFractional: decimalPlaces > 0 ? 1 : 0 };
}

export function normalizeProductUnit(input: any) {
  const productId = Number(input?.productId);
  const unitCode = String(input?.unitCode || '').trim().toLowerCase();
  const conversionToBase = Number(input?.conversionToBase);
  const isBaseUnit = input?.isBaseUnit === true || input?.isBaseUnit === 1;
  const sellingPrice = input?.sellingPrice == null || input.sellingPrice === '' ? null : Number(input.sellingPrice);
  const barcode = input?.barcode == null ? null : String(input.barcode).trim() || null;
  if (!Number.isSafeInteger(productId) || productId <= 0 || !/^[a-z][a-z0-9_-]{0,19}$/.test(unitCode) ||
      !Number.isFinite(conversionToBase) || conversionToBase <= 0 ||
      (sellingPrice !== null && (!Number.isFinite(sellingPrice) || sellingPrice < 0))) {
    throw new TypeError('Invalid product unit');
  }
  if (isBaseUnit && Math.abs(conversionToBase - 1) > 1e-10) {
    throw new RangeError('Base unit conversion factor must equal 1');
  }
  return { productId, unitCode, conversionToBase, isBaseUnit: isBaseUnit ? 1 : 0, sellingPrice, barcode };
}

export function assertCompatibleUnitDimensions(baseDimension: string, alternateDimension: string) {
  if (baseDimension !== alternateDimension) {
    throw new RangeError('Cannot convert between different unit dimensions');
  }
}

export function assertBaseUnitChangeAllowed(input: {
  hasStock: boolean;
  hasDependentAlternateUnits: boolean;
}) {
  if (input.hasStock) throw new RangeError('Cannot change base unit while stock exists');
  if (input.hasDependentAlternateUnits) throw new RangeError('Cannot change base unit while alternate units exist');
}
