import { randomUUID } from 'node:crypto';
import { db, inTransaction, getDefaultBranchId } from './database.js';
import { issueStock, receiveStock, restoreFifoAllocation } from './inventory.js';
import { postJournalEntry } from './accounting.js';
import { setting } from './settings.js';

const paymentAccounts={cash:'acc-cash',card:'acc-card',bank:'acc-bank',wallet:'acc-wallet',other:'acc-other-clearing'};
const walletProviders=new Set(['bankak','ocash','fawry','mycashy']);
const money=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid '+label+'.');return n;};
function validateRefundMethod(method,provider){
  method=method||'cash';
  if(!paymentAccounts[method])throw new Error('Unsupported refund method.');
  if(method==='wallet'&&!walletProviders.has(provider))throw new Error('Select a supported wallet provider.');
  if(provider&&!walletProviders.has(provider))throw new Error('Unsupported wallet provider.');
  if(method!=='wallet'&&provider)throw new Error('A wallet provider is only valid for wallet refunds.');
  return {method,provider:provider||null};
}
function audit(userId,action,id,details){
  if(!userId)return;
  db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(),userId,action,'return',id,JSON.stringify(details),new Date().toISOString());
}
function returnedQuantity(table,lineColumn,lineId){
  return Number(db.prepare('SELECT COALESCE(SUM(quantity),0) AS quantity FROM '+table+' WHERE '+lineColumn+'=?').get(lineId).quantity);
}
function saleOptions(saleId){
  const sale=db.prepare('SELECT id,receipt_number AS reference,branch_id AS branchId,customer_id AS customerId,total_minor AS totalMinor,status,occurred_at AS occurredAt FROM sales WHERE id=?').get(saleId);
  if(!sale||!['posted','partially_returned'].includes(sale.status))throw new Error('Sales invoice not found or not eligible for return.');
  const lines=db.prepare(`
    SELECT sl.id,sl.item_id AS productId,sl.description,sl.line_type AS lineType,sl.quantity,sl.base_quantity AS baseQuantity,
      sl.line_total_minor AS amountMinor,sl.tax_minor AS taxMinor,sl.cost_total_minor AS costMinor,
      COALESCE(p.track_stock,0) AS trackStock
    FROM sale_lines sl LEFT JOIN products p ON p.id=sl.item_id
    WHERE sl.sale_id=? AND sl.line_type='product' ORDER BY sl.description
  `).all(saleId).map(line=>{
    const alreadyReturned=returnedQuantity('sales_return_lines','sale_line_id',line.id);
    return {...line,returnedQuantity:alreadyReturned,remainingQuantity:Math.max(0,line.quantity-alreadyReturned)};
  }).filter(line=>line.remainingQuantity>1e-9);
  if(!lines.length)throw new Error('This invoice has no remaining returnable product quantities.');
  return {sale,lines};
}
function purchaseOptions(purchaseId){
  const purchase=db.prepare(`
    SELECT id,invoice_number AS reference,branch_id AS branchId,supplier_id AS supplierId,total_minor AS totalMinor,
      tax_minor AS taxMinor,tax_treatment AS taxTreatment,status,occurred_at AS occurredAt
    FROM purchases WHERE id=?`).get(purchaseId);
  if(!purchase||purchase.status!=='posted'||!purchase.supplierId)throw new Error('Purchase invoice not found or it has no supplier.');
  const lines=db.prepare(`
    SELECT pl.id,pl.product_id AS productId,p.name AS description,pl.quantity,pl.base_quantity AS baseQuantity,
      pl.line_total_minor AS netMinor,pl.tax_minor AS taxMinor,pl.unit_cost_minor AS unitCostMinor
    FROM purchase_lines pl JOIN products p ON p.id=pl.product_id
    WHERE pl.purchase_id=? ORDER BY p.name
  `).all(purchaseId).map(line=>{
    const alreadyReturned=returnedQuantity('purchase_return_lines','purchase_line_id',line.id);
    return {...line,returnedQuantity:alreadyReturned,remainingQuantity:Math.max(0,line.quantity-alreadyReturned)};
  }).filter(line=>line.remainingQuantity>1e-9);
  if(!lines.length)throw new Error('This invoice has no remaining returnable quantities.');
  return {purchase,lines};
}
export function getSalesReturnOptions(saleId){return saleOptions(saleId);}
export function getPurchaseReturnOptions(purchaseId){return purchaseOptions(purchaseId);}

