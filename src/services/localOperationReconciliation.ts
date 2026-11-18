import { db } from '../db/db';
import { removeLocalInventoryArtifactsForOperation } from './localInventoryEngine';
import { removeLocalJournalEntriesForReference } from './localAccountingEngine';

function collectPendingReferences(value: any, refs: Record<string, Set<string>>) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'number' || typeof child === 'string') {
      if (key === 'productId' || key === 'ingredientProductId') refs.products.add(String(child));
      if (key === 'customerId') refs.customers.add(String(child));
      if (key === 'supplierId') refs.suppliers.add(String(child));
    } else if (child && typeof child === 'object') collectPendingReferences(child, refs);
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
  if (batchIds.size) await markRowsSynced(db.inventoryBatches, (batch) => batchIds.has(String(batch.id)));
}

export async function reconcileLocalOperationAfterAck(type: string, payload: any, operationId: string) {
  const referenceId = String(payload?.order?.id || payload?.purchase?.id || payload?.orderId || payload?.id || payload?.paymentId || operationId);
  await removeLocalJournalEntriesForReference(referenceId);
  await removeLocalInventoryArtifactsForOperation(operationId);

  const pending = await db.syncOperations.where('status').anyOf(['pending', 'error', 'syncing']).toArray();
  const pendingRefs = { products: new Set<string>(), customers: new Set<string>(), suppliers: new Set<string>() };
  for (const operation of pending) collectPendingReferences(operation.payload, pendingRefs);
  const canMark = (kind: 'products' | 'customers' | 'suppliers', id: any) => !pendingRefs[kind].has(String(id));

  if (type === 'sale') {
    const orderId = String(payload?.order?.id || '');
    if (orderId) {
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
    if (orderId) { await db.orders.update(orderId, { syncStatus: 'synced' }); await markRowsSynced(db.orderItems, (row) => String(row.orderId) === orderId); await markOrderInventoryRowsSynced(orderId, pendingRefs); }
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
  } else if (type === 'order_void') {
    const orderId = String(payload?.orderId || payload?.id || '');
    if (orderId) { await db.orders.update(orderId, { syncStatus: 'synced' }); await markRowsSynced(db.orderItems, (row) => String(row.orderId) === orderId); }
  } else if (type === 'purchase' || type === 'purchase_update') {
    const purchaseId = String(payload?.purchase?.id || '');
    if (purchaseId) { await db.purchases.update(purchaseId, { syncStatus: 'synced' }); await markRowsSynced(db.purchaseItems, (row) => String(row.purchaseId) === purchaseId); await markRowsSynced(db.inventoryBatches, (row) => String(row.purchaseId) === purchaseId); }
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
    if (payload?.purchase?.supplierId && canMark('suppliers', payload.purchase.supplierId)) await db.suppliers.update(Number(payload.purchase.supplierId), { syncStatus: 'synced' });
  } else if (type === 'purchase_delete') {
    // The deleted purchase and its child rows no longer need local push status.
  } else if (type === 'purchase_return') {
    const returnId = String(payload?.id || '');
    const purchaseId = String(payload?.originalPurchaseId || '');
    if (returnId) { await db.purchaseReturns.update(returnId, { syncStatus: 'synced' }); await markRowsSynced(db.purchaseReturnItems, (row) => String(row.purchaseReturnId) === returnId); }
    if (purchaseId) await db.purchases.update(purchaseId, { syncStatus: 'synced' });
    for (const item of payload?.items || []) if (canMark('products', item.productId)) await db.products.update(Number(item.productId), { syncStatus: 'synced' });
  } else if (type === 'expense') {
    if (payload?.id !== undefined) await db.expenses.update(Number(payload.id), { syncStatus: 'synced' });
  } else if (type === 'customer_payment') {
    const paymentId = String(payload?.paymentId || operationId);
    await db.customerPayments.update(paymentId, { syncStatus: 'synced' });
    if (payload?.customerId && canMark('customers', payload.customerId)) await db.customers.update(Number(payload.customerId), { syncStatus: 'synced' });
    if (payload?.orderId) await db.orders.update(String(payload.orderId), { syncStatus: 'synced' });
  } else if (type === 'supplier_payment') {
    const paymentId = String(payload?.paymentId || operationId);
    await db.supplierPayments.update(paymentId, { syncStatus: 'synced' });
    if (payload?.supplierId && canMark('suppliers', payload.supplierId)) await db.suppliers.update(Number(payload.supplierId), { syncStatus: 'synced' });
    if (payload?.purchaseId) await db.purchases.update(String(payload.purchaseId), { syncStatus: 'synced' });
  } else if (type === 'payroll') {
    if (payload?.id !== undefined) await db.payroll.update(Number(payload.id), { syncStatus: 'synced' });
  } else if (type === 'shift_open' || type === 'shift_close') {
    if (payload?.id !== undefined) await db.shifts.update(String(payload.id), { syncStatus: 'synced' });
  } else if (type === 'shift_movement') {
    if (payload?.id !== undefined) await db.shiftMovements.update(String(payload.id), { syncStatus: 'synced' });
  } else if (type === 'stocktake_approve') {
    if (payload?.sessionId) { await db.stocktakingSessions.update(String(payload.sessionId), { syncStatus: 'synced' }); await markRowsSynced(db.stocktakingEntries, (row) => String(row.sessionId) === String(payload.sessionId)); }
  } else if (type === 'entity_upsert') {
    const table = (db as any)[payload?.table];
    if (table && payload?.record?.id !== undefined) await table.update(payload.record.id, { syncStatus: 'synced' });
  }
}
