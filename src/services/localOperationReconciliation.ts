import { db } from '../db/db';
import { removeLocalInventoryArtifactsForOperation } from './localInventoryEngine';
import { removeLocalJournalEntriesForReference } from './localAccountingEngine';
import { mirrorNativePosDatabase } from './nativeDatabaseMirror';
import { isNativeAndroid, listNativePendingPosOperations, updateNativePendingOperationPayload } from '../native/posLocalDatabase';
import { nativePosRepository } from '../native/nativePosRepository';

function collectPendingReferences(value: any, refs: Record<string, Set<string>>) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'number' || typeof child === 'string') {
      if (key === 'productId' || key === 'ingredientProductId') refs.products.add(String(child));
      if (key === 'customerId') refs.customers.add(String(child));
      if (key === 'supplierId') refs.suppliers.add(String(child));
      if (key === 'orderId' || key === 'originalOrderId') refs.orders.add(String(child));
      if (key === 'purchaseId' || key === 'originalPurchaseId') refs.purchases.add(String(child));
      if (key === 'batchId' || key === 'inventoryBatchId') refs.batches.add(String(child));
    } else if (child && typeof child === 'object') {
      if (key === 'order' && (child as any).id !== undefined) refs.orders.add(String((child as any).id));
      if (key === 'purchase' && (child as any).id !== undefined) refs.purchases.add(String((child as any).id));
      collectPendingReferences(child, refs);
    }
  }
}

async function markRowsSynced(table: any, predicate: (row: any) => boolean) {
  const rows = await table.filter(predicate).toArray();
  for (const row of rows) {
    const key = row.id ?? row.code ?? row.key;
    if (key !== undefined) await table.update(key, { syncStatus: 'synced' });
  }
}

async function markOrderInventoryRowsSynced(orderId: string, pendingRefs: Record<string, Set<string>>) {
  const items = await db.orderItems.where('orderId').equals(orderId).toArray();
  const productIds = new Set<string>();
  const batchIds = new Set<string>();
  for (const item of items) {
    productIds.add(String(item.productId));
    let allocations: any = item.batchAllocations || [];
    try { if (typeof allocations === 'string') allocations = JSON.parse(allocations); } catch { allocations = []; }
    const collectAllocations = (list: any[]) => {
      for (const allocation of list || []) if (allocation?.batchId) batchIds.add(String(allocation.batchId));
    };
    if (Array.isArray(allocations)) collectAllocations(allocations);
    if (allocations?.kind === 'recipe' && Array.isArray(allocations.ingredients)) {
      for (const ingredient of allocations.ingredients) {
        productIds.add(String(ingredient.ingredientProductId));
        collectAllocations(ingredient.allocations || []);
      }
    }
  }
  for (const id of productIds) if (!pendingRefs.products.has(id)) await db.products.update(Number(id), { syncStatus: 'synced' });
  if (batchIds.size) await markRowsSynced(db.inventoryBatches, (batch) => batchIds.has(String(batch.id)) && !pendingRefs.batches.has(String(batch.id)) && !pendingRefs.products.has(String(batch.productId)));
}

const entityReferenceKeys: Record<string, string[]> = {
  products: ['productId', 'ingredientProductId', 'parentProductId'],
  customers: ['customerId'],
  suppliers: ['supplierId'],
  categories: ['categoryId'],
  employees: ['employeeId'],
  branches: ['branchId'],
};

function replaceEntityReferences(value: any, keys: Set<string>, oldId: string, newId: string): any {
  if (Array.isArray(value)) return value.map((item) => replaceEntityReferences(item, keys, oldId, newId));
  if (!value || typeof value !== 'object') return value;
  const updated: any = {};
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && child !== null && child !== undefined && String(child) === oldId) {
      updated[key] = /^\d+$/.test(newId) ? Number(newId) : newId;
    } else {
      updated[key] = replaceEntityReferences(child, keys, oldId, newId);
    }
  }
  return updated;
}

