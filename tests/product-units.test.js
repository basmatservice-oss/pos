import test from 'node:test';
import assert from 'node:assert/strict';
import { getProductUnitOptions, findProductBarcodeMatch } from '../src/utils/productUnits.js';
import { useCartStore, getItemPrice, getItemUnitFactor } from '../src/store/useCartStore.ts';

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

test('adds a scanned carton as a distinct POS line with correct price and stock conversion', () => {
  const product = {
    id: 21, barcode: 'PIECE-21', name: 'منتج تجريبي', categoryId: 1,
    costPrice: 5, sellingPrice: 10, stockQuantity: 120, unit: 'piece',
    conversionFactor: 1, vatRate: 0, syncStatus: 'synced', updatedAt: '2026-11-21T00:00:00.000Z',
    unitsJson: JSON.stringify([{ name: 'carton', barcode: 'CARTON-21', conversionFactor: 12, sellingPrice: 110 }]),
  };
  useCartStore.getState().clearCart();
  useCartStore.getState().addItem(product, 'carton');
  const item = useCartStore.getState().items.find((entry) => entry.id === product.id);
  assert.ok(item);
  assert.equal(item.selectedUnit, 'carton');
  assert.equal(item.cartQuantity, 1);
  assert.equal(getItemUnitFactor(item), 12);
  assert.equal(getItemPrice(item), 110);
  assert.equal(item.costPriceAtTimeOfSale, 5);
  useCartStore.getState().updateQuantity(item.cartItemId, 2);
  assert.equal(useCartStore.getState().items[0].cartQuantity, 2);
  assert.equal(useCartStore.getState().items[0].cartQuantity * getItemUnitFactor(useCartStore.getState().items[0]), 24);
  useCartStore.getState().clearCart();
});

test('server conversion trusts the persisted alternate unit over stale client factors', async () => {
  const { resolveProductUnitFactor } = await import('../src/utils/productUnits.js');
  const product = {
    unit: 'piece',
    conversionFactor: 12,
    unitsJson: JSON.stringify([
      { name: 'Carton', conversionFactor: 24 },
    ]),
  };
  assert.equal(resolveProductUnitFactor(product, { unit: 'carton', conversionFactor: 1 }), 24);
  assert.equal(resolveProductUnitFactor(product, { unit: 'CARTON', conversionFactor: 6 }), 24);
});

test('server conversion preserves legacy box products and recognizes the base unit', async () => {
  const { resolveProductUnitFactor } = await import('../src/utils/productUnits.js');
  const legacyProduct = { unit: 'piece', conversionFactor: 12 };
  assert.equal(resolveProductUnitFactor(legacyProduct, { unit: 'box', conversionFactor: 1 }), 12);
  assert.equal(resolveProductUnitFactor({ unit: 'kg', conversionFactor: 10 }, { unit: 'KG', conversionFactor: 10 }), 1);
});
