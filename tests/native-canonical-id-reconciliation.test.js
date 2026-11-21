import test from 'node:test';
import assert from 'node:assert/strict';

test('native SQLite keeps a product visible when the server replaces its temporary ID', async () => {
  const previousWindow = globalThis.window;
  const tables = new Map();
  const table = (entity) => {
    if (!tables.has(entity)) tables.set(entity, new Map());
    return tables.get(entity);
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const bridge = {
    initialize: async () => ({ ready: true }),
    getRecords: async (entity) => Array.from(table(entity).values()).map(clone),
    getRecord: async (entity, recordId) => {
      const row = table(entity).get(recordId);
      return row ? { found: true, item: clone(row) } : { found: false, item: null };
    },
    applyRecordChanges: async (changes) => {
      for (const change of changes) {
        if (change.action === 'delete') {
          table(change.entity).delete(change.recordId);
        } else {
          table(change.entity).set(change.recordId, {
            recordId: change.recordId,
            record: clone(change.record),
            syncState: change.syncState || 'local',
            updatedAt: Date.now(),
          });
        }
      }
      return { applied: changes.length, count: changes.length };
    },
    listOperations: async () => ({ operations: [] }),
  };

  const oldId = 1790000000000000;
  const serverId = 427;
  const product = { id: oldId, name: 'Canonical ID product', stockQuantity: 8, costPrice: 4, sellingPrice: 7 };
  table('products').set(JSON.stringify(oldId), {
    recordId: JSON.stringify(oldId), record: clone(product), syncState: 'pending', updatedAt: 1,
  });
  table('inventoryBatches').set('"opening-batch"', {
    recordId: '"opening-batch"',
    record: { id: 'opening-batch', productId: oldId, quantity: 8, remainingQuantity: 8 },
    syncState: 'pending',
    updatedAt: 1,
  });

  globalThis.window = { electronAPI: { isElectron: true, posLocalDatabase: bridge } };

  try {
    const { setElectronDeviceRole } = await import('../src/native/electronPosRepository.ts');
    setElectronDeviceRole('client');
    const {
      remapPendingEntityReferences,
      reconcileNativeOperationAfterAck,
    } = await import('../src/services/localOperationReconciliation.ts');

    await remapPendingEntityReferences('products', oldId, serverId, 'product-op');
    const pendingRefs = {
      products: new Set(),
      customers: new Set(),
      suppliers: new Set(),
      orders: new Set(),
      purchases: new Set(),
      batches: new Set(),
      entityRecords: new Set(),
    };
    const serverProduct = { ...product, id: serverId, barcode: '9000000000427' };
    await reconcileNativeOperationAfterAck(
      'entity_upsert',
      { table: 'products', record: product },
      'product-op',
      serverProduct,
      pendingRefs,
    );

    const savedProducts = await bridge.getRecords('products');
    assert.equal(savedProducts.length, 1);
    assert.equal(savedProducts[0].recordId, JSON.stringify(serverId));
    assert.equal(savedProducts[0].record.id, serverId);
    assert.equal(savedProducts[0].record.name, product.name);
    assert.equal(savedProducts[0].record.barcode, serverProduct.barcode);
    assert.equal(savedProducts[0].syncState, 'synced');

    const savedBatches = await bridge.getRecords('inventoryBatches');
    assert.equal(savedBatches.length, 1);
    assert.equal(savedBatches[0].record.productId, serverId);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
