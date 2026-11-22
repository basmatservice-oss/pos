import test from 'node:test';
import assert from 'node:assert/strict';
import { reservePurchaseReturnStock } from '../src/utils/purchaseReturnStock.js';

test('purchase return stock reservations accumulate repeated lines for the same product', () => {
  const reserved = new Map();
  assert.equal(reservePurchaseReturnStock(reserved, 7, 10, 6), true);
  assert.equal(reserved.get(7), 4);
  assert.equal(reservePurchaseReturnStock(reserved, 7, 10, 3), true);
  assert.equal(reserved.get(7), 1);
  assert.equal(reservePurchaseReturnStock(reserved, 7, 10, 2), false);
  assert.equal(reserved.get(7), 1, 'a rejected line must not mutate the reservation');
});

test('purchase return stock reservation rejects invalid and negative quantities', () => {
  const reserved = new Map();
  assert.equal(reservePurchaseReturnStock(reserved, 1, 5, 0), false);
  assert.equal(reservePurchaseReturnStock(reserved, 1, 5, -1), false);
  assert.equal(reservePurchaseReturnStock(reserved, 1, Number.NaN, 1), false);
  assert.equal(reserved.size, 0);
});
