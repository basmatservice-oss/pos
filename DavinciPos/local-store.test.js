import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOfflineSale,IndexedDbLocalStore} from './local-store.js';

test('validates offline sale envelopes before durable enqueue',()=>{
  const sale={id:'sale-1',lines:[{itemId:'product-1',quantity:2}]};
  assert.equal(validateOfflineSale(sale),sale);
  assert.throws(()=>validateOfflineSale(null),/must be an object/);
  assert.throws(()=>validateOfflineSale({lines:[]}),/at least one line/);
  assert.throws(()=>validateOfflineSale({lines:[{itemId:'',quantity:1}]}),/invalid line/);
  assert.throws(()=>validateOfflineSale({lines:[{itemId:'product-1',quantity:0}]}),/invalid line/);
});

test('requires a persistent IndexedDB implementation rather than silently falling back to memory',()=>{
  assert.throws(()=>new IndexedDbLocalStore({indexedDB:null}),/IndexedDB is unavailable/);
});
