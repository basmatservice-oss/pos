import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUnitDefinition,
  normalizeProductUnit,
  assertCompatibleUnitDimensions,
  assertBaseUnitChangeAllowed,
} from '../src/utils/unitConversion.js';

test('normalizes a fractional mass unit definition', () => {
  assert.deepEqual(normalizeUnitDefinition({
    code: ' KG ', name: 'كيلوجرام', symbol: 'kg', dimension: 'mass', decimalPlaces: 3,
  }), {
    code: 'kg', name: 'كيلوجرام', symbol: 'kg', dimension: 'mass',
    decimalPlaces: 3, isFractional: 1,
  });
});

test('rejects invalid unit codes, dimensions, and precision', () => {
  assert.throws(() => normalizeUnitDefinition({ code: '1kg', name: 'kg', dimension: 'mass' }), TypeError);
  assert.throws(() => normalizeUnitDefinition({ code: 'kg', name: 'kg', dimension: 'unknown' }), TypeError);
  assert.throws(() => normalizeUnitDefinition({ code: 'kg', name: 'kg', dimension: 'mass', decimalPlaces: 7 }), TypeError);
});

test('normalizes valid base and alternate product units', () => {
  assert.equal(normalizeProductUnit({
    productId: 5, unitCode: 'piece', conversionToBase: 1, isBaseUnit: true,
  }).isBaseUnit, 1);
  assert.equal(normalizeProductUnit({
    productId: 5, unitCode: 'carton', conversionToBase: 12, sellingPrice: 120,
  }).conversionToBase, 12);
});

test('rejects non-positive conversion factors and base factors other than one', () => {
  assert.throws(() => normalizeProductUnit({ productId: 5, unitCode: 'piece', conversionToBase: 0 }), TypeError);
  assert.throws(() => normalizeProductUnit({ productId: 5, unitCode: 'piece', conversionToBase: 12, isBaseUnit: true }), RangeError);
});

test('rejects incompatible dimensions', () => {
  assert.throws(() => assertCompatibleUnitDimensions('mass', 'volume'), RangeError);
  assert.doesNotThrow(() => assertCompatibleUnitDimensions('count', 'count'));
});

test('prevents changing a base unit while stock or alternate units depend on it', () => {
  assert.throws(() => assertBaseUnitChangeAllowed({ hasStock: true, hasDependentAlternateUnits: false }), RangeError);
  assert.throws(() => assertBaseUnitChangeAllowed({ hasStock: false, hasDependentAlternateUnits: true }), RangeError);
  assert.doesNotThrow(() => assertBaseUnitChangeAllowed({ hasStock: false, hasDependentAlternateUnits: false }));
});
