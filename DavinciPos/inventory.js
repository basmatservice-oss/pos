import { randomUUID } from 'node:crypto';
import { db } from './database.js';

export function getStockOnHand(productId, branchId = null) {
  const row = branchId
    ? db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE product_id=? AND branch_id=?').get(productId, branchId)
    : db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE product_id=?').get(productId);
  return Number(row.quantity);
}

export function recordStockMovement({ productId, branchId = null, sourceType, sourceId, quantityDelta, unitCostMinor = 0, occurredAt = new Date().toISOString() }) {
  if (!Number.isFinite(quantityDelta) || quantityDelta === 0) throw new Error('Stock movement quantity must be a non-zero number.');
  if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) throw new Error('Invalid stock unit cost.');
  const id = randomUUID();
  db.prepare(`INSERT INTO stock_movements (id,product_id,branch_id,source_type,source_id,quantity_delta,unit_cost_minor,occurred_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, productId, branchId, sourceType, sourceId, quantityDelta, unitCostMinor, occurredAt);
  return id;
}
