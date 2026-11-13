import { randomUUID } from 'node:crypto';
import { db, inTransaction, getDefaultBranchId } from './database.js';
import { receiveStock } from './inventory.js';
import { postJournalEntry } from './accounting.js';
import { calculateLineTax, getTaxProfile } from './tax.js';
import { setting } from './settings.js';

const paymentAccount={cash:'acc-cash',card:'acc-card',bank:'acc-bank',wallet:'acc-wallet',other:'acc-other-clearing'};
export function receivePurchase(input) {
  if(!input||!Array.isArray(input.lines)||input.lines.length===0) throw new Error('Purchase must contain at least one line.');
  const id=input.id||randomUUID(),now=input.occurredAt||new Date().toISOString(),branchId=input.branchId||getDefaultBranchId();
  const currency=setting('currency.code','SDG');
  if(input.currencyCode&&input.currencyCode!==currency) throw new Error('Purchase currency does not match configured base currency.');
  const taxEnabled=setting('tax.enabled',true),taxTreatment=taxEnabled?setting('tax.purchase_mode','recoverable'):'disabled';
  const defaultMode=setting('tax.price_mode','exclusive'),cache=new Map();
  const lines=input.lines.map(line=>{
    const quantity=Number(line.quantity),baseQuantity=Number(line.baseQuantity??quantity),unitCostMinor=Number(line.unitCostMinor),discountMinor=Number(line.discountMinor||0);
    if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(baseQuantity)||baseQuantity<=0||!Number.isSafeInteger(unitCostMinor)||unitCostMinor<0||!Number.isSafeInteger(discountMinor)||discountMinor<0) throw new Error('Invalid purchase line.');
    let profile=line.taxRateBps===undefined?getTaxProfile():{rateBps:Number(line.taxRateBps||0),priceMode:defaultMode};
    if(line.taxProfileId){if(!cache.has(line.taxProfileId))cache.set(line.taxProfileId,getTaxProfile(line.taxProfileId));profile=cache.get(line.taxProfileId);}
    const tax=calculateLineTax({unitPriceMinor:unitCostMinor,quantity:baseQuantity,discountMinor,rateBps:taxTreatment==='disabled'?0:profile.rateBps,priceMode:profile.priceMode,enabled:taxEnabled&&taxTreatment!=='disabled'});
    const inventoryCost=taxTreatment==='non_recoverable'?tax.totalMinor:tax.netMinor;
    return {...line,quantity,baseQuantity,unitCostMinor,discountMinor,taxRateBps:profile.rateBps,taxProfileId:profile.id||line.taxProfileId||null,taxPriceMode:profile.priceMode||defaultMode,netMinor:tax.netMinor,taxMinor:tax.taxMinor,totalMinor:tax.totalMinor,
      inventoryUnitCostMinor:Math.round(inventoryCost/baseQuantity)};
  });
  const subtotal=lines.reduce((sum,line)=>sum+line.netMinor,0),taxTotal=lines.reduce((sum,line)=>sum+line.taxMinor,0);
  const total=lines.reduce((sum,line)=>sum+line.totalMinor,0);
  if(!Number.isSafeInteger(total)||total<=0) throw new Error('Purchase total must be greater than zero.');
  const payments=input.payments||[],paid=payments.reduce((sum,p)=>sum+Number(p.amountMinor),0);
  if(!Number.isSafeInteger(paid)||paid<0||paid>total) throw new Error('Invalid purchase payment total.');
  for(const p of payments) if(!paymentAccount[p.method]||!Number.isSafeInteger(Number(p.amountMinor))||Number(p.amountMinor)<=0) throw new Error('Invalid purchase payment.');
  return inTransaction(()=>{
    if(db.prepare('SELECT id FROM purchases WHERE id=?').get(id)) return {id,duplicate:true};
    const invoice=input.invoiceNumber||`P-${Date.now()}-${id.slice(0,6).toUpperCase()}`;
    db.prepare(`INSERT INTO purchases(id,invoice_number,supplier_id,branch_id,status,subtotal_minor,discount_minor,total_minor,currency_code,occurred_at,created_at,tax_minor,tax_treatment,tax_price_mode)
      VALUES(?,?,?,?,'posted',?,?,?,?,?,?,?,?,?)`).run(id,invoice,input.supplierId||null,branchId,subtotal,0,total,currency,now,new Date().toISOString(),taxTotal,taxTreatment,defaultMode);
    let inventoryValueMinor=0;
    const insert=db.prepare('INSERT INTO purchase_lines(id,purchase_id,product_id,quantity,unit_name,base_quantity,unit_cost_minor,discount_minor,line_total_minor,tax_minor,tax_rate_bps,tax_profile_id,tax_price_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const line of lines){
      insert.run(randomUUID(),id,line.productId,line.quantity,line.unitName||'pc',line.baseQuantity,line.inventoryUnitCostMinor,line.discountMinor,line.netMinor,line.taxMinor,line.taxRateBps,line.taxProfileId,line.taxPriceMode);
      const received=receiveStock({productId:line.productId,branchId,sourceType:'purchase',sourceId:id,quantity:line.baseQuantity,unitCostMinor:line.inventoryUnitCostMinor,occurredAt:now});
      inventoryValueMinor+=received.costTotalMinor;
    }
    for(const p of payments) db.prepare('INSERT INTO purchase_payments(id,purchase_id,method,amount_minor,reference,occurred_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,p.method,Number(p.amountMinor),p.reference||null,now);
    const journal=[];
    if(inventoryValueMinor>0) journal.push({accountId:'acc-inventory',debitMinor:inventoryValueMinor});
    const bookedValue=taxTreatment==='recoverable'?subtotal:total;
    if(inventoryValueMinor>bookedValue)journal.push({accountId:'acc-purchase-variance',creditMinor:inventoryValueMinor-bookedValue});
    if(inventoryValueMinor<bookedValue)journal.push({accountId:'acc-purchase-variance',debitMinor:bookedValue-inventoryValueMinor});
    const payable=total-paid;
    if(payable>0) journal.push({accountId:'acc-ap',creditMinor:payable});
    const paidByMethod=new Map();
    for(const p of payments) paidByMethod.set(p.method,(paidByMethod.get(p.method)||0)+Number(p.amountMinor));
    for(const [method,amount] of paidByMethod) journal.push({accountId:paymentAccount[method],creditMinor:amount});
    if(taxTotal>0&&taxTreatment==='recoverable') journal.push({accountId:'acc-tax-input',debitMinor:taxTotal});
    postJournalEntry({sourceType:'purchase',sourceId:id,description:`Purchase ${invoice}`,occurredAt:now,lines:journal});
    return {id,invoiceNumber:invoice,subtotalMinor:subtotal,taxMinor:taxTotal,totalMinor:total,taxTreatment,paidMinor:paid,duplicate:false};
  });
}
