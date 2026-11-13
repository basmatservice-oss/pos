import { randomUUID } from 'node:crypto';
import { db, inTransaction } from './database.js';
import { checkoutSale } from './sales.js';
import { setting } from './settings.js';

export function acceptOfflineSale({operationId,deviceId,payload,userId}) {
  if(!operationId||typeof operationId!=='string'||operationId.length>128||!deviceId||!payload||typeof payload!=='object') throw new Error('Offline sale envelope is invalid.');
  if(!setting('sync.offline_sales',true)) throw new Error('Offline sales synchronization is disabled by the server.');
  const device=db.prepare('SELECT id FROM devices WHERE id=? AND owner_user_id=? AND is_active=1').get(deviceId,userId);
  if(!device) throw new Error('Device is not registered to this user. Register this device before syncing.');
  const prior=db.prepare('SELECT response FROM sync_receipts WHERE operation_id=?').get(operationId);
  if(prior)return JSON.parse(prior.response);
  try {
    const result=checkoutSale({...payload,deviceId,cashierId:userId});
    const response={status:'accepted',sale:result};
    db.prepare('INSERT INTO sync_receipts(operation_id,device_id,response,created_at) VALUES(?,?,?,?)').run(operationId,deviceId,JSON.stringify(response),new Date().toISOString());
    return response;
  } catch(error) {
    if(!/Insufficient stock/.test(error.message)) throw error;
    const policy=setting('sync.stock_conflict_policy','hold_for_review');
    if(policy==='reject_sale') {
      const response={status:'rejected',reason:'Insufficient stock on the authoritative server.'};
      db.prepare('INSERT INTO sync_receipts(operation_id,device_id,response,created_at) VALUES(?,?,?,?)').run(operationId,deviceId,JSON.stringify(response),new Date().toISOString());
      return response;
    }
    const existing=db.prepare('SELECT id FROM sync_conflicts WHERE operation_id=?').get(operationId);
    const conflictId=existing?.id||randomUUID();
    if(!existing)db.prepare(`INSERT INTO sync_conflicts(id,operation_id,device_id,entity_type,entity_id,payload,reason,status,created_at)
      VALUES(?,?,?,'sale',?,?,?,'pending',?)`).run(conflictId,operationId,deviceId,payload.id||operationId,JSON.stringify({...payload,cashierId:userId}),error.message,new Date().toISOString());
    return {status:'conflict',conflictId,reason:'Insufficient stock on the authoritative server. Sale is held for review.'};
  }
}
export function listSyncConflicts() {
  return db.prepare("SELECT id,operation_id AS operationId,device_id AS deviceId,entity_id AS entityId,reason,status,created_at AS createdAt FROM sync_conflicts WHERE status='pending' ORDER BY created_at").all();
}
export function resolveSyncConflict(conflictId,{decision,userId}) {
  return inTransaction(()=>{
    const conflict=db.prepare("SELECT * FROM sync_conflicts WHERE id=? AND status='pending'").get(conflictId);
    if(!conflict)throw new Error('Pending sync conflict not found.');
    let response;
    if(decision==='reject')response={status:'rejected',reason:'Rejected during conflict review.'};
    else if(decision==='retry') {
      const payload=JSON.parse(conflict.payload);
      try{response={status:'accepted',sale:checkoutSale(payload)};}
      catch(error){if(/Insufficient stock/.test(error.message))throw new Error('Stock is still insufficient. Resolve stock levels before retrying.');throw error;}
    } else throw new Error('Decision must be retry or reject.');
    db.prepare("UPDATE sync_conflicts SET status='resolved',resolved_at=?,resolved_by=? WHERE id=?")
      .run(new Date().toISOString(),userId,conflictId);
    db.prepare('INSERT OR REPLACE INTO sync_receipts(operation_id,device_id,response,created_at) VALUES(?,?,?,?)')
      .run(conflict.operation_id,conflict.device_id,JSON.stringify(response),new Date().toISOString());
    return response;
  });
}
