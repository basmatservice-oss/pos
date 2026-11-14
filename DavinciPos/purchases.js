import { randomUUID } from 'node:crypto';
import { db, inTransaction, getDefaultBranchId } from './database.js';
import { receiveStock } from './inventory.js';
import { postJournalEntry } from './accounting.js';
import { calculateLineTax, getTaxProfile } from './tax.js';
import { setting } from './settings.js';

const paymentAccount={cash:'acc-cash',card:'acc-card',bank:'acc-bank',wallet:'acc-wallet',other:'acc-other-clearing'};
const walletProviders=new Set(['bankak','ocash','fawry','mycashy']);
function preparePurchase(input) {
  if(!input||!Array.isArray(input.lines)||input.lines.length===0)throw new Error('Purchase must contain at least one line.');
  const id=input.id||randomUUID(),now=input.occurredAt||new Date().toISOString(),branchId=input.branchId||getDefaultBranchId();
  const currency=setting('currency.code','SDG');
  if(input.currencyCode&&input.currencyCode!==currency)throw new Error('Purchase currency does not match configured base currency.');
  const taxEnabled=setting('tax.enabled',true),taxTreatment=taxEnabled?setting('tax.purchase_mode','recoverable'):'disabled';
  const defaultMode=setting('tax.price_mode','exclusive'),cache=new Map();
  const lines=input.lines.map(line=>{
    const quantity=Number(line.quantity),unitCostMinor=Number(line.unitCostMinor),discountMinor=Number(line.discountMinor||0);
    if(!Number.isFinite(quantity)||quantity<=0||!Number.isSafeInteger(unitCostMinor)||unitCostMinor<0||!Number.isSafeInteger(discountMinor)||discountMinor<0)throw new Error('Invalid purchase line.');
    const product=db.prepare('SELECT p.name,p.tax_rate_bps,p.tax_exempt,p.track_stock,u.symbol AS unit_symbol FROM products p LEFT JOIN units u ON u.id=p.base_unit_id WHERE p.id=? AND p.is_active=1').get(line.productId);
    if(!product||!product.track_stock)throw new Error('Purchase line must reference an existing active stock-tracked product.');
    const baseQuantity=quantity;
    const profile=product.tax_exempt?{rateBps:0,priceMode:defaultMode}:product.tax_rate_bps>0?{rateBps:product.tax_rate_bps,priceMode:defaultMode}:getTaxProfile();
    const tax=calculateLineTax({unitPriceMinor:unitCostMinor,quantity:baseQuantity,discountMinor,rateBps:taxTreatment==='disabled'?0:profile.rateBps,priceMode:profile.priceMode,enabled:taxEnabled&&taxTreatment!=='disabled'});
    const inventoryCost=taxTreatment==='non_recoverable'?tax.totalMinor:tax.netMinor;
    return {...line,productName:product.name,quantity,baseQuantity,unitName:product.unit_symbol||'pc',unitCostMinor,discountMinor,taxRateBps:profile.rateBps,taxProfileId:profile.id||null,
      taxPriceMode:profile.priceMode||defaultMode,netMinor:tax.netMinor,taxMinor:tax.taxMinor,totalMinor:tax.totalMinor,inventoryUnitCostMinor:Math.round(inventoryCost/baseQuantity)};
  });
  const subtotal=lines.reduce((sum,line)=>sum+line.netMinor,0),taxTotal=lines.reduce((sum,line)=>sum+line.taxMinor,0),total=lines.reduce((sum,line)=>sum+line.totalMinor,0);
  if(!Number.isSafeInteger(total)||total<=0)throw new Error('Purchase total must be greater than zero.');
  const payments=input.payments||[],paid=payments.reduce((sum,payment)=>sum+Number(payment.amountMinor),0);
  if(!Number.isSafeInteger(paid)||paid<0||paid>total)throw new Error('Invalid purchase payment total.');
  for(const payment of payments){if(!paymentAccount[payment.method]||!Number.isSafeInteger(Number(payment.amountMinor))||Number(payment.amountMinor)<=0)throw new Error('Invalid purchase payment.');if(payment.provider&&!walletProviders.has(payment.provider))throw new Error('Unsupported payment provider.');if(payment.method==='wallet'&&!walletProviders.has(payment.provider))throw new Error('Select a supported wallet provider.');}
  return {id,now,branchId,currency,taxTreatment,defaultMode,lines,subtotal,taxTotal,total,payments,paid,input};
}
export function quotePurchase(input) {
  const purchase=preparePurchase(input);
  return {subtotalMinor:purchase.subtotal,taxMinor:purchase.taxTotal,totalMinor:purchase.total,currencyCode:purchase.currency,
    taxTreatment:purchase.taxTreatment,lines:purchase.lines.map(line=>({productId:line.productId,quantity:line.quantity,netMinor:line.netMinor,taxMinor:line.taxMinor,totalMinor:line.totalMinor,taxRateBps:line.taxRateBps,taxPriceMode:line.taxPriceMode}))};
}
export function receivePurchase(input) {
  const purchase=preparePurchase(input);
  const {id,now,branchId,currency,taxTreatment,defaultMode,lines,subtotal,taxTotal,total,payments,paid}=purchase;
  return inTransaction(()=>{
    if(db.prepare('SELECT id FROM purchases WHERE id=?').get(id))return {id,duplicate:true};
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
    for(const payment of payments)db.prepare('INSERT INTO purchase_payments(id,purchase_id,method,amount_minor,reference,provider,occurred_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,payment.method,Number(payment.amountMinor),payment.reference||null,payment.provider||null,now);
    const journal=[];
    if(inventoryValueMinor>0)journal.push({accountId:'acc-inventory',debitMinor:inventoryValueMinor});
    const bookedValue=taxTreatment==='recoverable'?subtotal:total;
    if(inventoryValueMinor>bookedValue)journal.push({accountId:'acc-purchase-variance',creditMinor:inventoryValueMinor-bookedValue});
    if(inventoryValueMinor<bookedValue)journal.push({accountId:'acc-purchase-variance',debitMinor:bookedValue-inventoryValueMinor});
    const payable=total-paid;if(payable>0)journal.push({accountId:'acc-ap',creditMinor:payable});
    const paidByMethod=new Map();for(const payment of payments)paidByMethod.set(payment.method,(paidByMethod.get(payment.method)||0)+Number(payment.amountMinor));
    for(const [method,amount] of paidByMethod)journal.push({accountId:paymentAccount[method],creditMinor:amount});
    if(taxTotal>0&&taxTreatment==='recoverable')journal.push({accountId:'acc-tax-input',debitMinor:taxTotal});
    postJournalEntry({sourceType:'purchase',sourceId:id,description:`Purchase ${invoice}`,occurredAt:now,lines:journal});
    return {id,invoiceNumber:invoice,subtotalMinor:subtotal,taxMinor:taxTotal,totalMinor:total,taxTreatment,paidMinor:paid,duplicate:false};
  });
}
