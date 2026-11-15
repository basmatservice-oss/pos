import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaleId} from './sale-id.js';

test('uses the platform UUID generator when available',()=>{
  assert.equal(createSaleId({cryptoImpl:{randomUUID:()=> 'stable-platform-id'}}),'stable-platform-id');
});

test('creates a valid unique-shaped ID without secure-context crypto for LAN HTTP',()=>{
  let seed=0;
  const random=()=>((seed++%255)+0.25)/256;
  const id=createSaleId({cryptoImpl:null,now:()=>123456,random});
  assert.match(id,/^sale-[a-z0-9]+-[0-9a-f]{32}$/);
  assert.equal(id.split('-').at(-1)[12],'4');
  assert.ok(['8','9','a','b'].includes(id.split('-').at(-1)[16]));
});

test('uses getRandomValues when randomUUID is unavailable',()=>{
  const cryptoImpl={getRandomValues(bytes){bytes.fill(7);return bytes;}};
  const id=createSaleId({cryptoImpl,now:()=>1});
  assert.match(id,/^sale-[a-z0-9]+-[0-9a-f]{32}$/);
});
