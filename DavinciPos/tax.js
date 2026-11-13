import { randomUUID } from 'node:crypto';
import { db } from './database.js';
import { setting } from './settings.js';

export function calculateLineTax({unitPriceMinor,quantity=1,discountMinor=0,rateBps,priceMode,enabled=true}) {
  const price=Number(unitPriceMinor),qty=Number(quantity),discount=Number(discountMinor||0),rate=Number(rateBps);
  if(!Number.isSafeInteger(price)||price<0||!Number.isFinite(qty)||qty<=0||!Number.isSafeInteger(discount)||discount<0||!Number.isSafeInteger(rate)||rate<0||rate>10000) throw new Error('Invalid tax calculation input.');
  if(!enabled) return {netMinor:Math.round(price*qty)-discount,taxMinor:0,totalMinor:Math.round(price*qty)-discount};
  if(!['inclusive','exclusive'].includes(priceMode)) throw new Error('Tax price mode must be inclusive or exclusive.');
  const gross=Math.round(price*qty)-discount;
  if(gross<0) throw new Error('Discount cannot exceed the line amount.');
  const tax=priceMode==='inclusive'?Math.round(gross*rate/(10000+rate)):Math.round(gross*rate/10000);
  return {netMinor:priceMode==='inclusive'?gross-tax:gross,taxMinor:tax,totalMinor:priceMode==='inclusive'?gross:gross+tax};
}
export function getTaxProfile(profileId=null) {
  const selectedId=profileId||setting('tax.default_profile_id',null);
  const row=selectedId
    ?db.prepare('SELECT * FROM tax_profiles WHERE id=? AND is_active=1').get(selectedId)
    :db.prepare('SELECT * FROM tax_profiles WHERE is_default=1 AND is_active=1 ORDER BY name LIMIT 1').get();
  if(!row&&selectedId) throw new Error('Default tax profile not found or inactive.');
  if(!row) return {rateBps:0,priceMode:setting('tax.price_mode','exclusive')};
  return {id:row.id,name:row.name,rateBps:row.rate_bps,priceMode:row.price_mode};
}
export function listTaxProfiles() {
  return db.prepare('SELECT id,name,rate_bps AS rateBps,price_mode AS priceMode,is_default AS isDefault,is_active AS isActive FROM tax_profiles ORDER BY name').all();
}
export function saveTaxProfile({id=null,name,rateBps,priceMode,isDefault=false},actorUserId=null) {
  if(typeof name!=='string'||!name.trim()) throw new Error('Tax profile name is required.');
  if(!Number.isSafeInteger(Number(rateBps))||Number(rateBps)<0||Number(rateBps)>10000) throw new Error('Tax rate must be between 0 and 100 percent.');
  if(!['inclusive','exclusive'].includes(priceMode)) throw new Error('Tax price mode must be inclusive or exclusive.');
  const profileId=id||randomUUID();
  const save=db.transaction(()=>{
    const previous=db.prepare('SELECT name,rate_bps,price_mode,is_default,is_active FROM tax_profiles WHERE id=?').get(profileId)||null;
    if(isDefault) {
      db.prepare('UPDATE tax_profiles SET is_default=0').run();
      db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('tax.default_profile_id',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(profileId,new Date().toISOString());
    }
    db.prepare(`INSERT INTO tax_profiles(id,name,rate_bps,price_mode,is_default,is_active) VALUES(?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,rate_bps=excluded.rate_bps,price_mode=excluded.price_mode,is_default=excluded.is_default,is_active=1`)
      .run(profileId,name.trim(),Number(rateBps),priceMode,isDefault?1:0);
    db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at) VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?)')
      .run(actorUserId,'tax_profile.save','tax_profile',profileId,JSON.stringify({previous,next:{name:name.trim(),rateBps:Number(rateBps),priceMode,isDefault}}),new Date().toISOString());
    return profileId;
  });
  return save();
}
export function setDefaultTaxPriceMode(mode) {
  if(!['inclusive','exclusive'].includes(mode)) throw new Error('Tax price mode must be inclusive or exclusive.');
  db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('tax.price_mode',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(mode,new Date().toISOString());
  return mode;
}
