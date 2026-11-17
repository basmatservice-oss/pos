import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, formatCurrency, formatQuantity } from '../src/utils/numberFormat.js';

test('formats money with comma grouping and two decimal places', () => {
  assert.equal(formatAmount(1000), '1,000.00');
  assert.equal(formatAmount(1234567.5), '1,234,567.50');
  assert.equal(formatAmount(-12.3), '-12.30');
});

test('supports currency labels without changing numeric formatting', () => {
  assert.equal(formatCurrency(1000, 'SDG'), '1,000.00 SDG');
  assert.equal(formatCurrency(1000), '1,000.00');
});

test('formats quantities independently from currency precision', () => {
  assert.equal(formatQuantity(1000), '1,000');
  assert.equal(formatQuantity(1.25), '1.25');
});

test('returns a visible placeholder for invalid values', () => {
  assert.equal(formatAmount(Number.NaN), '—');
  assert.equal(formatQuantity(undefined), '—');
});

test('rejects invalid precision settings', () => {
  assert.throws(() => formatAmount(1, { minimumFractionDigits: 3, maximumFractionDigits: 2 }), RangeError);
  assert.throws(() => formatQuantity(1, { maximumFractionDigits: -1 }), RangeError);
});