export function createSalesReturn(saleId,input={},userId=null){
  const id=input.id||randomUUID(),now=input.occurredAt||new Date().toISOString();
  const refund=validateRefundMethod(input.refundMethod,input.provider);
  if(!Array.isArray(input.lines)||!input.lines.length)throw new Error('Select at least one item to return.');
  if(input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.length>300))throw new Error('Return reason must be 300 characters or fewer.');
  return inTransaction(()=>{
    const existing=db.prepare('SELECT id,return_number,total_minor AS totalMinor,refund_minor AS refundMinor FROM sales_returns WHERE id=?').get(id);
    if(existing)return {...existing,duplicate:true};
    const {sale}=saleOptions(saleId);
    const selected=new Set();
    const details=[];
    for(const entry of input.lines){
      if(!entry||typeof entry.saleLineId!=='string'||selected.has(entry.saleLineId))throw new Error('Invalid or duplicate sales return line.');
      selected.add(entry.saleLineId);
      const line=db.prepare(`
        SELECT sl.*,p.track_stock FROM sale_lines sl JOIN products p ON p.id=sl.item_id
        WHERE sl.id=? AND sl.sale_id=? AND sl.line_type='product'`).get(entry.saleLineId,saleId);
      if(!line)throw new Error('A selected item does not belong to this invoice or is not returnable.');
      const quantity=Number(entry.quantity);
      if(!Number.isFinite(quantity)||quantity<=0)throw new Error('Return quantity must be greater than zero.');
      const already=returnedQuantity('sales_return_lines','sale_line_id',line.id);
      const remainingQuantity=line.quantity-already;
      if(quantity>remainingQuantity+1e-9)throw new Error('Return quantity exceeds the unreturned quantity for '+line.description+'.');
      const prior=db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS amountMinor,COALESCE(SUM(tax_minor),0) AS taxMinor FROM sales_return_lines WHERE sale_line_id=?').get(line.id);
      const ratio=quantity/line.quantity,finalReturn=quantity>=remainingQuantity-1e-9;
      const amountMinor=finalReturn?line.line_total_minor-prior.amountMinor:Math.round(line.line_total_minor*ratio);
      const taxMinor=finalReturn?line.tax_minor-prior.taxMinor:Math.min(amountMinor,Math.round(line.tax_minor*ratio));
      const baseQuantity=Number(line.base_quantity||0)*ratio;
      details.push({line,quantity,baseQuantity,amountMinor,taxMinor});
    }
    const totalMinor=details.reduce((sum,line)=>sum+line.amountMinor,0);
    const taxMinor=details.reduce((sum,line)=>sum+line.taxMinor,0);
    if(!Number.isSafeInteger(totalMinor)||totalMinor<=0)throw new Error('Return value must be greater than zero.');
    const received=db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_minor ELSE -amount_minor END),0) AS total FROM payments WHERE sale_id=?").get(saleId).total;
    const refundMinor=Math.min(totalMinor,Math.max(0,received));
    const returnNumber=input.returnNumber||'SR-'+Date.now()+'-'+randomUUID().slice(0,8).toUpperCase();
    db.prepare(`INSERT INTO sales_returns(id,sale_id,return_number,branch_id,total_minor,tax_minor,refund_minor,refund_method,reference,reason,created_by,occurred_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,saleId,returnNumber,sale.branchId||getDefaultBranchId(),totalMinor,taxMinor,refundMinor,refundMinor?refund.method:null,input.reference||null,input.reason||'Customer return',userId,now,new Date().toISOString());
    const insert=db.prepare('INSERT INTO sales_return_lines(id,return_id,sale_line_id,quantity,base_quantity,amount_minor,tax_minor,cost_minor) VALUES(?,?,?,?,?,?,?,?)');
    let restoredCost=0;
    for(const detail of details){
      let costMinor=0;
      if(detail.line.track_stock&&detail.baseQuantity>0){
        const branchId=sale.branchId||getDefaultBranchId();
        const layers=db.prepare(`SELECT id,inventory_layer_id AS layerId,quantity,returned_quantity AS returnedQuantity,unit_cost_minor AS unitCostMinor,cost_total_minor AS costTotalMinor,returned_cost_minor AS returnedCostMinor
          FROM sale_line_cost_layers WHERE sale_line_id=? AND returned_quantity<quantity ORDER BY rowid`).all(detail.line.id);
        if(layers.length){
          let remaining=detail.baseQuantity;
          const allocations=[];
          for(const layer of layers){
            if(remaining<=1e-9)break;
            const available=Number(layer.quantity)-Number(layer.returnedQuantity);
            const take=Math.min(remaining,available);
            if(take<=1e-9)continue;
            const remainingCost=Number(layer.costTotalMinor)-Number(layer.returnedCostMinor);
            const allocationCost=take>=available-1e-9?remainingCost:Math.round(Number(layer.costTotalMinor)*take/Number(layer.quantity));
            db.prepare('UPDATE sale_line_cost_layers SET returned_quantity=returned_quantity+?,returned_cost_minor=returned_cost_minor+? WHERE id=?').run(take,allocationCost,layer.id);
            allocations.push({layerId:layer.layerId,quantity:take,unitCostMinor:Number(layer.unitCostMinor),costTotalMinor:allocationCost});
            remaining-=take;
          }
          if(remaining>1e-7)throw new Error('FIFO return quantity does not reconcile with the original sale cost layers.');
          const restored=restoreFifoAllocation({productId:detail.line.item_id,branchId,sourceType:'sale_return',sourceId:id+'-'+detail.line.id,allocations,occurredAt:now});
          costMinor=restored.costTotalMinor;
        }else{
          const receivedStock=receiveStock({productId:detail.line.item_id,branchId,sourceType:'sale_return',sourceId:id+'-'+detail.line.id,quantity:detail.baseQuantity,unitCostMinor:detail.line.unit_cost_minor,occurredAt:now});
          costMinor=receivedStock.costTotalMinor;
        }
      }
      restoredCost+=costMinor;
      insert.run(randomUUID(),id,detail.line.id,detail.quantity,detail.baseQuantity,detail.amountMinor,detail.taxMinor,costMinor);
    }
    if(refundMinor>0)db.prepare("INSERT INTO payments(id,sale_id,direction,method,amount_minor,reference,provider,occurred_at) VALUES(?,?,'out',?,?,?,?,?)")
      .run(randomUUID(),saleId,refund.method,refundMinor,input.reference||null,refund.provider,now);
    const netMinor=totalMinor-taxMinor,receivableReduction=totalMinor-refundMinor;
    const journal=[];
    if(netMinor>0)journal.push({accountId:'acc-sales-returns',debitMinor:netMinor});
    if(taxMinor>0)journal.push({accountId:'acc-tax',debitMinor:taxMinor});
    if(refundMinor>0)journal.push({accountId:paymentAccounts[refund.method],creditMinor:refundMinor});
    if(receivableReduction>0)journal.push({accountId:'acc-ar',creditMinor:receivableReduction});
    if(restoredCost>0){journal.push({accountId:'acc-inventory',debitMinor:restoredCost});journal.push({accountId:'acc-cogs',creditMinor:restoredCost});}
    postJournalEntry({sourceType:'sales_return',sourceId:id,description:'Sales return '+returnNumber,occurredAt:now,lines:journal});
    const remaining=db.prepare(`SELECT COUNT(*) AS count FROM sale_lines sl
      WHERE sl.sale_id=? AND sl.line_type='product' AND sl.quantity>(
        SELECT COALESCE(SUM(srl.quantity),0) FROM sales_return_lines srl WHERE srl.sale_line_id=sl.id
      )+0.000000001`).get(saleId).count;
    db.prepare("UPDATE sales SET status=? WHERE id=?").run(remaining===0?'returned':'partially_returned',saleId);
    audit(userId,'sales.return',id,{saleId,totalMinor,refundMinor,restoredCost,lines:details.map(x=>({saleLineId:x.line.id,quantity:x.quantity}))});
    return {id,returnNumber,saleId,totalMinor,taxMinor,refundMinor,receivableReductionMinor:receivableReduction,restoredCostMinor:restoredCost,duplicate:false};
  });
}

export function createPurchaseReturn(purchaseId,input={},userId=null){
  const id=input.id||randomUUID(),now=input.occurredAt||new Date().toISOString();
  const refund=validateRefundMethod(input.refundMethod,input.provider);
  if(!Array.isArray(input.lines)||!input.lines.length)throw new Error('Select at least one item to return.');
  if(input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.length>300))throw new Error('Return reason must be 300 characters or fewer.');
  return inTransaction(()=>{
    const existing=db.prepare('SELECT id,return_number,total_minor AS totalMinor,refund_minor AS refundMinor FROM purchase_returns WHERE id=?').get(id);
    if(existing)return {...existing,duplicate:true};
    const {purchase}=purchaseOptions(purchaseId);
    const selected=new Set(),details=[];
    for(const entry of input.lines){
      if(!entry||typeof entry.purchaseLineId!=='string'||selected.has(entry.purchaseLineId))throw new Error('Invalid or duplicate purchase return line.');
      selected.add(entry.purchaseLineId);
      const line=db.prepare('SELECT * FROM purchase_lines WHERE id=? AND purchase_id=?').get(entry.purchaseLineId,purchaseId);
      if(!line)throw new Error('A selected item does not belong to this purchase invoice.');
      const quantity=Number(entry.quantity);
      if(!Number.isFinite(quantity)||quantity<=0)throw new Error('Return quantity must be greater than zero.');
      const already=returnedQuantity('purchase_return_lines','purchase_line_id',line.id);
      const remainingQuantity=line.quantity-already;
      if(quantity>remainingQuantity+1e-9)throw new Error('Return quantity exceeds the unreturned quantity.');
      const prior=db.prepare('SELECT COALESCE(SUM(amount_minor-tax_minor),0) AS netMinor,COALESCE(SUM(tax_minor),0) AS taxMinor FROM purchase_return_lines WHERE purchase_line_id=?').get(line.id);
      const ratio=quantity/line.quantity,finalReturn=quantity>=remainingQuantity-1e-9;
      const netMinor=finalReturn?line.line_total_minor-prior.netMinor:Math.round(line.line_total_minor*ratio);
      const taxMinor=finalReturn?line.tax_minor-prior.taxMinor:Math.round(line.tax_minor*ratio);
      details.push({line,quantity,baseQuantity:line.base_quantity*ratio,netMinor,taxMinor,amountMinor:netMinor+taxMinor});
    }
    const totalMinor=details.reduce((sum,line)=>sum+line.amountMinor,0),taxMinor=details.reduce((sum,line)=>sum+line.taxMinor,0);
    if(!Number.isSafeInteger(totalMinor)||totalMinor<=0)throw new Error('Return value must be greater than zero.');
    const paid=db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='out' THEN amount_minor ELSE -amount_minor END),0) AS total FROM purchase_payments WHERE purchase_id=?").get(purchaseId).total;
    const refundMinor=Math.min(totalMinor,Math.max(0,paid));
    const returnNumber=input.returnNumber||'PR-'+Date.now()+'-'+randomUUID().slice(0,8).toUpperCase();
    db.prepare(`INSERT INTO purchase_returns(id,purchase_id,return_number,branch_id,total_minor,tax_minor,refund_minor,refund_method,reference,reason,created_by,occurred_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,purchaseId,returnNumber,purchase.branchId||getDefaultBranchId(),totalMinor,taxMinor,refundMinor,refundMinor?refund.method:null,input.reference||null,input.reason||'Supplier return',userId,now,new Date().toISOString());
    const insert=db.prepare('INSERT INTO purchase_return_lines(id,return_id,purchase_line_id,quantity,base_quantity,amount_minor,tax_minor,cost_minor) VALUES(?,?,?,?,?,?,?,?)');
    let removedCost=0;
    const costMethod=setting('inventory.cost_method','weighted');
    for(const detail of details){
      const issue=issueStock({productId:detail.line.product_id,branchId:purchase.branchId||getDefaultBranchId(),sourceType:'purchase_return',sourceId:id+'-'+detail.line.id,quantity:detail.baseQuantity,costMethod,occurredAt:now});
      removedCost+=issue.costTotalMinor;
      insert.run(randomUUID(),id,detail.line.id,detail.quantity,detail.baseQuantity,detail.amountMinor,detail.taxMinor,issue.costTotalMinor);
    }
    if(refundMinor>0)db.prepare("INSERT INTO purchase_payments(id,purchase_id,method,amount_minor,reference,provider,occurred_at,direction) VALUES(?,?,?,?,?,?,?,'in')")
      .run(randomUUID(),purchaseId,refund.method,refundMinor,input.reference||null,refund.provider,now);
    const payableReduction=totalMinor-refundMinor;
    const journal=[];
    if(payableReduction>0)journal.push({accountId:'acc-ap',debitMinor:payableReduction});
    if(refundMinor>0)journal.push({accountId:paymentAccounts[refund.method],debitMinor:refundMinor});
    if(removedCost>0)journal.push({accountId:'acc-inventory',creditMinor:removedCost});
    if(purchase.taxTreatment==='recoverable'&&taxMinor>0)journal.push({accountId:'acc-tax-input',creditMinor:taxMinor});
    const debits=payableReduction+refundMinor,credits=removedCost+(purchase.taxTreatment==='recoverable'?taxMinor:0);
    if(debits>credits)journal.push({accountId:'acc-purchase-variance',creditMinor:debits-credits});
    if(credits>debits)journal.push({accountId:'acc-purchase-variance',debitMinor:credits-debits});
    postJournalEntry({sourceType:'purchase_return',sourceId:id,description:'Purchase return '+returnNumber,occurredAt:now,lines:journal});
    audit(userId,'purchase.return',id,{purchaseId,totalMinor,refundMinor,removedCost,lines:details.map(x=>({purchaseLineId:x.line.id,quantity:x.quantity}))});
    return {id,returnNumber,purchaseId,totalMinor,taxMinor,refundMinor,payableReductionMinor:payableReduction,removedCostMinor:removedCost,duplicate:false};
  });
}
