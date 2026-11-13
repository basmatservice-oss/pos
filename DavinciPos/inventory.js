import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';

function assertQuantity(value, label='quantity') {
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0) throw new Error(`Invalid ${label}.`);
  return n;
}
function assertCost(value) {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0) throw new Error('Unit cost must be a non-negative integer in minor currency units.');
  return n;
}
function sameBranchClause(branchId) { return branchId ? {sql:'branch_id=?',params:[branchId]} : {sql:'branch_id IS NULL',params:[]}; }

export function getStockOnHand(productId, branchId=null) {
  const b=sameBranchClause(branchId);
  const row=db.prepare(`SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE product_id=? AND ${b.sql}`).get(productId,...b.params);
  return Number(row.quantity);
}
export function getInventoryValue(productId, branchId=null) {
  const b=sameBranchClause(branchId);
  const row=db.prepare(`SELECT COALESCE(SUM(CASE WHEN quantity_delta>0 THEN cost_total_minor ELSE -cost_total_minor END),0) AS value
    FROM stock_movements WHERE product_id=? AND ${b.sql}`).get(productId,...b.params);
  return Number(row.value);
}
export function getWeightedAverageCost(productId, branchId=null) {
  const quantity=getStockOnHand(productId,branchId);
  if(quantity<=0) return 0;
  return Math.max(0,Math.round(getInventoryValue(productId,branchId)/quantity));
}
export function receiveStock({productId,branchId=null,sourceType,sourceId,quantity,unitCostMinor,occurredAt=new Date().toISOString()}) {
  quantity=assertQuantity(quantity); unitCostMinor=assertCost(unitCostMinor);
  if(!productId||!sourceType||!sourceId) throw new Error('Stock receipt requires product and source references.');
  return inTransaction(()=>{
    const product=db.prepare('SELECT id,track_stock FROM products WHERE id=?').get(productId);
    if(!product) throw new Error('Product not found.');
    if(!product.track_stock) throw new Error('Cannot receive stock for a non-stock product.');
    const id=randomUUID(), total=Math.round(quantity*unitCostMinor);
    db.prepare(`INSERT INTO stock_movements(id,product_id,branch_id,source_type,source_id,quantity_delta,unit_cost_minor,cost_total_minor,cost_method,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,'opening',?)`).run(id,productId,branchId,sourceType,sourceId,quantity,unitCostMinor,total,occurredAt);
    db.prepare(`INSERT INTO inventory_layers(id,product_id,branch_id,source_type,source_id,received_quantity,remaining_quantity,unit_cost_minor,received_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(),productId,branchId,sourceType,sourceId,quantity,quantity,unitCostMinor,occurredAt);
    return {movementId:id,quantity,costTotalMinor:total};
  });
}
export function issueStock({productId,branchId=null,sourceType,sourceId,quantity,costMethod,occurredAt=new Date().toISOString()}) {
  quantity=assertQuantity(quantity);
  if(!['weighted','fifo'].includes(costMethod)) throw new Error('Cost method must be weighted or fifo.');
  if(!productId||!sourceType||!sourceId) throw new Error('Stock issue requires product and source references.');
  return inTransaction(()=>{
    const available=getStockOnHand(productId,branchId);
    if(available+1e-9<quantity) throw new Error(`Insufficient stock. Available: ${available}`);
    let totalCost=0;
    if(costMethod==='weighted') {
      const avg=getWeightedAverageCost(productId,branchId);
      totalCost=Math.round(quantity*avg);
      const b=sameBranchClause(branchId);
      const layers=db.prepare(`SELECT id,remaining_quantity FROM inventory_layers WHERE product_id=? AND ${b.sql} AND remaining_quantity>0 ORDER BY received_at,id`).all(productId,...b.params);
      let left=quantity;
      for(let i=0;i<layers.length&&left>1e-9;i++){
        const take=Math.min(left,layers[i].remaining_quantity);
        db.prepare('UPDATE inventory_layers SET remaining_quantity=remaining_quantity-? WHERE id=?').run(take,layers[i].id);
        left-=take;
      }
    } else {
      const b=sameBranchClause(branchId);
      const layers=db.prepare(`SELECT id,remaining_quantity,unit_cost_minor FROM inventory_layers WHERE product_id=? AND ${b.sql} AND remaining_quantity>0 ORDER BY received_at,id`).all(productId,...b.params);
      let left=quantity;
      for(const layer of layers){
        if(left<=1e-9) break;
        const take=Math.min(left,layer.remaining_quantity);
        totalCost+=Math.round(take*layer.unit_cost_minor);
        db.prepare('UPDATE inventory_layers SET remaining_quantity=remaining_quantity-? WHERE id=?').run(take,layer.id);
        left-=take;
      }
      if(left>1e-7) throw new Error('Inventory cost layers do not reconcile with on-hand quantity.');
    }
    const unitCost=Math.round(totalCost/quantity), id=randomUUID();
    db.prepare(`INSERT INTO stock_movements(id,product_id,branch_id,source_type,source_id,quantity_delta,unit_cost_minor,cost_total_minor,cost_method,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,productId,branchId,sourceType,sourceId,-quantity,unitCost,totalCost,costMethod,occurredAt);
    return {movementId:id,quantity,costMethod,costTotalMinor:totalCost,unitCostMinor:unitCost};
  });
}
export function getProductCostPreview(productId,branchId=null) {
  return {quantity:getStockOnHand(productId,branchId),inventoryValueMinor:getInventoryValue(productId,branchId),
    weightedAverageUnitCostMinor:getWeightedAverageCost(productId,branchId)};
}
