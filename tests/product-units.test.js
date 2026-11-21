import test from 'node:test';
import assert from 'node:assert/strict';
import { getProductUnitOptions, findProductBarcodeMatch } from '../src/utils/productUnits.js';

test('keeps a non-count base unit distinct and does not invent a piece alias', () => {
  const units = getProductUnitOptions({
    unit: 'kg', sellingPrice: 20, costPrice: 12, conversionFactor: 1,
  });
  assert.deepEqual(units.map((unit) => unit.name), ['kg']);
});

test('de-duplicates unit names case-insensitively and keeps one legacy box conversion', () => {
  const units = getProductUnitOptions({
    unit: 'piece',
    sellingPrice: 10,
    costPrice: 5,
    conversionFactor: 12,
    unitsJson: JSON.stringify([
      { name: 'Box', conversionFactor: 12, sellingPrice: 100 },
      { name: 'box', conversionFactor: 24, sellingPrice: 180 },
      { name: 'piece', conversionFactor: 1, sellingPrice: 10 },
      { name: 'carton', conversionFactor: 6 },
    ]),
  });
  assert.deepEqual(units.map((unit) => unit.name), ['piece', 'Box', 'carton']);
  assert.equal(units[1].conversionFactor, 12);
  assert.equal(units[2].sellingPrice, 60);
});

test('ignores invalid alternate units without losing the base unit', () => {
  const units = getProductUnitOptions({
    unit: 'liter', sellingPrice: 8,
    unitsJson: JSON.stringify([
      { name: 'bad', conversionFactor: 0 },
      { name: 'also-bad', conversionFactor: 'NaN' },
    ]),
  });
  assert.deepEqual(units.map((unit) => unit.name), ['liter']);
});

test('resolves a scanned alternate-unit barcode to its parent product and unit', () => {
  const product = {
    id: 9, barcode: 'BASE-9', unit: 'piece', sellingPrice: 10, costPrice: 5,
    unitsJson: JSON.stringify([{ name: 'carton', barcode: 'CARTON-9', conversionFactor: 12, sellingPrice: 110 }]),
  };
  assert.deepEqual(findProductBarcodeMatch([product], 'BASE-9'), { product });
  const match = findProductBarcodeMatch([product], 'CARTON-9');
  assert.equal(match.product.id, 9);
  assert.equal(match.matchedUnit.name, 'carton');
  assert.equal(match.matchedUnit.conversionFactor, 12);
});
