import test from 'node:test';
import assert from 'node:assert/strict';
import { getProductUnitOptions, findProductBarcodeMatch } from '../src/utils/productUnits.js';
import { buildCanonicalProductUnits, normalizeUnitCode } from '../src/utils/productUnitCatalog.js';
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


test('normalizes legacy unit JSON into stable catalog rows without losing prices or barcodes', () => {
  const product = {
    id: 77, unit: 'piece', baseUnitCode: 'count', barcode: 'BASE-77',
    sellingPrice: 10, costPrice: 6, allowFractions: false, conversionFactor: 1,
    unitsJson: JSON.stringify([
      { name: 'Carton', barcode: 'CTN-77', conversionFactor: 24, sellingPrice: 220, costPrice: 132, priceInUSD: 2.2 },
      { name: 'Pack', barcode: 'PACK-77', conversionFactor: 6, sellingPrice: 57, costPrice: 34, allowFractions: true },
      { name: 'Invalid', conversionFactor: 0 },
    ]),
    updatedAt: '2026-11-22T00:00:00.000Z',
  };
  const first = buildCanonicalProductUnits(product);
  const second = buildCanonicalProductUnits(product);
  assert.deepEqual(first, second);
  assert.equal(first.units.length, 3);
  const carton = first.units.find((unit) => unit.barcode === 'CTN-77');
  assert.equal(carton.conversionToBase, 24);
  assert.equal(carton.sellingPrice, 220);
  assert.equal(carton.costPrice, 132);
  assert.equal(carton.priceInUSD, 2.2);
  const pack = first.units.find((unit) => unit.barcode === 'PACK-77');
  assert.equal(pack.allowFractions, 1);
  assert.equal(first.units.find((unit) => unit.isBaseUnit === 1).conversionToBase, 1);
  assert.equal(first.definitions.find((definition) => definition.code === carton.unitCode).name, 'Carton');
  assert.equal(normalizeUnitCode('Carton', 'count'), normalizeUnitCode('Carton', 'count'));
  assert.notEqual(normalizeUnitCode('Carton', 'count'), normalizeUnitCode('Carton', 'weight'));
});

test('keeps malformed legacy unit JSON non-destructive and preserves the base unit', () => {
  const result = buildCanonicalProductUnits({
    id: 78, unit: 'kg', sellingPrice: 20, costPrice: 12, unitsJson: '{broken',
  });
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].isBaseUnit, 1);
  assert.equal(result.units[0].conversionToBase, 1);
});

test('normalized product-unit reads are projected back for existing POS consumers', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/services/posDataAccess.ts', import.meta.url), 'utf8');
  assert.match(source, /getPosRecords<Record<string, any>>\('productUnits'\)/);
  assert.match(source, /getPosRecords<Record<string, any>>\('unitDefinitions'\)/);
  assert.match(source, /unitsJson: JSON\.stringify\(extras\)/);
});

test('single and filtered product reads use the same normalized unit projection as product lists', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/services/posDataAccess.ts', import.meta.url), 'utf8');
  assert.match(source, /getPosRecord[\s\S]*?projectProductUnitRecords\(\[record\]\)/);
  assert.match(source, /getPosRecordsWhereEquals[\s\S]*?getPosRecords<T>\('products'\)/);
  assert.match(source, /getFirstPosRecordWhereEquals[\s\S]*?getPosRecordsWhereEquals<T>\(entity, field, value\)/);
});


test('SQLite migration adds normalized unit metadata and idempotently backfills legacy products', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../migrate.ts', import.meta.url), 'utf8');
  const schema = await readFile(new URL('../drizzle/schema.ts', import.meta.url), 'utf8');
  assert.match(migration, /ensureColumn\(sqlite, 'ProductUnit', 'costPrice', 'real'\)/);
  assert.match(migration, /ensureColumn\(sqlite, 'ProductUnit', 'priceInUSD', 'real DEFAULT 0'\)/);
  assert.match(migration, /ensureColumn\(sqlite, 'ProductUnit', 'allowFractions', 'integer DEFAULT 0'\)/);
  assert.match(migration, /INSERT OR IGNORE INTO "ProductUnit"/);
  assert.match(migration, /INSERT OR IGNORE INTO "UnitDefinition"/);
  assert.match(migration, /buildCanonicalProductUnits\(product\)/);
  assert.match(migration, /"unitsJson" is deliberately retained|legacy JSON is deliberately retained/i);
  assert.match(schema, /costPrice: real\('costPrice'\)/);
  assert.match(schema, /priceInUSD: real\('priceInUSD'\)/);
  assert.match(schema, /allowFractions: integer\('allowFractions'\)/);
});

