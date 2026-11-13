import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-test-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {receiveStock,issueStock,getStockOnHand,getInventoryValue}=await import('./inventory.js');
const {calculateLineTax}=await import('./tax.js');
const {receivePurchase}=await import('./purchases.js');
const {checkoutSale}=await import('./sales.js');
const {reverseJournalEntry,getTrialBalance}=await import('./accounting.js');
initializeDatabase();

function product(id){
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,created_at,updated_at) VALUES(?,?,?,0,0,?,?)")
    .run(id,id,'unit-piece',new Date().toISOString(),new Date().toISOString());
}
function stock(id){
  product(id);
  receiveStock({productId:id,sourceType:'test-receipt',sourceId:id+'-1',quantity:10,unitCostMinor:100});
  receiveStock({productId:id,sourceType:'test-receipt',sourceId:id+'-2',quantity:10,unitCostMinor:200});
}

test('weighted average consumes at average cost and preserves inventory value',()=>{
  stock('weighted-product');
  const result=issueStock({productId:'weighted-product',sourceType:'test-sale',sourceId:'weighted-sale',quantity:5,costMethod:'weighted'});
  assert.equal(result.costTotalMinor,750);
  assert.equal(getStockOnHand('weighted-product'),15);
  assert.equal(getInventoryValue('weighted-product'),2250);
});
test('FIFO consumes the oldest cost layer first',()=>{
  stock('fifo-product');
  const result=issueStock({productId:'fifo-product',sourceType:'test-sale',sourceId:'fifo-sale',quantity:5,costMethod:'fifo'});
  assert.equal(result.costTotalMinor,500);
  assert.equal(getStockOnHand('fifo-product'),15);
  assert.equal(getInventoryValue('fifo-product'),2500);
});
test('stock cannot be issued below zero',()=>{
  stock('no-negative-product');
  assert.throws(()=>issueStock({productId:'no-negative-product',sourceType:'test-sale',sourceId:'too-much',quantity:21,costMethod:'fifo'}),/Insufficient stock/);
});
test('exclusive tax is added to the net line amount',()=>{
  assert.deepEqual(calculateLineTax({unitPriceMinor:10000,quantity:1,rateBps:1500,priceMode:'exclusive'}),{netMinor:10000,taxMinor:1500,totalMinor:11500});
});
test('inclusive tax is extracted from the displayed gross amount',()=>{
  assert.deepEqual(calculateLineTax({unitPriceMinor:11500,quantity:1,rateBps:1500,priceMode:'inclusive'}),{netMinor:10000,taxMinor:1500,totalMinor:11500});
});
test('purchase receipt and sale post stock and balanced accounting atomically',()=>{
  product('checkout-product');
  const purchase=receivePurchase({id:'purchase-test',lines:[{productId:'checkout-product',quantity:10,baseQuantity:10,unitCostMinor:100}]});
  assert.equal(purchase.totalMinor,1000);
  const sale=checkoutSale({id:'sale-test',lines:[{lineType:'product',itemId:'checkout-product',description:'Test item',quantity:2,baseQuantity:2,unitPriceMinor:300,trackStock:true,taxRateBps:0}],payments:[{method:'cash',amountMinor:600}]});
  assert.equal(sale.costMinor,200);
  assert.equal(getStockOnHand('checkout-product','branch-main'),8);
  const balance=getTrialBalance();
  const debit=balance.reduce((sum,row)=>sum+row.debitMinor,0);
  const credit=balance.reduce((sum,row)=>sum+row.creditMinor,0);
  assert.equal(debit,credit);
  const entry=db.prepare("SELECT id FROM journal_entries WHERE source_type='sale' AND source_id='sale-test'").get();
  const reversal=reverseJournalEntry(entry.id,'Test reversal');
  assert.ok(reversal);
  assert.equal(reverseJournalEntry(entry.id,'Repeat reversal'),reversal);
});
test('closes isolated SQLite test database',()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