const localReferenceStores: Record<string, Record<string, string[]>> = {
  products: {
    orderItems: ['productId'], returnItems: ['productId'], purchaseItems: ['productId'],
    purchaseReturnItems: ['productId'], stocktakingEntries: ['productId'], inventoryBatches: ['productId'],
    serviceRecipes: ['parentProductId', 'ingredientProductId'], productUnits: ['productId'],
    inventoryMovements: ['productId'], inventoryAlerts: ['productId'],
  },
  customers: {
    orders: ['customerId'], customerPayments: ['customerId'], loyaltyTransactions: ['customerId'],
    heldOrders: ['customerId'],
  },
  suppliers: {
    purchases: ['supplierId'], supplierPayments: ['supplierId'], purchaseReturns: ['supplierId'],
  },
  categories: { products: ['categoryId'] },
  employees: { attendance: ['employeeId'], payroll: ['employeeId'] },
  branches: {
    products: ['branchId'], categories: ['branchId'], orders: ['branchId'],
    returns: ['branchId'], shifts: ['branchId'], shiftMovements: ['branchId'],
    expenses: ['branchId'], purchases: ['branchId'], purchaseReturns: ['branchId'],
    employees: ['branchId'], payroll: ['branchId'], offers: ['branchId'],
    stocktakingSessions: ['branchId'], inventoryMovements: ['branchId'],
  },
};

async function remapLocalEntityReferences(tableName: string, oldId: string, newId: string) {
  const stores = localReferenceStores[tableName] || {};
  const replacement: any = /^[0-9]+$/.test(newId) ? Number(newId) : newId;
  if (isNativeAndroid()) {
    const changes: Array<{ action: 'put'; entity: any; record: any; syncState: any }> = [];
    for (const [storeName, fields] of Object.entries(stores)) {
      const rows = await nativePosRepository.getAllWithSyncState(storeName as any);
      for (const row of rows) {
        const updated: any = { ...row.record };
        let changed = false;
        for (const field of fields) {
          if (updated[field] !== undefined && String(updated[field]) === oldId) {
            updated[field] = replacement;
            changed = true;
          }
        }
        if (changed) changes.push({
          action: 'put', entity: storeName, record: updated, syncState: row.syncState,
        });
      }
    }
    if (changes.size) {
    const applied = await nativePosRepository.applyChanges(Array.from(changes.values()));
    if (applied !== changes.size) throw new Error('SQLite did not confirm every Android sync reconciliation change');
  }
    return;
  }
  for (const [storeName, fields] of Object.entries(stores)) {
    const table = (db as any)[storeName];
    if (!table) continue;
    const rows = await table.toArray();
    for (const row of rows) {
      const changes: Record<string, any> = {};
      for (const field of fields) {
        if (row[field] !== undefined && String(row[field]) === oldId) changes[field] = replacement;
      }
      if (Object.keys(changes).length) {
        const keyPath = table.schema.primKey.keyPath;
        const key = typeof keyPath === 'string' ? row[keyPath] : undefined;
        if (key !== undefined) await table.update(key, changes);
      }
    }
  }
}

/** Rewrites references in both durable queues after the server assigns a canonical entity ID. */
export async function remapPendingEntityReferences(tableName: string, oldId: any, newId: any, acknowledgedOperationId?: string) {
  const keys = new Set(entityReferenceKeys[tableName] || []);
  if (!keys.size || oldId === undefined || newId === undefined || String(oldId) === String(newId)) return;
  const oldKey = String(oldId);
  const newKey = String(newId);
  await remapLocalEntityReferences(tableName, oldKey, newKey);
  const dexiePending = isNativeAndroid() ? [] : await db.syncOperations.where('status').anyOf(['pending', 'error', 'syncing']).toArray();
  for (const operation of dexiePending) {
    if (operation.id === acknowledgedOperationId) continue;
    let nextPayload = replaceEntityReferences(operation.payload, keys, oldKey, newKey);
    if (operation.type === 'entity_upsert' && operation.payload?.table === tableName &&
        operation.payload?.record?.id !== undefined && String(operation.payload.record.id) === oldKey) {
      nextPayload = { ...nextPayload, record: { ...nextPayload.record, id: /^\d+$/.test(newKey) ? Number(newKey) : newKey } };
    }
    if (JSON.stringify(nextPayload) !== JSON.stringify(operation.payload)) {
      await db.syncOperations.update(operation.id, { payload: nextPayload });
    }
  }
  if (isNativeAndroid()) {
    const nativePending = await listNativePendingPosOperations();
    for (const operation of nativePending) {
      if (operation.operationId === acknowledgedOperationId) continue;
      let nextPayload = replaceEntityReferences(operation.payload, keys, oldKey, newKey);
      if (operation.type === 'entity_upsert' && operation.payload?.table === tableName &&
          operation.payload?.record?.id !== undefined && String(operation.payload.record.id) === oldKey) {
        nextPayload = { ...nextPayload, record: { ...nextPayload.record, id: /^\d+$/.test(newKey) ? Number(newKey) : newKey } };
      }
      if (JSON.stringify(nextPayload) !== JSON.stringify(operation.payload)) {
        const updated = await updateNativePendingOperationPayload(operation.operationId, nextPayload);
      if (!updated) throw new Error(`Native outbox payload was not updated: ${operation.operationId}`);
      }
    }
  }
}