test('server sales and purchases resolve unit factors from ProductUnit before trusting client factors', async () => {
  const { readFile } = await import('node:fs/promises');
  const operations = await readFile(new URL('../server/operations.ts', import.meta.url), 'utf8');
  assert.match(operations, /from\(productUnits\)[\s\S]*?conversionToBase/);
  assert.match(operations, /resolveProductUnitFactorForSale\(tx, prod, item\)/);
  assert.match(operations, /resolveProductUnitFactorForSale\(tx, purchaseProduct, item\)/);
  assert.match(operations, /وحدة البيع .*غير معرفة للصنف/);
  assert.match(operations, /syncNormalizedProductUnits\(tx, savedRecord, now\)/);
});


test('supplier purchase return UI converts invoice quantities and legacy costs to base units', async () => {
  const { readFile } = await import('node:fs/promises');
  const purchasesPage = await readFile(new URL('../src/pages/Purchases.tsx', import.meta.url), 'utf8');
  assert.match(purchasesPage, /const safeFactor = Number\.isFinite\(conversionFactor\) && conversionFactor > 0 \? conversionFactor : 1/);
  assert.match(purchasesPage, /Number\(item\.quantity \|\| 0\) \* safeFactor/);
  assert.match(purchasesPage, /Number\(item\.costPrice \|\| 0\) \/ safeFactor/);
  assert.match(purchasesPage, /المتاح \(بالوحدة الأساسية\)/);
  assert.match(purchasesPage, /كمية الإرجاع \(بالوحدة الأساسية\)/);
  assert.match(purchasesPage, /item\.baseUnit/);
});

test('server rejects a stale unit code when its definition does not match the requested unit name', async () => {
  const { readFile } = await import('node:fs/promises');
  const operations = await readFile(new URL('../server/operations.ts', import.meta.url), 'utf8');
  assert.match(operations, /if \(item\.unitCode && String\(row\.unitCode\) === String\(item\.unitCode\)\) \{\s*return definitionName === requestedName;/);
  assert.match(operations, /return !item\.unitCode && definitionName === requestedName;/);
});


test('native product edits atomically reconcile ProductUnit rows with the edited legacy payload', async () => {
  const { readFile } = await import('node:fs/promises');
  const service = await readFile(new URL('../src/services/operationService.ts', import.meta.url), 'utf8');
  assert.match(service, /buildCanonicalProductUnits\(productRecord\)/);
  assert.match(service, /nativePosRepository\.whereEquals<any>\('productUnits', 'productId', productId\)/);
  assert.match(service, /changes\.push\(\{ action: 'delete', entity: 'productUnits', key: oldUnit\.id \}\)/);
  assert.match(service, /entity: 'unitDefinitions'/);
  assert.match(service, /entity: 'productUnits'/);
  assert.match(service, /nativePosRepository\.applyChanges\(changes\)/);
});

test('native product deletion atomically removes normalized unit rows without deleting shared definitions', async () => {
  const { readFile } = await import('node:fs/promises');
  const service = await readFile(new URL('../src/services/operationService.ts', import.meta.url), 'utf8');
  const deleteBlock = service.slice(service.indexOf("if (type === 'entity_delete')"), service.indexOf("if (!payload?.record)"));
  assert.match(deleteBlock, /tableName === 'products'/);
  assert.match(deleteBlock, /whereEquals<any>\('productUnits', 'productId', productId\)/);
  assert.match(deleteBlock, /entity: 'productUnits'/);
  assert.match(deleteBlock, /entity: 'products'/);
  assert.match(deleteBlock, /nativePosRepository\.applyChanges\(changes\)/);
  assert.doesNotMatch(deleteBlock, /entity: 'unitDefinitions'/);
});


test('server product REST create, update and delete keep normalized units transactional', async () => {
  const { readFile } = await import('node:fs/promises');
  const [app, operations] = await Promise.all([
    readFile(new URL('../server/app.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/operations.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(operations, /export function syncNormalizedProductUnits\(/);
  const createRoute = app.slice(app.indexOf("app.post('/api/products'"), app.indexOf("app.put('/api/products/:id'"));
  assert.match(createRoute, /syncNormalizedProductUnits\(tx, created, now\)/);
  const updateRoute = app.slice(app.indexOf("app.put('/api/products/:id'"), app.indexOf("app.delete('/api/products/:id'"));
  assert.match(updateRoute, /db\.transaction/);
  assert.match(updateRoute, /syncNormalizedProductUnits\(tx, updated, now\)/);
  const deleteRoute = app.slice(app.indexOf("app.delete('/api/products/:id'"), app.indexOf('// --- Categories ---'));
  assert.match(deleteRoute, /tx\.delete\(productUnits\).*productId, id/s);
  assert.match(deleteRoute, /tx\.delete\(products\)/);
});
