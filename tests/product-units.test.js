import test from 'node:test';
import assert from 'node:assert/strict';
import { getProductUnitOptions } from '../src/utils/productUnits.js';

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
