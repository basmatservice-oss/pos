import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';
function validRate(value){const rate=Number(value);if(!Number.isFinite(rate)||rate<=0||rate>1000000)throw new Error('Exchange rate must be a positive number.');return rate;}
export function getCurrentExchangeRate(from='USD',to='SDG'){
 return db.prepare("SELECT id,from_currency AS fromCurrency,to_currency AS toCurrency,rate,effective_at AS effectiveAt FROM exchange_rates WHERE from_currency=? AND to_currency=? ORDER BY effective_at DESC,created_at DESC LIMIT 1").get(from,to)||null;
}
export function listExchangeRates({limit=50}={}){
 return db.prepare("SELECT er.id,er.from_currency AS fromCurrency,er.to_currency AS toCurrency,er.rate,er.effective_at AS effectiveAt,u.display_name AS createdBy FROM exchange_rates er LEFT JOIN users u ON u.id=er.created_by ORDER BY er.effective_at DESC,er.created_at DESC LIMIT ?").all(Math.max(1,Math.min(200,Number(limit)||50)));
}
export function recordExchangeRate({fromCurrency='USD',toCurrency='SDG',rate,effectiveAt=new Date().toISOString(),actorUserId=null,applyAutomatically=false}){
 if(!/^[A-Z]{3}$/.test(fromCurrency)||!/^[A-Z]{3}$/.test(toCurrency)||fromCurrency===toCurrency)throw new Error('Invalid currency pair.');
 rate=validRate(rate);const date=new Date(effectiveAt);if(Number.isNaN(date.getTime()))throw new Error('Invalid effective date.');
 const id=randomUUID(),now=new Date().toISOString();
 return inTransaction(()=>{
  db.prepare('INSERT INTO exchange_rates(id,from_currency,to_currency,rate,effective_at,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id,fromCurrency,toCurrency,rate,date.toISOString(),actorUserId,now);
  let updatedProducts=0;
  if(applyAutomatically){
   if(fromCurrency!=='USD'||toCurrency!=='SDG')throw new Error('Automatic price updates are currently supported only for USD to SDG.');
   const products=db.prepare("SELECT id,foreign_cost_minor,foreign_sale_price_minor FROM products WHERE price_currency='USD' AND auto_rate_update=1 AND foreign_sale_price_minor IS NOT NULL").all();
   const update=db.prepare('UPDATE products SET cost_minor=?,sale_price_minor=?,updated_at=? WHERE id=?');
   for(const p of products){update.run(p.foreign_cost_minor===null?0:Math.round(p.foreign_cost_minor*rate),Math.round(p.foreign_sale_price_minor*rate),now,p.id);updatedProducts++;}
  }
  db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),actorUserId,'currency.exchange_rate','exchange_rate',id,JSON.stringify({fromCurrency,toCurrency,rate,applyAutomatically,updatedProducts}),now);
  return {id,fromCurrency,toCurrency,rate,effectiveAt:date.toISOString(),updatedProducts};
 });
}
export function configureProductCurrency(productId,{currency='SDG',foreignCostMinor=null,foreignSalePriceMinor=null,autoUpdate=false}={}){
 if(!['SDG','USD'].includes(currency))throw new Error('Product currency must be SDG or USD.');
 if(!db.prepare('SELECT id FROM products WHERE id=?').get(productId))throw new Error('Product not found.');
 const rate=getCurrentExchangeRate('USD','SDG');
 if(currency==='USD'){
  const cost=foreignCostMinor===null?null:Number(foreignCostMinor),sale=foreignSalePriceMinor===null?null:Number(foreignSalePriceMinor);
  if(sale===null||!Number.isSafeInteger(sale)||sale<0||(cost!==null&&(!Number.isSafeInteger(cost)||cost<0)))throw new Error('Enter valid USD source prices.');
  if(autoUpdate&&!rate)throw new Error('Set the USD to SDG exchange rate before enabling automatic price updates.');
  const effective=rate?.rate||1;
  db.prepare("UPDATE products SET price_currency='USD',foreign_cost_minor=?,foreign_sale_price_minor=?,auto_rate_update=?,cost_minor=?,sale_price_minor=?,updated_at=? WHERE id=?")
   .run(cost,sale,autoUpdate?1:0,cost===null?0:Math.round(cost*effective),Math.round(sale*effective),new Date().toISOString(),productId);
 }else db.prepare("UPDATE products SET price_currency='SDG',foreign_cost_minor=NULL,foreign_sale_price_minor=NULL,auto_rate_update=0,updated_at=? WHERE id=?").run(new Date().toISOString(),productId);
 return db.prepare('SELECT id,price_currency AS priceCurrency,foreign_cost_minor AS foreignCostMinor,foreign_sale_price_minor AS foreignSalePriceMinor,auto_rate_update AS autoRateUpdate,cost_minor AS costMinor,sale_price_minor AS salePriceMinor FROM products WHERE id=?').get(productId);
}
