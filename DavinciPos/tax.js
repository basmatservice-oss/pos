import { db } from './database.js';

export function calculateLineTax({unitPriceMinor,quantity=1,discountMinor=0,rateBps,priceMode}) {
  const price=Number(unitPriceMinor), qty=Number(quantity), discount=Number(discountMinor||0), rate=Number(rateBps);
  if(!Number.isSafeInteger(price)||price<0||!Number.isFinite(qty)||qty<=0||!Number.isSafeInteger(discount)||discount<0||!Number.isSafeInteger(rate)||rate<0||rate>10000) throw new Error('Invalid tax calculation input.');
  if(!['inclusive','exclusive'].includes(priceMode)) throw new Error('Tax price mode must be inclusive or exclusive.');
  const gross=Math.round(price*qty)-discount;
  if(gross<0) throw new Error('Discount cannot exceed the line amount.');
  const tax=priceMode==='inclusive'?Math.round(gross*rate/(10000+rate)):Math.round(gross*rate/10000);
  return {netMinor:priceMode==='inclusive'?gross-tax:gross,taxMinor:tax,totalMinor:priceMode==='inclusive'?gross:gross+tax};
}
export function getTaxProfile(profileId=null) {
  const row=profileId
    ? db.prepare('SELECT * FROM tax_profiles WHERE id=? AND is_active=1').get(profileId)
    : db.prepare('SELECT * FROM tax_profiles WHERE is_default=1 AND is_active=1 ORDER BY name LIMIT 1').get();
  if(!row) return {rateBps:0,priceMode:'exclusive'};
  return {id:row.id,name:row.name,rateBps:row.rate_bps,priceMode:row.price_mode};
}
