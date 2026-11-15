const DATABASE_NAME='davincipos-local';
const DATABASE_VERSION=1;
const OPERATIONS='operations';
const METADATA='metadata';

function requestResult(request){
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Local database request failed.'));
  });
}
function transactionDone(transaction){
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onabort=()=>reject(transaction.error||new Error('Local database transaction aborted.'));
    transaction.onerror=()=>reject(transaction.error||new Error('Local database transaction failed.'));
  });
}
export function validateOfflineSale(sale){
  if(!sale||typeof sale!=='object'||Array.isArray(sale))throw new Error('Offline sale must be an object.');
  if(!Array.isArray(sale.lines)||sale.lines.length===0)throw new Error('Offline sale requires at least one line.');
  for(const line of sale.lines){
    if(!line||typeof line.itemId!=='string'||!line.itemId||!Number.isFinite(Number(line.quantity))||Number(line.quantity)<=0)
      throw new Error('Offline sale contains an invalid line.');
  }
  return sale;
}
export class IndexedDbLocalStore{
  constructor({indexedDB=globalThis.indexedDB,crypto=globalThis.crypto}={}){
    if(!indexedDB)throw new Error('IndexedDB is unavailable on this device.');
    this.indexedDB=indexedDB;
    this.crypto=crypto;
    this.databasePromise=null;
  }
  open(){
    if(this.databasePromise)return this.databasePromise;
    this.databasePromise=new Promise((resolve,reject)=>{
      const request=this.indexedDB.open(DATABASE_NAME,DATABASE_VERSION);
      request.onupgradeneeded=()=>{
        const database=request.result;
        if(!database.objectStoreNames.contains(OPERATIONS)){
          const store=database.createObjectStore(OPERATIONS,{keyPath:'operationId'});
          store.createIndex('status_created','status_created',{unique:false});
          store.createIndex('device_created',['deviceId','createdAt'],{unique:false});
        }
        if(!database.objectStoreNames.contains(METADATA))database.createObjectStore(METADATA,{keyPath:'key'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('Unable to open local database.'));
      request.onblocked=()=>reject(new Error('Local database upgrade is blocked by another open DavinciPos tab.'));
    });
    return this.databasePromise;
  }
  async enqueueSale({deviceId,sale,operationId=this.crypto?.randomUUID?.()}){
    if(typeof deviceId!=='string'||deviceId.length<8||deviceId.length>100)throw new Error('A valid registered device ID is required.');
    validateOfflineSale(sale);
    if(typeof operationId!=='string'||!operationId||operationId.length>128)throw new Error('A valid offline operation ID is required.');
    const database=await this.open(),transaction=database.transaction(OPERATIONS,'readwrite'),done=transactionDone(transaction);
    const record={operationId,deviceId,entityType:'sale',entityId:String(sale.id||operationId),operation:'upsert',payload:structuredClone(sale),status:'pending',attempts:0,createdAt:new Date().toISOString(),lastError:null};
    transaction.objectStore(OPERATIONS).add(record);
    await done;
    return record;
  }
  async listPending({deviceId=null,limit=100}={}){
    const database=await this.open(),transaction=database.transaction(OPERATIONS,'readonly');
    const records=await requestResult(transaction.objectStore(OPERATIONS).getAll());
    await transactionDone(transaction);
    return records.filter(item=>['pending','failed'].includes(item.status)&&(!deviceId||item.deviceId===deviceId))
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,Math.max(1,Math.min(500,Number(limit)||100)));
  }
  async recordFailure(operationId,error){
    return this.updateOperation(operationId,record=>({...record,status:'failed',attempts:record.attempts+1,lastError:String(error).slice(0,1000)}));
  }
  async acknowledge(operationId,response){
    return this.updateOperation(operationId,record=>({...record,status:'acknowledged',acknowledgedAt:new Date().toISOString(),response,lastError:null}));
  }
  async holdConflict(operationId,conflict){
    return this.updateOperation(operationId,record=>({...record,status:'conflict',conflict,lastError:null}));
  }
  async updateOperation(operationId,update){
    const database=await this.open(),transaction=database.transaction(OPERATIONS,'readwrite'),store=transaction.objectStore(OPERATIONS);
    const record=await requestResult(store.get(operationId));
    if(!record){transaction.abort();throw new Error('Offline operation not found.');}
    const updated=update(record);store.put(updated);await transactionDone(transaction);return updated;
  }
  async setMetadata(key,value){
    const database=await this.open(),transaction=database.transaction(METADATA,'readwrite'),done=transactionDone(transaction);
    transaction.objectStore(METADATA).put({key,value:structuredClone(value),updatedAt:new Date().toISOString()});
    await done;
  }
  async getMetadata(key){
    const database=await this.open(),transaction=database.transaction(METADATA,'readonly');
    const record=await requestResult(transaction.objectStore(METADATA).get(key));await transactionDone(transaction);
    return record?.value??null;
  }
  async close(){
    if(!this.databasePromise)return;
    const database=await this.databasePromise;database.close();this.databasePromise=null;
  }
}
