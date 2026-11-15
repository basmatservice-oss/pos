import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateCachedSaleQuote} from './offline-quote.js';

const snapshot={
  settings:{'tax.enabled':true,'tax.price_mode':'exclusive','tax.default_profile_id':'tax-default','currency.code':'SDG'},
  taxProfiles:[{id:'tax-default',rateBps:1500,priceMode:'exclusive',isDefault:true}],
  products:[{id:'p1',name:'Product',salePriceMinor:10000,taxRateBps:0,taxExempt:0,isActive:1}],
  services:[{id:'s1',name:'Service',priceMinor:5000,componentSaleMinor:2000,taxRateBps:0,isActive:1}]
};

test('cached offline quote calculates default exclusive tax and totals',()=>{
  const quote=calculateCachedSaleQuote({lines:[{itemId:'p1',quantity:2}],snapshot});
  assert.equal(quote.subtotalMinor,20000);
  assert.equal(quote.taxMinor,3000);
  assert.equal(quote.totalMinor,23000);
  assert.equal(quote.currencyCode,'SDG');
  assert.equal(quote.offlineEstimate,true);
});

test('cached offline quote honors inclusive pricing, exemptions and custom units',()=>{
  const data={...snapshot,settings:{...snapshot.settings,'tax.price_mode':'inclusive'},taxProfiles:[{id:'tax-default',rateBps:1500,priceMode:'inclusive',isDefault:true}],products:[{...snapshot.products[0],taxExempt:1}]};
  const exempt=calculateCachedSaleQuote({lines:[{itemId:'p1',quantity:1}],snapshot:data});
  assert.equal(exempt.taxMinor,0);
  data.products=[snapshot.products[0]];
  const custom=calculateCachedSaleQuote({lines:[{itemId:'p1',quantity:1,productUnitId:'case'}],snapshot:data,productUnits:{p1:[{id:'case',baseQuantity:12,salePriceMinor:100000}]}});
  assert.equal(custom.totalMinor,100000);
  assert.equal(custom.taxMinor,13043);
  assert.equal(custom.subtotalMinor,86957);
});

test('cached services include configured component sale values and invalid units fail closed',()=>{
  const service=calculateCachedSaleQuote({lines:[{lineType:'service',itemId:'s1',quantity:1}],snapshot});
  assert.equal(service.totalMinor,8050);
  assert.throws(()=>calculateCachedSaleQuote({lines:[{itemId:'p1',quantity:1,productUnitId:'missing'}],snapshot}),/not cached/);
  assert.throws(()=>calculateCachedSaleQuote({lines:[{itemId:'unknown',quantity:1}],snapshot}),/not present/);
});
