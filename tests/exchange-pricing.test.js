import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toForeignPriceAnchor, fromForeignPriceAnchor, buildProductPricingAnchors,
  repriceLinkedProduct, getFxLinkedProductCount, buildProductUnitFxAnchors,
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

test('links alternate sellable-unit prices to the same approved exchange rate', () => {
  const units = buildProductUnitFxAnchors([
    { name: 'carton', sellingPrice: 120000, conversionFactor: 12 },
    { name: 'half-carton', sellingPrice: 65000, conversionFactor: 6 },
  ], true, 600);
  assert.equal(units[0].priceInUSD, 200);
  assert.equal(units[1].priceInUSD, 108.333333);
  const fixed = buildProductUnitFxAnchors([{ name: 'carton', sellingPrice: 120000 }], false, 600);
  assert.equal(fixed[0].priceInUSD, 0);
});

test('repricing a current product cannot mutate a previously issued sale snapshot', () => {
  const oldSaleLine = { productId: 3, unitPrice: 100000, costPriceAtTimeOfSale: 70000, total: 100000 };
  const currentProduct = { id: 3, sellingPrice: 100000, costPrice: 70000, priceInUSD: 200, costInUSD: 140 };
  const repriced = repriceLinkedProduct(currentProduct, 750);
  assert.equal(repriced.sellingPrice, 150000);
  assert.equal(repriced.costPrice, 105000);
  assert.deepEqual(oldSaleLine, { productId: 3, unitPrice: 100000, costPriceAtTimeOfSale: 70000, total: 100000 });
});

test('historical COGS uses saved snapshots or complete FIFO allocations only', async () => {
  const { getImmutableSaleLineCostTotal } = await import('../src/utils/salesCostSnapshot.js');
  assert.equal(getImmutableSaleLineCostTotal({ quantity: 2, conversionFactor: 1, batchAllocations: '[]' }), null);
  assert.equal(getImmutableSaleLineCostTotal({ quantity: 2, conversionFactor: 1, batchAllocations: JSON.stringify([{ quantity: 1, costPrice: 5 }]) }), null);
  assert.equal(getImmutableSaleLineCostTotal({ quantity: 2, conversionFactor: 1, batchAllocations: JSON.stringify([{ quantity: 2, costPrice: 5 }]) }), 10);
  assert.equal(getImmutableSaleLineCostTotal({ quantity: 2, itemType: 'service', batchAllocations: JSON.stringify({ kind: 'service' }) }), 0);
  assert.equal(getImmutableSaleLineCostTotal({ quantity: 2, costPriceAtTimeOfSale: 7 }), 14);
});
