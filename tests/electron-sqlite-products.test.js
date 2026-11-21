import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import localDatabase from '../electron/local-database.cjs';

test('Electron SQLite commits a product and its opening inventory atomically and keeps them after reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-pos-sqlite-'));
  try {
    localDatabase.initializeLocalDatabase(directory);
    const product = {
      id: 501,
      name: 'SQLite persistence test product',
      barcode: '8900000501',
      stockQuantity: 4,
      costPrice: 12.5,
      sellingPrice: 18,
      itemType: 'stock',
      syncStatus: 'local',
    };
    const batch = {
      id: 'opening-batch-501',
      productId: 501,
      quantity: 4,
      remainingQuantity: 4,
      costPrice: 12.5,
    };
    const movement = {
      id: 'opening-movement-501',
      movementKey: 'opening:501',
      productId: 501,
      movementType: 'opening_balance',
      quantityDeltaBase: 4,
      totalCost: 50,
    };

    const committed = localDatabase.applyRecordChanges([
      { action: 'put', entity: 'products', recordId: '501', record: product, syncState: 'local' },
      { action: 'put', entity: 'inventoryBatches', recordId: '"opening-batch-501"', record: batch, syncState: 'local' },
      { action: 'put', entity: 'inventoryMovements', recordId: '"opening-movement-501"', record: movement, syncState: 'local' },
    ]);

    assert.equal(committed.applied, 3);
    assert.equal(localDatabase.getRecords('products').length, 1);
    assert.equal(localDatabase.getRecord('products', '501').item.record.name, product.name);
    assert.equal(localDatabase.getRecords('inventoryBatches').length, 1);
    assert.equal(localDatabase.getRecords('inventoryMovements').length, 1);

    localDatabase.closeLocalDatabase();
    localDatabase.initializeLocalDatabase(directory);

    const reopenedProduct = localDatabase.getRecord('products', '501');
    assert.equal(reopenedProduct.found, true);
    assert.equal(reopenedProduct.item.record.barcode, product.barcode);
    assert.equal(localDatabase.getRecords('inventoryBatches')[0].record.remainingQuantity, 4);
    assert.equal(localDatabase.getRecords('inventoryMovements')[0].record.movementKey, 'opening:501');
  } finally {
    localDatabase.closeLocalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Electron SQLite rejects duplicate identities in one product transaction without partial writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-pos-sqlite-rollback-'));
  try {
    localDatabase.initializeLocalDatabase(directory);
    assert.throws(() => localDatabase.applyRecordChanges([
      { action: 'put', entity: 'products', recordId: '502', record: { id: 502, name: 'first' } },
      { action: 'put', entity: 'products', recordId: '502', record: { id: 502, name: 'duplicate' } },
    ]), /Duplicate record change/);
    assert.equal(localDatabase.getRecords('products').length, 0);
  } finally {
    localDatabase.closeLocalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Electron SQLite accepts every entity exposed by the shared native repository', async () => {
  const { readFile } = await import('node:fs/promises');
  const nativeSource = await readFile(new URL('../src/native/nativePosRepository.ts', import.meta.url), 'utf8');
  const electronSource = await readFile(new URL('../electron/local-database.cjs', import.meta.url), 'utf8');
  const primaryKeyBlock = nativeSource.match(/const NATIVE_PRIMARY_KEYS = \{([\s\S]*?)\} as const/);
  const allowedBlock = electronSource.match(/VALID_ENTITIES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(primaryKeyBlock, 'native primary-key registry must exist');
  assert.ok(allowedBlock, 'Electron SQLite entity allowlist must exist');
  const nativeEntities = [...primaryKeyBlock[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]).sort();
  const electronEntities = [...allowedBlock[1].matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/g)].map((match) => match[1]).sort();
  assert.deepEqual(electronEntities, nativeEntities);
});