async function reconcileNativeOperationAfterAck(type: string, payload: any, operationId: string, serverResult: any, pendingRefs: Record<string, Set<string>>) {
  const loaded = new Map<string, Array<{ record: Record<string, any>; recordId: string; syncState: any }>>();
  const changes = new Map<string, any>();
  const queueChange = (change: any) => {
    const key = change.action === 'delete' ? JSON.stringify(change.key) : JSON.stringify(change.record.id ?? change.record.code ?? change.record.key);
    changes.set(change.entity + ':' + key, change);
  };
  const cacheUpdates = new Map<string, Map<string, any>>();
  const load = async (entity: string) => {
    if (!loaded.has(entity)) loaded.set(entity, await nativePosRepository.getAllWithSyncState(entity as any) as any);
    return loaded.get(entity)!;
  };
  const mark = async (entity: string, predicate: (record: any) => boolean) => {
    const rows = await load(entity);
    for (const row of rows) {
      if (!predicate(row.record)) continue;
      const record = { ...row.record, syncStatus: 'synced' };
      queueChange({ action: 'put', entity, record, syncState: 'synced' });
      const key = record.id ?? record.code ?? record.key;
      if (key !== undefined) {
        if (!cacheUpdates.has(entity)) cacheUpdates.set(entity, new Map<string, any>());
        cacheUpdates.get(entity)!.set(String(key), key);
      }
    }
  };
  const get = async (entity: string, id: unknown) => {
    if (id === undefined || id === null || id === '') return undefined;
    return (await load(entity)).find((row) => String(row.record.id ?? row.record.code ?? row.record.key) === String(id))?.record;
  };
  const canMark = (kind: 'products' | 'customers' | 'suppliers' | 'orders' | 'purchases', id: any) => id !== undefined && id !== null && !pendingRefs[kind].has(String(id));
  const markOrderInventory = async (orderId: string) => {
    const items = (await load('orderItems')).filter((row) => String(row.record.orderId) === orderId).map((row) => row.record);
    const productIds = new Set<string>();
    const batchIds = new Set<string>();
    const collectAllocations = (list: any[]) => {
      for (const allocation of list || []) if (allocation?.batchId) batchIds.add(String(allocation.batchId));
    };
    for (const item of items) {
      productIds.add(String(item.productId));
      let allocations: any = item.batchAllocations || [];
      try { if (typeof allocations === 'string') allocations = JSON.parse(allocations); } catch { allocations = []; }
      if (Array.isArray(allocations)) collectAllocations(allocations);
      if (allocations?.kind === 'recipe' && Array.isArray(allocations.ingredients)) {
        for (const ingredient of allocations.ingredients) {
          productIds.add(String(ingredient.ingredientProductId));
          collectAllocations(ingredient.allocations || []);
        }
      }
    }
    await mark('orderItems', (row) => String(row.orderId) === orderId);
    await mark('loyaltyTransactions', (row) => String(row.orderId) === orderId);
    for (const id of productIds) if (!pendingRefs.products.has(id)) await mark('products', (row) => String(row.id) === id);
    await mark('inventoryBatches', (row) => batchIds.has(String(row.id)) && !pendingRefs.batches.has(String(row.id)) && !pendingRefs.products.has(String(row.productId)));
  };

  if (type === 'sale') {
    const orderId = String(payload?.order?.id || '');
    if (orderId && canMark('orders', orderId)) {
      await mark('orders', (row) => String(row.id) === orderId);
      await markOrderInventory(orderId);
    }
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await mark('products', (row) => String(row.id) === String(item.productId));
    if (payload?.order?.customerId && canMark('customers', payload.order.customerId)) await mark('customers', (row) => String(row.id) === String(payload.order.customerId));
  } else if (type === 'return') {
    const returnId = String(payload?.id || ''), orderId = String(payload?.originalOrderId || '');
    if (returnId) { await mark('returns', (row) => String(row.id) === returnId); await mark('returnItems', (row) => String(row.returnId) === returnId); }
    if (orderId && canMark('orders', orderId)) { await mark('orders', (row) => String(row.id) === orderId); await markOrderInventory(orderId); }
    const originalOrder = orderId ? await get('orders', orderId) : undefined;
    if (originalOrder?.customerId && canMark('customers', originalOrder.customerId)) await mark('customers', (row) => String(row.id) === String(originalOrder.customerId));
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await mark('products', (row) => String(row.id) === String(item.productId));
  } else if (type === 'order_void') {
    const orderId = String(payload?.orderId || payload?.id || '');
    if (orderId && canMark('orders', orderId)) { await mark('orders', (row) => String(row.id) === orderId); await markOrderInventory(orderId); }
    const originalOrder = orderId ? await get('orders', orderId) : undefined;
    if (originalOrder?.customerId && canMark('customers', originalOrder.customerId)) await mark('customers', (row) => String(row.id) === String(originalOrder.customerId));
  } else if (type === 'purchase' || type === 'purchase_update') {
    const purchaseId = String(payload?.purchase?.id || '');
    if (purchaseId && canMark('purchases', purchaseId)) {
      await mark('purchases', (row) => String(row.id) === purchaseId);
      await mark('purchaseItems', (row) => String(row.purchaseId) === purchaseId);
      await mark('inventoryBatches', (row) => String(row.purchaseId) === purchaseId && !pendingRefs.batches.has(String(row.id)) && !pendingRefs.products.has(String(row.productId)));
      await mark('inventoryMovements', (row) => String(row.sourceId) === purchaseId && row.sourceType === 'purchase');
      const purchaseJournalIds = new Set((await load('journalEntries'))
        .filter((row) => String(row.record.referenceId) === purchaseId)
        .map((row) => String(row.record.id)));
      await mark('journalEntries', (row) => String(row.referenceId) === purchaseId);
      await mark('transactions', (row) => purchaseJournalIds.has(String(row.journalEntryId)) || String(row.purchaseId) === purchaseId);
    }
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await mark('products', (row) => String(row.id) === String(item.productId));
    for (const productId of payload?._localAffectedProductIds || []) if (canMark('products', productId)) await mark('products', (row) => String(row.id) === String(productId));
    if (payload?.purchase?.supplierId && canMark('suppliers', payload.purchase.supplierId)) await mark('suppliers', (row) => String(row.id) === String(payload.purchase.supplierId));
    if (payload?._localAffectedSupplierId && canMark('suppliers', payload._localAffectedSupplierId)) await mark('suppliers', (row) => String(row.id) === String(payload._localAffectedSupplierId));
  } else if (type === 'purchase_delete') {
    for (const productId of payload?._localAffectedProductIds || []) if (canMark('products', productId)) await mark('products', (row) => String(row.id) === String(productId));
    if (payload?._localAffectedSupplierId && canMark('suppliers', payload._localAffectedSupplierId)) await mark('suppliers', (row) => String(row.id) === String(payload._localAffectedSupplierId));
  } else if (type === 'purchase_return') {
    const returnId = String(payload?.id || ''), purchaseId = String(payload?.originalPurchaseId || '');
    if (returnId) {
      await mark('purchaseReturns', (row) => String(row.id) === returnId);
      await mark('purchaseReturnItems', (row) => String(row.purchaseReturnId) === returnId);
      const returnJournalIds = new Set((await load('journalEntries'))
        .filter((row) => String(row.record.referenceId) === returnId && row.record.referenceType === 'purchase_return')
        .map((row) => String(row.record.id)));
      await mark('journalEntries', (row) => String(row.referenceId) === returnId && row.referenceType === 'purchase_return');
      await mark('transactions', (row) => returnJournalIds.has(String(row.journalEntryId)));
    }
    if (purchaseId && canMark('purchases', purchaseId)) await mark('purchases', (row) => String(row.id) === purchaseId);
    const originalPurchase = purchaseId ? await get('purchases', purchaseId) : undefined;
    if (originalPurchase?.supplierId && canMark('suppliers', originalPurchase.supplierId)) await mark('suppliers', (row) => String(row.id) === String(originalPurchase.supplierId));
    const returnedProductIds = new Set((payload?.items || []).map((item: any) => String(item.productId)));
    if (purchaseId) await mark('inventoryBatches', (row) => String(row.purchaseId) === purchaseId && returnedProductIds.has(String(row.productId)) && !pendingRefs.batches.has(String(row.id)) && !pendingRefs.products.has(String(row.productId)));
    for (const item of payload?.items || []) {
      if (canMark('products', item.productId)) await mark('products', (row) => String(row.id) === String(item.productId));
      if (item.batchId && !pendingRefs.batches.has(String(item.batchId)) && !pendingRefs.products.has(String(item.productId))) await mark('inventoryBatches', (row) => String(row.id) === String(item.batchId));
    }
  } else if (type === 'expense') {
    if (payload?.id !== undefined) await mark('expenses', (row) => String(row.id) === String(payload.id));
  } else if (type === 'customer_payment') {
    const paymentId = String(payload?.paymentId || operationId);
    await mark('customerPayments', (row) => String(row.id) === paymentId);
    if (payload?.customerId && canMark('customers', payload.customerId)) await mark('customers', (row) => String(row.id) === String(payload.customerId));
    if (payload?.orderId && canMark('orders', payload.orderId)) await mark('orders', (row) => String(row.id) === String(payload.orderId));
  } else if (type === 'supplier_payment') {
    const paymentId = String(payload?.paymentId || operationId);
    await mark('supplierPayments', (row) => String(row.id) === paymentId);
    if (payload?.supplierId && canMark('suppliers', payload.supplierId)) await mark('suppliers', (row) => String(row.id) === String(payload.supplierId));
    if (payload?.purchaseId && canMark('purchases', payload.purchaseId)) await mark('purchases', (row) => String(row.id) === String(payload.purchaseId));
  } else if (type === 'payroll') {
    if (payload?.id !== undefined) await mark('payroll', (row) => String(row.id) === String(payload.id));
  } else if (type === 'shift_open' || type === 'shift_close') {
    if (payload?.id !== undefined) await mark('shifts', (row) => String(row.id) === String(payload.id));
  } else if (type === 'shift_movement') {
    if (payload?.id !== undefined) await mark('shiftMovements', (row) => String(row.id) === String(payload.id));
  } else if (type === 'stocktake_approve') {
    if (payload?.sessionId) {
      const sessionId = String(payload.sessionId);
      await mark('stocktakingSessions', (row) => String(row.id) === sessionId);
      const entries = (await load('stocktakingEntries')).filter((row) => String(row.record.sessionId) === sessionId).map((row) => row.record);
      await mark('stocktakingEntries', (row) => String(row.sessionId) === sessionId);
      for (const entry of entries) if (canMark('products', entry.productId)) {
        await mark('products', (row) => String(row.id) === String(entry.productId));
        await mark('inventoryBatches', (row) => Number(row.productId) === Number(entry.productId) && !pendingRefs.batches.has(String(row.id)) && !pendingRefs.products.has(String(row.productId)));
      }
    }
  } else if (type === 'entity_upsert') {
    const entity = String(payload?.table || '');
    const serverId = serverResult?.id ?? payload?.record?.id;
    if (entity && serverId !== undefined) {
      const oldId = payload?.record?.id;
      if (oldId !== undefined && String(oldId) !== String(serverId)) {
        queueChange({ action: 'delete', entity, key: oldId });
        if (entity === 'products') {
          for (const batch of await load('inventoryBatches')) if (String(batch.record.productId) === String(oldId)) queueChange({ action: 'delete', entity: 'inventoryBatches', key: batch.record.id });
        }
      }
      if (entity === 'products') {
        await mark('products', (row) => String(row.id) === String(serverId));
        await mark('inventoryBatches', (row) => String(row.productId) === String(serverId) && !pendingRefs.batches.has(String(row.id)) && !pendingRefs.products.has(String(row.productId)));
      } else await mark(entity, (row) => String(row.id) === String(serverId));
    }
  }
  if (changes.length) await nativePosRepository.applyChanges(changes);
  for (const [entity, keys] of cacheUpdates) {
    const table = db.table(entity);
    for (const key of keys.values()) try { await table.update(key, { syncStatus: 'synced' }); } catch {}
  }
  if (type === 'entity_upsert' && payload?.table && payload?.record?.id !== undefined) {
    const entity = String(payload.table);
    const serverId = serverResult?.id ?? payload.record.id;
    const oldId = payload.record.id;
    if (String(oldId) !== String(serverId)) {
      try { await db.table(entity).delete(oldId); } catch {}
      if (entity === 'products') {
        const batches = (await load('inventoryBatches')).filter((row) => String(row.record.productId) === String(oldId));
        for (const batch of batches) try { await db.inventoryBatches.delete(batch.record.id); } catch {}
      }
    }
  }
}

