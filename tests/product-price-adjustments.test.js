import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAdjustedSellingPrice, buildManualSellingPriceUpdate } from '../src/utils/productPriceAdjustments.js';

test('calculates percentage and fixed selling-price changes with two-decimal rounding', () => {
  assert.equal(calculateAdjustedSellingPrice(100, 'percent_increase', 12.5), 112.5);
  assert.equal(calculateAdjustedSellingPrice(100, 'percent_decrease', 12.5), 87.5);
  assert.equal(calculateAdjustedSellingPrice(100, 'amount_increase', 2.25), 102.25);
  assert.equal(calculateAdjustedSellingPrice(100, 'amount_decrease', 2.25), 97.75);
  assert.equal(calculateAdjustedSellingPrice(100, 'set', 33.333), 33.33);
});

test('rejects negative results, non-finite values and unknown modes', () => {
  assert.throws(() => calculateAdjustedSellingPrice(10, 'amount_decrease', 11));
  assert.throws(() => calculateAdjustedSellingPrice(10, 'percent_decrease', 101));
  assert.throws(() => calculateAdjustedSellingPrice(10, 'set', NaN));
  assert.throws(() => calculateAdjustedSellingPrice(-1, 'set', 1));
  assert.throws(() => calculateAdjustedSellingPrice(10, 'unknown', 1));
});

test('manual price override unlinks FX anchor without mutating historical product data', () => {
  const original = { id: 5, sellingPrice: 100, priceInUSD: 2, costPrice: 70, costInUSD: 1.4,
    unitsJson: '[{"name":"carton","conversionFactor":12,"sellingPrice":110}]' };
  const updated = buildManualSellingPriceUpdate(original, 125, '2026-11-26T00:00:00.000Z');
  assert.equal(updated.sellingPrice, 125);
  assert.equal(updated.priceInUSD, 0);
  assert.equal(updated.costPrice, 70);
  assert.equal(updated.costInUSD, 1.4);
  assert.equal(updated.unitsJson, original.unitsJson);
  assert.equal(original.sellingPrice, 100);
});
