import { db, inTransaction } from './database.js';

const DEFINITIONS = {
  'tax.enabled': { type:'boolean', fallback:true },
  'tax.purchase_mode': { type:'enum', values:['recoverable','non_recoverable','disabled'], fallback:'recoverable' },
  'tax.price_mode': { type:'enum', values:['inclusive','exclusive'], fallback:'exclusive' },
  'tax.default_profile_id': { type:'nullableString', fallback:null },
  'inventory.cost_method': { type:'enum', values:['weighted','fifo'], fallback:'weighted', lockedAfterStock:true },
  'sync.offline_sales': { type:'boolean', fallback:true },
  'sync.stock_conflict_policy': { type:'enum', values:['hold_for_review','reject_sale'], fallback:'hold_for_review' },
  'currency.code': { type:'string', fallback:'SDG' },
  'company.name': { type:'string', fallback:'DavinciPos' }
};

function normalize(def,value,key) {
  if(def.type==='boolean') {
    if(typeof value!=='boolean') throw new Error(`Setting ${key} must be boolean.`);
    return value;
  }
  if(def.type==='enum') {
    if(!def.values.includes(value)) throw new Error(`Invalid value for setting ${key}.`);
    return value;
  }
  if(def.type==='nullableString') {
    if(value===null||value==='') return null;
    if(typeof value!=='string'||value.length>128) throw new Error(`Invalid value for setting ${key}.`);
    return value;
  }
  if(typeof value!=='string'||!value.trim()||value.length>120) throw new Error(`Invalid value for setting ${key}.`);
  return value.trim();
}
export function getSettings({includeDisabled=true}={}) {
  const rows=db.prepare('SELECT key,value,updated_at FROM app_settings').all();
  const values=new Map(rows.map(r=>[r.key,r.value]));
  const result={};
  for(const [key,def] of Object.entries(DEFINITIONS)) {
    const raw=values.has(key)?values.get(key):def.fallback;
    let value=raw;
    if(def.type==='boolean') value=raw==='true'||raw==='1';
    else if(def.type==='nullableString') value=raw||null;
    result[key]=value;
  }
  return result;
}
export function updateSettings(changes,{actorUserId=null}={}) {
  if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length) throw new Error('At least one setting is required.');
  const normalized=Object.entries(changes).map(([key,value])=>{
    const def=DEFINITIONS[key];
    if(!def) throw new Error(`Setting is not configurable: ${key}`);
    return [key,normalize(def,value),def];
  });
  return inTransaction(()=>{
    for(const [key,value,def] of normalized) {
      const previous=db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value??null;
      if(def.lockedAfterStock&&previous!==null&&previous!==value) {
        const count=db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count;
        if(count>0) throw new Error('Inventory costing is locked after stock activity. A controlled revaluation workflow is required.');
      }
      db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(key,value===null?'':String(value),new Date().toISOString());
      db.prepare(`INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,created_at)
        VALUES(lower(hex(randomblob(16))),?,'settings.update','setting',?,?,?)`)
        .run(actorUserId,key,JSON.stringify({previous,value}),new Date().toISOString());
    }
    return getSettings();
  });
}
export function setting(key,fallback) {
  const raw=db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
  if(raw===undefined) return fallback;
  if(DEFINITIONS[key]?.type==='boolean') return raw==='true'||raw==='1';
  return raw;
}
export const settingDefinitions=DEFINITIONS;
