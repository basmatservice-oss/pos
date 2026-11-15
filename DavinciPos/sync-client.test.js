import test from 'node:test';
import assert from 'node:assert/strict';
import {getLocalDeviceId,registerLocalDevice,cachePosSnapshot,loadPosSnapshot,queueOfflineSale,synchronizePendingSales} from './sync-client.js';

function memoryStore(){
  const metadata=new Map(),operations=[];
  return {
    metadata,operations,
    async getMetadata(key){return metadata.get(key)??null;},
    async setMetadata(key,value){metadata.set(key,value);},
    async enqueueSale(record){operations.push({...record,status:'pending',attempts:0});return operations.at(-1);},
    async listPending(){return operations.filter(item=>['pending','failed'].includes(item.status));},
    async acknowledge(id,response){const op=operations.find(x=>x.operationId===id);op.status='acknowledged';op.response=response;},
    async rejectOperation(id,response){const op=operations.find(x=>x.operationId===id);op.status='rejected';op.response=response;},
    async holdConflict(id,response){const op=operations.find(x=>x.operationId===id);op.status='conflict';op.response=response;},
    async recordFailure(id,error){const op=operations.find(x=>x.operationId===id);op.status='failed';op.attempts++;op.lastError=error;}
  };
}

test('device identity is persistent and registration uses one stable device ID',async()=>{
  const store=memoryStore();
  const id=await getLocalDeviceId(store,{randomUUID:()=> 'device-stable-id'});
  assert.equal(await getLocalDeviceId(store),id);
  let request;
  const registered=await registerLocalDevice(async(path,options)=>{request={path,options};return {};},{store,name:'POS terminal',platform:'web'});
  assert.equal(registered,id);
  assert.equal(request.path,'/api/devices/register');
  assert.equal(request.options.body.id,id);
  assert.equal(store.metadata.get('device-registration').deviceId,id);
});

test('cached POS snapshot is validated and survives local reload',async()=>{
  const store=memoryStore(),snapshot={products:[{id:'p1'}],customers:[],services:[]};
  await cachePosSnapshot(snapshot,store);
  assert.deepEqual(await loadPosSnapshot(store),snapshot);
  await assert.rejects(()=>cachePosSnapshot({products:[]},store),/must contain/);
});

test('offline sales are queued once and accepted receipts acknowledge them',async()=>{
  const store=memoryStore(),sale={id:'sale-1',lines:[{itemId:'p1',quantity:1}]};
  await queueOfflineSale({sale,deviceId:'device-1234',store,operationId:'operation-1'});
  const calls=[];
  const results=await synchronizePendingSales({store,api:async(path,{body})=>{calls.push({path,body});return {status:'accepted',sale:{id:'sale-1'}};}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/sync/offline-sales');
  assert.equal(calls[0].body.operationId,'operation-1');
  assert.equal(results[0].status,'accepted');
  assert.equal(store.operations[0].status,'acknowledged');
});

test('conflicts and rejected sales are held locally; transport failures remain retryable',async()=>{
  const store=memoryStore();
  for(const id of ['conflict','rejected','failed'])await queueOfflineSale({sale:{id,lines:[{itemId:'p1',quantity:1}]},deviceId:'device-1234',store,operationId:id});
  const statuses=['conflict','rejected'];
  let index=0;
  const results=await synchronizePendingSales({store,api:async()=>{if(index===0){index++;return {status:statuses[0]};}if(index===1){index++;return {status:statuses[1]};}throw new Error('LAN unavailable');}});
  assert.deepEqual(store.operations.map(x=>x.status),['conflict','rejected','failed']);
  assert.equal(results[2].status,'failed');
  assert.equal(store.operations[2].attempts,1);
});

test('permanent client errors reject an offline operation and continue with later sales',async()=>{
  const store=memoryStore();
  for(const id of ['invalid','valid'])await queueOfflineSale({sale:{id,lines:[{itemId:'p1',quantity:1}]},deviceId:'device-1234',store,operationId:id});
  let calls=0;
  const results=await synchronizePendingSales({store,api:async()=>{
    calls++;
    if(calls===1){const error=new Error('Sale validation failed');error.status=422;throw error;}
    return {status:'accepted'};
  }});
  assert.deepEqual(store.operations.map(x=>x.status),['rejected','acknowledged']);
  assert.deepEqual(results.map(x=>x.status),['rejected','accepted']);
});

test('rate limits remain retryable and stop the current synchronization batch',async()=>{
  const store=memoryStore();
  await queueOfflineSale({sale:{id:'rate-limited',lines:[{itemId:'p1',quantity:1}]},deviceId:'device-1234',store,operationId:'rate-limited'});
  const results=await synchronizePendingSales({store,api:async()=>{const error=new Error('Rate limited');error.status=429;throw error;}});
  assert.equal(results[0].status,'failed');
  assert.equal(store.operations[0].status,'failed');
  assert.equal(store.operations[0].attempts,1);
});
