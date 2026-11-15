import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';
import { postJournalEntry } from './accounting.js';
import { setting } from './settings.js';

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
      const layers=db.prepare(`SELECT id,remaining_quantity FROM inventory_layers WHERE product_id=? AND ${b.sql} AND remaining_quantity>0 ORDER BY received_at,rowid`).all(productId,...b.params);
      let left=quantity;
      for(let i=0;i<layers.length&&left>1e-9;i++){
        const take=Math.min(left,layers[i].remaining_quantity);
        db.prepare('UPDATE inventory_layers SET remaining_quantity=remaining_quantity-? WHERE id=?').run(take,layers[i].id);
        left-=take;
      }
      if(left>1e-7)throw new Error('Inventory cost layers do not reconcile with on-hand quantity.');
    } else {
      const b=sameBranchClause(branchId);
      const layers=db.prepare(`SELECT id,remaining_quantity,unit_cost_minor FROM inventory_layers WHERE product_id=? AND ${b.sql} AND remaining_quantity>0 ORDER BY received_at,rowid`).all(productId,...b.params);
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

export function configureInventoryCostMethod(method) {
  if(!['weighted','fifo'].includes(method)) throw new Error('Cost method must be weighted or fifo.');
  const current=db.prepare("SELECT value FROM app_settings WHERE key='inventory.cost_method'").get()?.value||'weighted';
  if(current===method) return {method,changed:false};
  const history=db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count;
  if(history>0) throw new Error('Cost method is locked after inventory movements exist. Use a controlled inventory revaluation/migration to change it safely.');
  db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('inventory.cost_method',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(method,new Date().toISOString());
  return {method,changed:true};
}

export function adjustInventory({id=randomUUID(),productId,branchId=null,quantityDelta,unitCostMinor=0,reason='Inventory adjustment',occurredAt=new Date().toISOString(),userId=null}) {
  const delta=Number(quantityDelta);
  if(!productId||!Number.isFinite(delta)||delta===0)throw new Error('A product and non-zero quantity adjustment are required.');
  if(typeof reason!=='string'||!reason.trim())throw new Error('Adjustment reason is required.');
  return inTransaction(()=>{
    const existing=db.prepare("SELECT id FROM stock_movements WHERE source_type='adjustment' AND source_id=?").get(id);
    if(existing)return {id,duplicate:true};
    let result;
    if(delta>0) {
      const cost=assertCost(unitCostMinor);
      result=receiveStock({productId,branchId,sourceType:'adjustment',sourceId:id,quantity:delta,unitCostMinor:cost,occurredAt});
      if(result.costTotalMinor>0)postJournalEntry({sourceType:'inventory_adjustment',sourceId:id,description:reason,occurredAt,lines:[
        {accountId:'acc-inventory',debitMinor:result.costTotalMinor},
        {accountId:'acc-stock-adjustment-gain',creditMinor:result.costTotalMinor}
      ]});
    } else {
      const method=setting('inventory.cost_method','weighted');
      result=issueStock({productId,branchId,sourceType:'adjustment',sourceId:id,quantity:Math.abs(delta),costMethod:method,occurredAt});
      if(result.costTotalMinor>0)postJournalEntry({sourceType:'inventory_adjustment',sourceId:id,description:reason,occurredAt,lines:[
        {accountId:'acc-stock-adjustment-loss',debitMinor:result.costTotalMinor},
        {accountId:'acc-inventory',creditMinor:result.costTotalMinor}
      ]});
    }
    db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?)')
      .run(userId,'inventory.adjustment','product',productId,JSON.stringify({quantityDelta:delta,reason,costTotalMinor:result.costTotalMinor}),new Date().toISOString());
    return {id,duplicate:false,quantityDelta:delta,...result};
  });
}

export function createInventoryCount({branchId=getDefaultBranchId(),userId=null,productIds=null}={}){
  const id=randomUUID(),now=new Date().toISOString();
  return inTransaction(()=>{
    db.prepare("INSERT INTO inventory_counts(id,branch_id,status,opened_by,opened_at) VALUES(?,?,'draft',?,?)").run(id,branchId,userId,now);
    const products=Array.isArray(productIds)&&productIds.length
      ?db.prepare(`SELECT id FROM products WHERE is_active=1 AND track_stock=1 AND id IN (${productIds.map(()=>'?').join(',')}) ORDER BY name`).all(...productIds)
      :db.prepare('SELECT id FROM products WHERE is_active=1 AND track_stock=1 ORDER BY name').all();
    const insert=db.prepare('INSERT INTO inventory_count_lines(id,count_id,product_id,expected_quantity) VALUES(?,?,?,?)');
    for(const product of products)insert.run(randomUUID(),id,product.id,getStockOnHand(product.id,branchId));
    return {id,branchId,status:'draft',lineCount:products.length};
  });
}
export function getInventoryCount(id){
  const count=db.prepare('SELECT id,branch_id AS branchId,status,opened_at AS openedAt,posted_at AS postedAt FROM inventory_counts WHERE id=?').get(id);
  if(!count)throw new Error('Inventory count not found.');
  count.lines=db.prepare(`SELECT l.id,l.product_id AS productId,p.name,u.symbol AS unitSymbol,l.expected_quantity AS expectedQuantity,
    l.counted_quantity AS countedQuantity,CASE WHEN l.counted_quantity IS NULL THEN NULL ELSE l.counted_quantity-l.expected_quantity END AS difference
    FROM inventory_count_lines l JOIN products p ON p.id=l.product_id JOIN units u ON u.id=p.base_unit_id
    WHERE l.count_id=? ORDER BY p.name`).all(id);
  return count;
}
export function setInventoryCountLine(countId,productId,countedQuantity){
  const quantity=Number(countedQuantity);
  if(!Number.isFinite(quantity)||quantity<0)throw new Error('Counted quantity must be zero or greater.');
  const count=db.prepare("SELECT status FROM inventory_counts WHERE id=?").get(countId);
  if(!count)throw new Error('Inventory count not found.');
  if(count.status!=='draft')throw new Error('A posted inventory count cannot be changed.');
  const result=db.prepare('UPDATE inventory_count_lines SET counted_quantity=? WHERE count_id=? AND product_id=?').run(quantity,countId,productId);
  if(!result.changes)throw new Error('Product is not part of this inventory count.');
  return getInventoryCount(countId);
}
export function completeInventoryCount(countId,userId=null){
  return inTransaction(()=>{
    const count=db.prepare('SELECT * FROM inventory_counts WHERE id=?').get(countId);
    if(!count)throw new Error('Inventory count not found.');
    if(count.status==='posted')return {id:countId,duplicate:true,adjustments:[]};
    const lines=db.prepare('SELECT l.*,p.cost_minor FROM inventory_count_lines l JOIN products p ON p.id=l.product_id WHERE l.count_id=?').all(countId);
    if(!lines.length)throw new Error('This inventory count has no products.');
    if(lines.some(line=>line.counted_quantity===null))throw new Error('Enter the actual quantity for every product before posting.');
    const adjustments=[];
    for(const line of lines){
      const delta=Number(line.counted_quantity)-Number(line.expected_quantity);
      if(Math.abs(delta)<1e-9)continue;
      const adjustmentId=countId+'-'+line.product_id;
      const result=adjustInventory({id:adjustmentId,productId:line.product_id,branchId:count.branch_id,quantityDelta:delta,
        unitCostMinor:Math.max(0,Math.round(line.cost_minor||0)),reason:'Inventory count '+countId,userId});
      db.prepare('UPDATE inventory_count_lines SET adjustment_id=? WHERE id=?').run(adjustmentId,line.id);
      adjustments.push({productId:line.product_id,quantityDelta:delta,costTotalMinor:result.costTotalMinor});
    }
    const now=new Date().toISOString();
    db.prepare("UPDATE inventory_counts SET status='posted',posted_by=?,posted_at=? WHERE id=?").run(userId,now,countId);
    return {id:countId,duplicate:false,adjustments};
  });
}
export function listInventoryCounts({limit=50}={}){
 return db.prepare(`SELECT c.id,c.status,c.opened_at AS openedAt,c.posted_at AS postedAt,COUNT(l.id) AS products,
 SUM(CASE WHEN l.counted_quantity IS NOT NULL THEN 1 ELSE 0 END) AS countedProducts
 FROM inventory_counts c LEFT JOIN inventory_count_lines l ON l.count_id=c.id GROUP BY c.id ORDER BY c.opened_at DESC LIMIT ?`).all(Math.max(1,Math.min(200,Number(limit)||50)));
}
