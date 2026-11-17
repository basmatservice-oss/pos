import test from 'node:test';
import assert from 'node:assert/strict';
import { getBasePerDocumentUnit } from '../src/utils/currencyConversion.js';

test('uses a direct document-to-base rate as the conversion factor', () => {
  assert.equal(getBasePerDocumentUnit({ baseCurrencyCode: 'USD', quoteCurrencyCode: 'SDG', rate: 600 }, 'USD', 'SDG'), 600);
});

test('inverts a base-to-document rate to obtain document-to-base factor', () => {
  assert.equal(getBasePerDocumentUnit({ baseCurrencyCode: 'SDG', quoteCurrencyCode: 'USD', rate: 1 / 600 }, 'USD', 'SDG'), 600);
});

test('rejects a non-positive or non-finite rate', () => {
  assert.throws(() => getBasePerDocumentUnit({ baseCurrencyCode: 'USD', quoteCurrencyCode: 'SDG', rate: 0 }, 'USD', 'SDG'), RangeError);
  assert.throws(() => getBasePerDocumentUnit({ baseCurrencyCode: 'USD', quoteCurrencyCode: 'SDG', rate: Infinity }, 'USD', 'SDG'), RangeError);
});

test('rejects a rate for a different currency pair', () => {
  assert.throws(() => getBasePerDocumentUnit({ baseCurrencyCode: 'EUR', quoteCurrencyCode: 'SDG', rate: 700 }, 'USD', 'SDG'), RangeError);
});
