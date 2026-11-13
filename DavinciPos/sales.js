import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';
import { postJournalEntry } from './accounting.js';
import { recordStockMovement, getStockOnHand } from './inventory.js';

const paymentAccount = { cash:'acc-cash', card:'acc-card', bank:'acc-bank', wallet:'acc-wallet', other:'acc-cash' };

export function checkoutSale(input) {
  if (!input || !Array.isArray(input.lines) || input.lines.length === 0) throw new Error('Sale must contain at least one line.');
  const saleId = input.id || randomUUID();
  const now = input.occurredAt || new Date().toISOString();
  const lines = input.lines.map(line => {
    const quantity = Number(line.quantity), price = Number(line.unitPriceMinor), cost = Number(line.unitCostMinor || 0);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(cost) || cost < 0) throw new Error('Invalid sale line quantity or amount.');
    const baseQuantity = Number(line.baseQuantity ?? quantity);
    if (!Number.isFinite(baseQuantity) || baseQuantity < 0) throw new Error('Invalid base unit quantity.');
    return { ...line, quantity, unitPriceMinor: price, unitCostMinor: cost, baseQuantity };
  });
  const subtotal = lines.reduce((s,l)=>s+Math.round(l.quantity*l.unitPriceMinor),0);
  const discount = Number(input.discountMinor || 0), tax = Number(input.taxMinor || 0), total = subtotal-discount+tax;
  if (![discount,tax,total].every(Number.isSafeInteger) || discount<0 || tax<0 || total<0) throw new Error('Invalid sale totals.');
  const payments = input.payments || [];
  const paid = payments.reduce((s,p)=>s+Number(p.amountMinor),0);
  if (!Number.isSafeInteger(paid) || paid<0 || paid>total) throw new Error('Invalid payment total.');
  for (const p of payments) if (!paymentAccount[p.method] || !Number.isSafeInteger(Number(p.amountMinor)) || Number(p.amountMinor)<=0) throw new Error('Invalid payment method or amount.');

  return inTransaction(() => {
    const existing = db.prepare('SELECT id FROM sales WHERE id=?').get(saleId);
    if (existing) return { id:saleId, duplicate:true };
    const receipt = input.receiptNumber || `S-${Date.now()}-${saleId.slice(0,6).toUpperCase()}`;
    db.prepare(`INSERT INTO sales (id,receipt_number,branch_id,device_id,customer_id,cashier_id,status,subtotal_minor,discount_minor,tax_minor,total_minor,currency_code,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,'posted',?,?,?,?,?,?,?)`).run(saleId,receipt,input.branchId||null,input.deviceId||null,input.customerId||null,input.cashierId||null,subtotal,discount,tax,total,input.currencyCode||'SDG',now,new Date().toISOString());
    const insertLine=db.prepare(`INSERT INTO sale_lines (id,sale_id,line_type,item_id,description,quantity,unit_name,base_quantity,unit_price_minor,unit_cost_minor,discount_minor,tax_minor,line_total_minor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const line of lines){
      insertLine.run(randomUUID(),saleId,line.lineType||'product',line.itemId,line.description,line.quantity,line.unitName||'pc',line.baseQuantity,line.unitPriceMinor,line.unitCostMinor,Number(line.discountMinor||0),Number(line.taxMinor||0),Number(line.lineTotalMinor??Math.round(line.quantity*line.unitPriceMinor)));
      if(line.lineType!=='service' && line.trackStock!==false){
        const available=getStockOnHand(line.itemId,input.branchId||null);
        if(available<line.baseQuantity) throw new Error(`Insufficient stock for ${line.description}. Available: ${available}`);
        recordStockMovement({productId:line.itemId,branchId:input.branchId||null,sourceType:'sale',sourceId:saleId,quantityDelta:-line.baseQuantity,unitCostMinor:line.unitCostMinor,occurredAt:now});
      }
    }
    for(const p of payments) db.prepare("INSERT INTO payments (id,sale_id,direction,method,amount_minor,reference,occurred_at) VALUES (?,?,'in',?,?,?,?)").run(randomUUID(),saleId,p.method,Number(p.amountMinor),p.reference||null,now);
    const credit=total-paid;
    const costTotal=lines.filter(l=>l.lineType!=='service').reduce((s,l)=>s+Math.round(l.baseQuantity*l.unitCostMinor),0);
    const journalLines=[];
    const paidByMethod=new Map();
    for(const p of payments) paidByMethod.set(p.method,(paidByMethod.get(p.method)||0)+Number(p.amountMinor));
    for(const [method,amount] of paidByMethod) journalLines.push({accountId:paymentAccount[method],debitMinor:amount});
    if(credit>0) journalLines.push({accountId:'acc-ar',debitMinor:credit});
    if(total>0) journalLines.push({accountId:'acc-sales',creditMinor:total});
    if(costTotal>0){journalLines.push({accountId:'acc-cogs',debitMinor:costTotal});journalLines.push({accountId:'acc-inventory',creditMinor:costTotal});}
    if(journalLines.length) postJournalEntry({sourceType:'sale',sourceId:saleId,description:`Sale ${receipt}`,occurredAt:now,lines:journalLines});
    return {id:saleId,receiptNumber:receipt,totalMinor:total,duplicate:false};
  });
}