export async function reconcileLocalOperationAfterAck(type: string, payload: any, operationId: string, serverResult?: any) {
  const referenceId = type === 'entity_upsert' && payload?.table === 'products'
    ? 'opening:' + String(payload?.record?.id)
    : String(payload?.order?.id || payload?.purchase?.id || payload?.orderId || payload?.id || payload?.paymentId || payload?.sessionId || operationId);
  await removeLocalJournalEntriesForReference(referenceId);
  await removeLocalInventoryArtifactsForOperation(operationId);

  const pending = isNativeAndroid() ? [] : await db.syncOperations.where('status').anyOf(['pending', 'error', 'syncing']).toArray();
  const pendingRefs = { products: new Set<string>(), customers: new Set<string>(), suppliers: new Set<string>(), orders: new Set<string>(), purchases: new Set<string>(), batches: new Set<string>() };
  for (const operation of pending) {
    collectPendingReferences(operation.payload, pendingRefs);
    if (operation.type === 'entity_upsert' || operation.type === 'entity_delete') {
      const tableName = operation.payload?.table;
      const entityId = operation.payload?.record?.id ?? operation.payload?.id;
      if (entityId !== undefined && tableName === 'products') pendingRefs.products.add(String(entityId));
      if (entityId !== undefined && tableName === 'customers') pendingRefs.customers.add(String(entityId));
      if (entityId !== undefined && tableName === 'suppliers') pendingRefs.suppliers.add(String(entityId));
      if (entityId !== undefined && tableName === 'inventoryBatches') pendingRefs.batches.add(String(entityId));
    }
  }
  if (isNativeAndroid()) {
    try {
      const nativePending = await listNativePendingPosOperations();
      for (const operation of nativePending) {
        collectPendingReferences(operation.payload, pendingRefs);
        if (operation.type === 'entity_upsert' || operation.type === 'entity_delete') {
          const tableName = operation.payload?.table;
          const entityId = operation.payload?.record?.id ?? operation.payload?.id;
          if (entityId !== undefined && tableName === 'products') pendingRefs.products.add(String(entityId));
          if (entityId !== undefined && tableName === 'customers') pendingRefs.customers.add(String(entityId));
          if (entityId !== undefined && tableName === 'suppliers') pendingRefs.suppliers.add(String(entityId));
          if (entityId !== undefined && tableName === 'inventoryBatches') pendingRefs.batches.add(String(entityId));
        }
      }
    } catch (error) {
      throw new Error('تعذر قراءة طابور SQLite؛ أُوقفت تسوية المزامنة لتجنب اعتماد سجلات لها عمليات معلقة: ' + String(error));
    }
  }
  const canMark = (kind: 'products' | 'customers' | 'suppliers' | 'orders' | 'purchases', id: any) => !pendingRefs[kind].has(String(id));

  if (isNativeAndroid()) {
    await reconcileNativeOperationAfterAck(type, payload, operationId, serverResult, pendingRefs);
    return;
  }

  if (type === 'sale') {
    const orderId = String(payload?.order?.id || '');
    if (orderId && canMark('orders', orderId)) {
      await db.orders.update(orderId, { syncStatus: 'synced' });
      await markRowsSynced(db.orderItems, (row) => String(row.orderId) === orderId);
      await markRowsSynced(db.loyaltyTransactions, (row) => String(row.orderId) === orderId);
      await markOrderInventoryRowsSynced(orderId, pendingRefs);
    }
    for (const item of payload?.items || []) {
      if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
    }
    if (payload?.order?.customerId && canMark('customers', payload.order.customerId)) await db.customers.update(Number(payload.order.customerId), { syncStatus: 'synced' });
  } else if (type === 'return') {
    const returnId = String(payload?.id || '');
    const orderId = String(payload?.originalOrderId || '');
    if (returnId) { await db.returns.update(returnId, { syncStatus: 'synced' }); await markRowsSynced(db.returnItems, (row) => String(row.returnId) === returnId); }
    if (orderId && canMark('orders', orderId)) { await db.orders.update(orderId, { syncStatus: 'synced' }); await markRowsSynced(db.orderItems, (row) => String(row.orderId) === orderId); await markOrderInventoryRowsSynced(orderId, pendingRefs); }
    if (orderId) { const originalOrder = await db.orders.get(orderId); if (originalOrder?.customerId && canMark('customers', originalOrder.customerId)) await db.customers.update(Number(originalOrder.customerId), { syncStatus: 'synced' }); }
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
  } else if (type === 'order_void') {
    const orderId = String(payload?.orderId || payload?.id || '');
    if (orderId && canMark('orders', orderId)) { await db.orders.update(orderId, { syncStatus: 'synced' }); await markRowsSynced(db.orderItems, (row) => String(row.orderId) === orderId); await markOrderInventoryRowsSynced(orderId, pendingRefs); }
    if (orderId) { const originalOrder = await db.orders.get(orderId); if (originalOrder?.customerId && canMark('customers', originalOrder.customerId)) await db.customers.update(Number(originalOrder.customerId), { syncStatus: 'synced' }); }
  } else if (type === 'purchase' || type === 'purchase_update') {
    const purchaseId = String(payload?.purchase?.id || '');
    if (purchaseId && canMark('purchases', purchaseId)) { await db.purchases.update(purchaseId, { syncStatus: 'synced' }); await markRowsSynced(db.purchaseItems, (row) => String(row.purchaseId) === purchaseId); await markRowsSynced(db.inventoryBatches, (row) => String(row.purchaseId) === purchaseId && !pendingRefs.batches.has(String(row.id)) && !pendingRefs.products.has(String(row.productId))); }
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
    for (const productId of payload?._localAffectedProductIds || []) if (canMark('products', productId)) await db.products.update(Number(productId), { syncStatus: 'synced' });
    if (payload?.purchase?.supplierId && canMark('suppliers', payload.purchase.supplierId)) await db.suppliers.update(Number(payload.purchase.supplierId), { syncStatus: 'synced' });
    if (payload?._localAffectedSupplierId && canMark('suppliers', payload._localAffectedSupplierId)) await db.suppliers.update(Number(payload._localAffectedSupplierId), { syncStatus: 'synced' });
  } else if (type === 'purchase_delete') {
    for (const productId of payload?._localAffectedProductIds || []) if (canMark('products', productId)) await db.products.update(Number(productId), { syncStatus: 'synced' });
    if (payload?._localAffectedSupplierId && canMark('suppliers', payload._localAffectedSupplierId)) await db.suppliers.update(Number(payload._localAffectedSupplierId), { syncStatus: 'synced' });
  } else if (type === 'purchase_return') {
    const returnId = String(payload?.id || '');
    const purchaseId = String(payload?.originalPurchaseId || '');
    if (returnId) { await db.purchaseReturns.update(returnId, { syncStatus: 'synced' }); await markRowsSynced(db.purchaseReturnItems, (row) => String(row.purchaseReturnId) === returnId); }
    if (purchaseId && canMark('purchases', purchaseId)) await db.purchases.update(purchaseId, { syncStatus: 'synced' });
    const originalPurchase = purchaseId ? await db.purchases.get(purchaseId) : undefined;
    if (originalPurchase?.supplierId && canMark('suppliers', originalPurchase.supplierId)) await db.suppliers.update(Number(originalPurchase.supplierId), { syncStatus: 'synced' });
    const returnedProductIds = new Set((payload?.items || []).map((item: any) => String(item.productId)));
    if (purchaseId) await markRowsSynced(db.inventoryBatches, (batch) => String(batch.purchaseId) === purchaseId && returnedProductIds.has(String(batch.productId)) && !pendingRefs.batches.has(String(batch.id)) && !pendingRefs.products.has(String(batch.productId)));
    for (const item of payload?.items || []) {
      if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
      if (item.batchId && !pendingRefs.batches.has(String(item.batchId)) && !pendingRefs.products.has(String(item.productId))) await db.inventoryBatches.update(String(item.batchId), { syncStatus: 'synced' });
    }
  } else if (type === 'expense') {
    if (payload?.id !== undefined) await db.expenses.update(Number(payload.id), { syncStatus: 'synced' });
  } else if (type === 'customer_payment') {
    const paymentId = String(payload?.paymentId || operationId);
    await db.customerPayments.update(paymentId, { syncStatus: 'synced' });
    if (payload?.customerId && canMark('customers', payload.customerId)) await db.customers.update(Number(payload.customerId), { syncStatus: 'synced' });
    if (payload?.orderId && canMark('orders', payload.orderId)) await db.orders.update(String(payload.orderId), { syncStatus: 'synced' });
  } else if (type === 'supplier_payment') {
    const paymentId = String(payload?.paymentId || operationId);
    await db.supplierPayments.update(paymentId, { syncStatus: 'synced' });
    if (payload?.supplierId && canMark('suppliers', payload.supplierId)) await db.suppliers.update(Number(payload.supplierId), { syncStatus: 'synced' });
    if (payload?.purchaseId && canMark('purchases', payload.purchaseId)) await db.purchases.update(String(payload.purchaseId), { syncStatus: 'synced' });
  } else if (type === 'payroll') {
    if (payload?.id !== undefined) await db.payroll.update(Number(payload.id), { syncStatus: 'synced' });
  } else if (type === 'shift_open' || type === 'shift_close') {
    if (payload?.id !== undefined) await db.shifts.update(String(payload.id), { syncStatus: 'synced' });
  } else if (type === 'shift_movement') {
    if (payload?.id !== undefined) await db.shiftMovements.update(String(payload.id), { syncStatus: 'synced' });
  } else if (type === 'stocktake_approve') {
    if (payload?.sessionId) {
      const sessionId = String(payload.sessionId);
      await db.stocktakingSessions.update(sessionId, { syncStatus: 'synced' });
      const entries = await db.stocktakingEntries.where('sessionId').equals(sessionId).toArray();
      await markRowsSynced(db.stocktakingEntries, (row) => String(row.sessionId) === sessionId);
      for (const entry of entries) {
        if (canMark('products', entry.productId)) {
          await db.products.update(Number(entry.productId), { syncStatus: 'synced' });
          await markRowsSynced(db.inventoryBatches, (batch) => Number(batch.productId) === Number(entry.productId) && !pendingRefs.batches.has(String(batch.id)) && !pendingRefs.products.has(String(batch.productId)));
        }
      }
    }
  } else if (type === 'entity_upsert') {
    const table = (db as any)[payload?.table];
    const serverId = serverResult?.id ?? payload?.record?.id;
    if (table && serverId !== undefined) {
      if (payload?.record?.id !== undefined && payload.record.id !== serverId) {
        await table.delete(payload.record.id).catch(() => {});
        if (payload?.table === 'products') await db.inventoryBatches.where('productId').equals(Number(payload.record.id)).delete();
      }
      if (payload?.table === 'products') {
        await db.products.update(Number(serverId), { syncStatus: 'synced' });
        await markRowsSynced(db.inventoryBatches, (batch) => Number(batch.productId) === Number(serverId) && !pendingRefs.batches.has(String(batch.id)) && !pendingRefs.products.has(String(batch.productId)));
      } else {
        await table.update(serverId, { syncStatus: 'synced' });
      }
    }
  }
  await mirrorNativePosDatabase().catch((error) => console.warn('SQLite reconciliation snapshot failed:', error));
}
