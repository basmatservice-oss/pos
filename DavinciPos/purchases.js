import { randomUUID } from 'node:crypto';
import { db, inTransaction, getDefaultBranchId } from './database.js';
import { receiveStock } from './inventory.js';
import { postJournalEntry } from './accounting.js';

const paymentAccount={cash:'acc-cash',card:'acc-card',bank:'acc-bank',wallet:'acc-wallet',other:'acc-other-clearing'};
function setting(key,fallback){return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value??fallback;}
export function receivePurchase(input){
  if(!input||!Array.isArray(input.lines)||input.lines.length===0) throw new Error('Purchase must contain at least one line.');
  const id=input.id||randomUUID(), now=input.occurredAt||new Date().toISOString();
  const branchId=input.branchId||getDefaultBranchId();
  const currency=setting('currency.code','SDG');
  if(input.currencyCode&&input.currencyCode!==currency) throw new Error('Purchase currency does not match configured base currency.');
  const lines=input.lines.map(line=>{
    const quantity=Number(line.quantity),baseQuantity=Number(line.baseQuantity??quantity),unitCostMinor=Number(line.unitCostMinor),discountMinor=Number(line.discountMinor||0);
    if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(baseQuantity)||baseQuantity<=0||!Number.isSafeInteger(unitCostMinor)||unitCostMinor<0||!Number.isSafeInteger(discountMinor)||discountMinor<0) throw new Error('Invalid purchase line.');
    const gross=Math.round(baseQuantity*unitCostMinor);
    if(discountMinor>gross) throw new Error('Purchase line discount exceeds line value.');
    return {...line,quantity,baseQuantity,unitCostMinor,discountMinor,lineTotalMinor:gross-discountMinor,landedUnitCostMinor:Math.round((gross-discountMinor)/baseQuantity)};
  });
  const subtotal=lines.reduce((sum,line)=>sum+line.lineTotalMinor,0);
  const payments=input.payments||[];
  const paid=payments.reduce((sum,p)=>sum+Number(p.amountMinor),0);
  if(!Number.isSafeInteger(paid)||paid<0||paid>subtotal) throw new Error('Invalid purchase payment total.');
  for(const p of payments) if(!paymentAccount[p.method]||!Number.isSafeInteger(Number(p.amountMinor))||Number(p.amountMinor)<=0) throw new Error('Invalid purchase payment.');
  return inTransaction(()=>{
    if(db.prepare('SELECT id FROM purchases WHERE id=?').get(id)) return {id,duplicate:true};
    const invoice=input.invoiceNumber||`P-${Date.now()}-${id.slice(0,6).toUpperCase()}`;
    db.prepare(`INSERT INTO purchases(id,invoice_number,supplier_id,branch_id,status,subtotal_minor,discount_minor,total_minor,currency_code,occurred_at,created_at)
      VALUES(?,?,?,?,'posted',?,?,?,?,?,?)`).run(id,invoice,input.supplierId||null,branchId,subtotal,0,subtotal,currency,now,new Date().toISOString());
    let inventoryValueMinor=0;
    const insert=db.prepare('INSERT INTO purchase_lines(id,purchase_id,product_id,quantity,unit_name,base_quantity,unit_cost_minor,discount_minor,line_total_minor) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const line of lines){
      insert.run(randomUUID(),id,line.productId,line.quantity,line.unitName||'pc',line.baseQuantity,line.landedUnitCostMinor,line.discountMinor,line.lineTotalMinor);
      const received=receiveStock({productId:line.productId,branchId:branchId,sourceType:'purchase',sourceId:id,quantity:line.baseQuantity,unitCostMinor:line.landedUnitCostMinor,occurredAt:now});
      inventoryValueMinor+=received.costTotalMinor;
    }
    for(const p of payments) db.prepare('INSERT INTO purchase_payments(id,purchase_id,method,amount_minor,reference,occurred_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,p.method,Number(p.amountMinor),p.reference||null,now);
    const journal=[];
    if(inventoryValueMinor>0) journal.push({accountId:'acc-inventory',debitMinor:inventoryValueMinor});
    if(subtotal>inventoryValueMinor) journal.push({accountId:'acc-purchase-variance',debitMinor:subtotal-inventoryValueMinor});
    if(inventoryValueMinor>subtotal) journal.push({accountId:'acc-purchase-variance',creditMinor:inventoryValueMinor-subtotal});
    const payable=subtotal-paid;
    if(payable>0) journal.push({accountId:'acc-ap',creditMinor:payable});
    const paidByMethod=new Map();
    for(const p of payments) paidByMethod.set(p.method,(paidByMethod.get(p.method)||0)+Number(p.amountMinor));
    for(const [method,amount] of paidByMethod) journal.push({accountId:paymentAccount[method],creditMinor:amount});
    postJournalEntry({sourceType:'purchase',sourceId:id,description:`Purchase ${invoice}`,occurredAt:now,lines:journal});
    return {id,invoiceNumber:invoice,totalMinor:subtotal,paidMinor:paid,duplicate:false};
  });
}
