import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {validateOfflineSale,IndexedDbLocalStore} from './local-store.js';

const DATABASE_NAME='davincipos-local';
const deviceA='device-terminal-A';
const deviceB='device-terminal-B';

async function resetDatabase(){
  const request=indexedDB.deleteDatabase(DATABASE_NAME);
  await new Promise((resolve,reject)=>{
    request.onsuccess=resolve;
    request.onerror=()=>reject(request.error||new Error('Unable to reset IndexedDB test database.'));
    request.onblocked=()=>reject(new Error('IndexedDB test database deletion was blocked.'));
  });
}
function sale(id='sale-1'){
  return {id,occurredAt:'2026-11-15T10:00:00.000Z',lines:[{itemId:'product-1',quantity:2}],payments:[]};
}

test('validates offline sale envelopes before durable enqueue',()=>{
  const payload=sale();
  assert.equal(validateOfflineSale(payload),payload);
  assert.throws(()=>validateOfflineSale(null),/must be an object/);
  assert.throws(()=>validateOfflineSale({lines:[]}),/at least one line/);
  assert.throws(()=>validateOfflineSale({lines:[{itemId:'',quantity:1}]}),/invalid line/);
  assert.throws(()=>validateOfflineSale({lines:[{itemId:'product-1',quantity:0}]}),/invalid line/);
});

test('requires a persistent IndexedDB implementation rather than silently falling back to memory',()=>{
  assert.throws(()=>new IndexedDbLocalStore({indexedDB:null}),/IndexedDB is unavailable/);
});

test('persists device metadata and queued sales after closing and reopening the store',async()=>{
  await resetDatabase();
  const first=new IndexedDbLocalStore({indexedDB});
  await first.setMetadata('device-id',deviceA);
  await first.setMetadata('pos-snapshot',{products:[{id:'product-1'}],customers:[],services:[]});
  await first.enqueueSale({deviceId:deviceA,operationId:'operation-persist-1',sale:sale()});
  await first.close();

  const reopened=new IndexedDbLocalStore({indexedDB});
  assert.equal(await reopened.getMetadata('device-id'),deviceA);
  assert.deepEqual(await reopened.getMetadata('pos-snapshot'),{products:[{id:'product-1'}],customers:[],services:[]});
  const pending=await reopened.listPending({deviceId:deviceA});
  assert.equal(pending.length,1);
  assert.equal(pending[0].operationId,'operation-persist-1');
  assert.deepEqual(pending[0].payload,sale());
  await reopened.close();
  await resetDatabase();
});

test('persists retry, acknowledgement, rejection and conflict states with attempts',async()=>{
  await resetDatabase();
  const store=new IndexedDbLocalStore({indexedDB});
  for(const id of ['retry','accepted','rejected','conflict'])
    await store.enqueueSale({deviceId:deviceA,operationId:id,sale:sale(id)});
  await store.recordFailure('retry','LAN unavailable');
  await store.acknowledge('accepted',{status:'accepted',receiptNumber:'S-100'});
  await store.rejectOperation('rejected',{status:'rejected',reason:'Invalid sale'});
  await store.holdConflict('conflict',{status:'conflict',reason:'Insufficient stock'});

  const all=await store.listOperations({deviceId:deviceA});
  const byId=Object.fromEntries(all.map(item=>[item.operationId,item]));
  assert.equal(byId.retry.status,'failed');
  assert.equal(byId.retry.attempts,1);
  assert.equal(byId.retry.lastError,'LAN unavailable');
  assert.equal(byId.accepted.status,'acknowledged');
  assert.equal(byId.accepted.response.receiptNumber,'S-100');
  assert.equal(byId.rejected.status,'rejected');
  assert.equal(byId.conflict.status,'conflict');
  assert.deepEqual((await store.listPending({deviceId:deviceA})).map(item=>item.operationId),['retry']);
  await store.close();
  await resetDatabase();
});

test('isolates device queue reads and rejects duplicate operation IDs without overwriting the first sale',async()=>{
  await resetDatabase();
  const store=new IndexedDbLocalStore({indexedDB});
  await store.enqueueSale({deviceId:deviceA,operationId:'same-operation',sale:sale('original-sale')});
  await store.enqueueSale({deviceId:deviceB,operationId:'device-b-operation',sale:sale('other-sale')});
  await assert.rejects(
    store.enqueueSale({deviceId:deviceA,operationId:'same-operation',sale:sale('tampered-sale')})
  );
  assert.equal((await store.listPending({deviceId:deviceA})).length,1);
  assert.equal((await store.listPending({deviceId:deviceB})).length,1);
  const [record]=await store.listOperations({deviceId:deviceA});
  assert.equal(record.payload.id,'original-sale');
  await assert.rejects(store.acknowledge('missing-operation',{status:'accepted'}),/not found/);
  await store.close();
  await resetDatabase();
});
