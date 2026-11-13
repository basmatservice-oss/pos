import { randomUUID } from 'node:crypto';
import { db, inTransaction, getDefaultBranchId } from './database.js';
import { postJournalEntry } from './accounting.js';
import { issueStock } from './inventory.js';
import { calculateLineTax, getTaxProfile } from './tax.js';
import { setting } from './settings.js';

const paymentAccount = { cash:'acc-cash', card:'acc-card', bank:'acc-bank', wallet:'acc-wallet', other:'acc-other-clearing' };
function validateMoney(value,label) {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0) throw new Error(`Invalid ${label}.`);
  return n;
}
export function checkoutSale(input) {
  if(!input||!Array.isArray(input.lines)||input.lines.length===0) throw new Error('Sale must contain at least one line.');
  const saleId=input.id||randomUUID(), now=input.occurredAt||new Date().toISOString();
  const branchId=input.branchId||getDefaultBranchId();
  const currencyCode=setting('currency.code','SDG');
  const priceMode=setting('tax.price_mode','exclusive');
  const taxEnabled=setting('tax.enabled',true);
  const costMethod=setting('inventory.cost_method','weighted');
  if(input.currencyCode&&input.currencyCode!==currencyCode) throw new Error('Sale currency does not match the configured base currency.');
  const profileCache=new Map();
  const lines=input.lines.map(line=>{
    const quantity=Number(line.quantity), unitPriceMinor=validateMoney(line.unitPriceMinor,'unit price');
    const discountMinor=validateMoney(line.discountMinor||0,'line discount');
    if(!Number.isFinite(quantity)||quantity<=0) throw new Error('Line quantity must be greater than zero.');
    let profile;
    if(line.taxProfileId) {
      if(!profileCache.has(line.taxProfileId)) profileCache.set(line.taxProfileId,getTaxProfile(line.taxProfileId));
      profile=profileCache.get(line.taxProfileId);
    } else profile=line.taxRateBps===undefined?getTaxProfile():{rateBps:Number(line.taxRateBps||0),priceMode};
    const tax=calculateLineTax({unitPriceMinor,quantity,discountMinor,rateBps:profile.rateBps,priceMode:profile.priceMode||priceMode,enabled:taxEnabled});
    const baseQuantity=Number(line.baseQuantity??quantity);
    if(!Number.isFinite(baseQuantity)||baseQuantity<0||(line.lineType!=='service'&&line.trackStock!==false&&baseQuantity===0)) throw new Error('Invalid base unit quantity.');
    return {...line,quantity,baseQuantity,unitPriceMinor,discountMinor,taxRateBps:profile.rateBps,taxProfileId:profile.id||line.taxProfileId||null,taxPriceMode:profile.priceMode||priceMode,taxMinor:tax.taxMinor,netMinor:tax.netMinor,totalMinor:tax.totalMinor};
  });
  const subtotal=lines.reduce((sum,line)=>sum+line.netMinor,0);
  const taxTotal=lines.reduce((sum,line)=>sum+line.taxMinor,0);
  const total=lines.reduce((sum,line)=>sum+line.totalMinor,0);
  if(![subtotal,taxTotal,total].every(Number.isSafeInteger)) throw new Error('Sale total exceeds safe monetary limits.');
  const payments=input.payments||[];
  const paid=payments.reduce((sum,p)=>sum+Number(p.amountMinor),0);
  if(!Number.isSafeInteger(paid)||paid<0||paid>total) throw new Error('Payment amount exceeds sale total or is invalid.');
  for(const p of payments) if(!paymentAccount[p.method]||!Number.isSafeInteger(Number(p.amountMinor))||Number(p.amountMinor)<=0) throw new Error('Invalid payment method or amount.');

  return inTransaction(()=>{
    const existing=db.prepare('SELECT id FROM sales WHERE id=?').get(saleId);
    if(existing) return {id:saleId,duplicate:true};
    const receipt=input.receiptNumber||`S-${Date.now()}-${saleId.slice(0,6).toUpperCase()}`;
    db.prepare(`INSERT INTO sales(id,receipt_number,branch_id,device_id,customer_id,cashier_id,status,subtotal_minor,discount_minor,tax_minor,total_minor,currency_code,occurred_at,created_at,tax_enabled,tax_price_mode)
      VALUES(?,?,?,?,?,?,'posted',?,?,?,?,?,?,?,?,?)`).run(saleId,receipt,branchId,input.deviceId||null,input.customerId||null,input.cashierId||null,subtotal,lines.reduce((sum,l)=>sum+l.discountMinor,0),taxTotal,total,currencyCode,now,new Date().toISOString(),taxEnabled?1:0,priceMode);
    const insertLine=db.prepare(`INSERT INTO sale_lines(id,sale_id,line_type,item_id,description,quantity,unit_name,base_quantity,unit_price_minor,unit_cost_minor,cost_total_minor,discount_minor,tax_minor,line_total_minor,tax_rate_bps,tax_profile_id,tax_price_mode)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const journalLines=[], paidByMethod=new Map();
    let costTotal=0;
    for(const line of lines) {
      let lineCost=0;
      if(line.lineType!=='service'&&line.trackStock!==false) {
        const issue=issueStock({productId:line.itemId,branchId:branchId,sourceType:'sale',sourceId:saleId,quantity:line.baseQuantity,costMethod,occurredAt:now});
        lineCost=issue.costTotalMinor;
      }
      costTotal+=lineCost;
      const unitCostMinor=line.baseQuantity>0?Math.round(lineCost/line.baseQuantity):0;
      insertLine.run(randomUUID(),saleId,line.lineType||'product',line.itemId,line.description,line.quantity,line.unitName||'pc',line.baseQuantity,line.unitPriceMinor,unitCostMinor,lineCost,line.discountMinor,line.taxMinor,line.totalMinor,line.taxRateBps,line.taxProfileId,line.taxPriceMode);
    }
    for(const p of payments) {
      db.prepare("INSERT INTO payments(id,sale_id,direction,method,amount_minor,reference,occurred_at) VALUES(?,?,'in',?,?,?,?)")
        .run(randomUUID(),saleId,p.method,Number(p.amountMinor),p.reference||null,now);
      paidByMethod.set(p.method,(paidByMethod.get(p.method)||0)+Number(p.amountMinor));
    }
    for(const [method,amount] of paidByMethod) journalLines.push({accountId:paymentAccount[method],debitMinor:amount});
    const credit=total-paid;
    if(credit>0) {
      if(!input.customerId) throw new Error('A customer is required for an unpaid or credit sale.');
      journalLines.push({accountId:'acc-ar',debitMinor:credit});
    }
    const revenue=subtotal;
    if(revenue>0) journalLines.push({accountId:'acc-sales',creditMinor:revenue});
    if(taxTotal>0) journalLines.push({accountId:'acc-tax',creditMinor:taxTotal});
    if(costTotal>0) {
      journalLines.push({accountId:'acc-cogs',debitMinor:costTotal});
      journalLines.push({accountId:'acc-inventory',creditMinor:costTotal});
    }
    if(journalLines.length) postJournalEntry({sourceType:'sale',sourceId:saleId,description:`Sale ${receipt}`,occurredAt:now,lines:journalLines});
    return {id:saleId,receiptNumber:receipt,subtotalMinor:subtotal,taxMinor:taxTotal,totalMinor:total,costMinor:costTotal,duplicate:false};
  });
}
