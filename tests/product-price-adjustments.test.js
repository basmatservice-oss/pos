import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('bulk price maintenance is submitted as one operation and does not write a second client audit log', async () => {
  const component = await readSource('../src/components/ProductPriceManager.tsx');
  assert.match(component, /records,\s*\}, branchId\)/);
  assert.match(component, /previousSellingPrice:/);
  assert.doesNotMatch(component, /logAction/);
  assert.doesNotMatch(component, /for \(const row of preview\)/);
});

test('server bulk price operation prevalidates all products and applies them in one transaction', async () => {
  const source = await readSource('../server/operations.ts');
  assert.match(source, /Array\.isArray\(payload\?\.records\)/);
  assert.match(source, /Bulk product price update must contain between 1 and 500 products/);
  assert.match(source, /const preparedRecords = payload\.records\.map/);
  assert.match(source, /All products are prevalidated before the first write/);
  assert.match(source, /preparedRecords\.map\(\(record: any\) =>/);
  assert.match(source, /previousSellingPrice: _previousSellingPrice/);
});

test('local bulk price operation commits all product rows and standalone audit rows in one repository transaction', async () => {
  const source = await readSource('../src/services/operationService.ts');
  const start = source.indexOf("if (tableName === 'products' && Array.isArray(payload?.records))");
  const end = source.indexOf('if (!payload?.record) return;', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /for \(const requested of records\)/);
  assert.match(handler, /currentDeviceRole === 'standalone'/);
  assert.match(handler, /entity: 'auditLogs'/);
  assert.match(handler, /nativePosRepository\.applyChanges\(changes\)/);
  assert.match(handler, /db\.transaction\('rw', \[db\.products, db\.auditLogs\]/);
  assert.match(handler, /db\.products\.bulkPut/);
});
