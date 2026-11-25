import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import localDatabase from '../electron/local-database.cjs';
import { filterServerSnapshotPreservingLocalPending, getPendingSyncKeys } from '../src/utils/syncSnapshot.ts';

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

test('Electron SQLite identifies the exact entity and record when stored JSON is corrupt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-pos-sqlite-corrupt-'));
  try {
    localDatabase.initializeLocalDatabase(directory);
    localDatabase.putRecords([{ entity: 'products', recordId: '503', record: { id: 503, name: 'corruption test' } }]);
    localDatabase.closeLocalDatabase();

    const raw = new Database(path.join(directory, 'pos-local.db'));
    raw.prepare('UPDATE pos_records SET json = ? WHERE entity = ? AND record_id = ?')
      .run('{broken-json', 'products', '503');
    raw.close();

    localDatabase.initializeLocalDatabase(directory);
    assert.throws(() => localDatabase.getRecords('products'), /Corrupt SQLite record in products \(recordId=503\)/);
  } finally {
    localDatabase.closeLocalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});


test('Electron SQLite validates snapshot identities without returning full business records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-pos-snapshot-validation-'));
  try {
    localDatabase.initializeLocalDatabase(directory);
    localDatabase.applyRecordChanges([
      { action: 'put', entity: 'products', recordId: '501', record: { id: 501, name: 'Valid' }, syncState: 'synced' },
    ]);
    assert.deepEqual(localDatabase.validateRecords('products', 'id'), { recordIds: ['501'] });

    localDatabase.applyRecordChanges([
      { action: 'put', entity: 'products', recordId: '502', record: { id: 501, name: 'Mismatched key' }, syncState: 'synced' },
    ]);
    assert.throws(() => localDatabase.validateRecords('products', 'id'), /identity validation failed/);
  } finally {
    localDatabase.closeLocalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});


test('SQLite snapshot merge preserves unresolved accounts and inventory alerts using real persisted sync states', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-pos-sqlite-sync-snapshot-'));
  try {
    localDatabase.initializeLocalDatabase(directory);

    const cases = [
      {
        entity: 'accounts',
        keyField: 'code',
        local: [
          { record: { code: '1100', name: 'local pending account' }, syncState: 'pending' },
          { record: { code: '2100', name: 'local error account' }, syncState: 'error' },
          { record: { code: '3100', name: 'local conflict account', syncStatus: 'conflict' }, syncState: 'local' },
          { record: { code: '4100', name: 'old synced account' }, syncState: 'synced' },
        ],
        server: [
          { code: '1100', name: 'stale pending account' },
          { code: '2100', name: 'stale error account' },
          { code: '3100', name: 'stale conflict account' },
          { code: '4100', name: 'fresh synced account' },
          { code: '5100', name: 'new server account' },
        ],
      },
      {
        entity: 'inventoryAlerts',
        keyField: 'id',
        local: [
          { record: { id: 'alert-pending', productName: 'local pending alert' }, syncState: 'pending' },
          { record: { id: 'alert-error', productName: 'local error alert' }, syncState: 'error' },
          { record: { id: 'alert-conflict', productName: 'local conflict alert', syncStatus: 'conflict' }, syncState: 'local' },
          { record: { id: 'alert-synced', productName: 'old synced alert' }, syncState: 'synced' },
        ],
        server: [
          { id: 'alert-pending', productName: 'stale pending alert' },
          { id: 'alert-error', productName: 'stale error alert' },
          { id: 'alert-conflict', productName: 'stale conflict alert' },
          { id: 'alert-synced', productName: 'fresh synced alert' },
          { id: 'alert-new', productName: 'new server alert' },
        ],
      },
    ];

    for (const scenario of cases) {
      localDatabase.applyRecordChanges(scenario.local.map(({ record, syncState }) => ({
        action: 'put',
        entity: scenario.entity,
        recordId: JSON.stringify(record[scenario.keyField]),
        record,
        syncState,
      })));

      const persisted = localDatabase.getRecords(scenario.entity);
      const pendingKeys = getPendingSyncKeys(persisted.map(({ record, syncState }) => ({
        ...record,
        syncState,
      })));
      const acceptedServerRows = filterServerSnapshotPreservingLocalPending(scenario.server, pendingKeys);
      const applied = localDatabase.applyRecordChanges(acceptedServerRows.map((record) => ({
        action: 'put',
        entity: scenario.entity,
        recordId: JSON.stringify(record[scenario.keyField]),
        record,
        syncState: 'synced',
      })));
      assert.equal(applied.applied, acceptedServerRows.length);

      const finalRows = localDatabase.getRecords(scenario.entity);
      const byKey = new Map(finalRows.map(({ record }) => [String(record[scenario.keyField]), record]));
      for (const local of scenario.local.slice(0, 3)) {
        const key = String(local.record[scenario.keyField]);
        assert.equal(byKey.get(key).name ?? byKey.get(key).productName, local.record.name ?? local.record.productName,
          scenario.entity + ' must retain the unresolved local value for ' + key);
      }
      const refreshedKey = scenario.entity === 'accounts' ? '4100' : 'alert-synced';
      const newKey = scenario.entity === 'accounts' ? '5100' : 'alert-new';
      assert.equal(byKey.get(refreshedKey).name ?? byKey.get(refreshedKey).productName,
        scenario.server.find((record) => String(record[scenario.keyField]) === refreshedKey).name ??
        scenario.server.find((record) => String(record[scenario.keyField]) === refreshedKey).productName);
      assert.ok(byKey.has(newKey), scenario.entity + ' must accept new server rows');
    }
  } finally {
    localDatabase.closeLocalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
