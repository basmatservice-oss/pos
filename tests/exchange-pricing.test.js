import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toForeignPriceAnchor, fromForeignPriceAnchor, buildProductPricingAnchors,
  repriceLinkedProduct, getFxLinkedProductCount,
} from '../src/utils/exchangePricing.js';

test('stores a foreign-currency anchor from an SDG-entered price', () => {
  assert.equal(toForeignPriceAnchor(120000, 600), 200);
  assert.deepEqual(buildProductPricingAnchors({
    costPrice: 60000, sellingPrice: 120000, costLinked: true, sellingLinked: false, exchangeRate: 600,
  }), { costInUSD: 100, priceInUSD: 0 });
});

test('exchange-rate approval updates only linked current product prices', () => {
  const product = {
    id: 4, costPrice: 60000, sellingPrice: 120000,
    costInUSD: 100, priceInUSD: 200,
    unitsJson: JSON.stringify([
      { name: 'carton', conversionFactor: 12, sellingPrice: 130000, priceInUSD: 220 },
      { name: 'piece', conversionFactor: 1, sellingPrice: 10000 },
    ]),
  };
  const updated = repriceLinkedProduct(product, 700);
  assert.equal(updated.costPrice, 70000);
  assert.equal(updated.sellingPrice, 140000);
  const units = JSON.parse(updated.unitsJson);
  assert.equal(units[0].sellingPrice, 154000);
  assert.equal(units[1].sellingPrice, 10000);
  assert.equal(product.sellingPrice, 120000);
});

test('manual local prices stay fixed when the exchange rate changes', () => {
  const product = { id: 8, costPrice: 50, sellingPrice: 100, costInUSD: 0, priceInUSD: 0 };
  const updated = repriceLinkedProduct(product, 900);
  assert.equal(updated.costPrice, 50);
  assert.equal(updated.sellingPrice, 100);
  assert.equal(getFxLinkedProductCount([product, { priceInUSD: 2 }]), 1);
});

test('rejects missing or invalid exchange rates when creating a linked price', () => {
  assert.throws(() => toForeignPriceAnchor(100, 0), /سعر صرف صحيح/);
  assert.equal(fromForeignPriceAnchor(25, 800), 20000);
});
