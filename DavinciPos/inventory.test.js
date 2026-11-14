import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-test-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {receiveStock,issueStock,getStockOnHand,getInventoryValue,adjustInventory,createInventoryCount,getInventoryCount,setInventoryCountLine,completeInventoryCount}=await import('./inventory.js');
const {calculateLineTax,saveTaxProfile}=await import('./tax.js');
const {updateSettings}=await import('./settings.js');
const {receivePurchase,quotePurchase}=await import('./purchases.js');
const {checkoutSale,quoteSale}=await import('./sales.js');
const {reverseJournalEntry,getTrialBalance}=await import('./accounting.js');
const {getSimpleReport,getDetailedReport,availableReports}=await import('./reports.js');
const {acceptOfflineSale,resolveSyncConflict}=await import('./offline.js');
const {createUser}=await import('./security.js');
const {saveService,setServiceComponents,createUnit,saveProductUnit}=await import('./catalog.js');
initializeDatabase();

function product(id){
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,created_at,updated_at) VALUES(?,?,?,0,300,?,?)")
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
test('recoverable purchase tax is posted to input tax and excluded from stock cost',()=>{
  product('recoverable-tax-product');
  saveTaxProfile({name:'VAT 10',rateBps:1000,priceMode:'exclusive',isDefault:true});
  updateSettings({'tax.enabled':true,'tax.purchase_mode':'recoverable'});
  const purchaseInput={id:'recoverable-tax-purchase',lines:[{productId:'recoverable-tax-product',quantity:1,baseQuantity:1,unitCostMinor:1000}]};
  assert.equal(quotePurchase(purchaseInput).totalMinor,1100);
  const purchase=receivePurchase(purchaseInput);
  assert.equal(purchase.taxMinor,100);
  assert.equal(purchase.totalMinor,1100);
  assert.equal(getInventoryValue('recoverable-tax-product','branch-main'),1000);
  const taxSnapshot=db.prepare("SELECT tax_rate_bps,tax_profile_id,tax_price_mode FROM purchase_lines WHERE purchase_id='recoverable-tax-purchase'").get();
  assert.equal(taxSnapshot.tax_rate_bps,1000);
  assert.equal(taxSnapshot.tax_profile_id,db.prepare('SELECT id FROM tax_profiles WHERE name=?').get('VAT 10').id);
  assert.equal(taxSnapshot.tax_price_mode,'exclusive');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.source_id='recoverable-tax-purchase' AND jl.account_id='acc-tax-input' AND jl.debit_minor=100").get().count,1);
});
test('non-recoverable purchase tax is capitalized into inventory cost',()=>{
  product('nonrecoverable-tax-product');
  updateSettings({'tax.purchase_mode':'non_recoverable'});
  const purchase=receivePurchase({id:'nonrecoverable-tax-purchase',lines:[{productId:'nonrecoverable-tax-product',quantity:1,baseQuantity:1,unitCostMinor:1000}]});
  assert.equal(purchase.taxMinor,100);
  assert.equal(purchase.totalMinor,1100);
  assert.equal(getInventoryValue('nonrecoverable-tax-product','branch-main'),1100);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.source_id='nonrecoverable-tax-purchase' AND jl.account_id='acc-tax-input'").get().count,0);
});
test('sales use the central default tax profile and persist the applied tax snapshot',()=>{
  product('taxed-sale-product');
  db.prepare('UPDATE products SET sale_price_minor=1000 WHERE id=?').run('taxed-sale-product');
  receiveStock({productId:'taxed-sale-product',branchId:'branch-main',sourceType:'test-receipt',sourceId:'taxed-sale-stock',quantity:2,unitCostMinor:100});
  updateSettings({'tax.enabled':true});
  const saleInput={id:'taxed-sale-profile',lines:[{lineType:'product',itemId:'taxed-sale-product',description:'Taxed item',quantity:1,baseQuantity:1,unitPriceMinor:1000,trackStock:true}],payments:[{method:'cash',amountMinor:1100}]};
  assert.equal(quoteSale(saleInput).totalMinor,1100);
  const sale=checkoutSale(saleInput);
  assert.equal(sale.taxMinor,100);
  const snapshot=db.prepare("SELECT tax_rate_bps,tax_profile_id,tax_price_mode FROM sale_lines WHERE sale_id='taxed-sale-profile'").get();
  assert.equal(snapshot.tax_rate_bps,1000);
  assert.equal(snapshot.tax_price_mode,'exclusive');
  assert.ok(snapshot.tax_profile_id);
});
test('tax-exempt products remain exempt while global tax stays enabled',()=>{
  product('tax-exempt-product');
  db.prepare('UPDATE products SET sale_price_minor=1000,tax_exempt=1 WHERE id=?').run('tax-exempt-product');
  receiveStock({productId:'tax-exempt-product',branchId:'branch-main',sourceType:'test-receipt',sourceId:'tax-exempt-stock',quantity:2,unitCostMinor:100});
  const sale=quoteSale({lines:[{itemId:'tax-exempt-product',quantity:1}]});
  assert.equal(sale.taxMinor,0);
  assert.equal(sale.totalMinor,1000);
  const purchase=quotePurchase({lines:[{productId:'tax-exempt-product',quantity:1,unitCostMinor:1000}]});
  assert.equal(purchase.taxMinor,0);
  assert.equal(purchase.totalMinor,1000);
});
test('server ignores client price, discount and stock-tracking overrides',()=>{
  product('authoritative-sale-product');
  db.prepare('UPDATE products SET sale_price_minor=500,tax_exempt=1 WHERE id=?').run('authoritative-sale-product');
  receiveStock({productId:'authoritative-sale-product',branchId:'branch-main',sourceType:'test-receipt',sourceId:'authoritative-sale-stock',quantity:1,unitCostMinor:100});
  const malicious={id:'authoritative-sale',lines:[{itemId:'authoritative-sale-product',quantity:1,unitPriceMinor:1,discountMinor:500,baseQuantity:0,trackStock:false,taxRateBps:0}],payments:[{method:'cash',amountMinor:500}]};
  assert.equal(quoteSale(malicious).totalMinor,500);
  checkoutSale(malicious);
  assert.equal(getStockOnHand('authoritative-sale-product','branch-main'),0);
});
test('disabling tax removes purchase tax without changing server accounting balance',()=>{
  product('disabled-tax-product');
  updateSettings({'tax.enabled':false});
  const purchase=receivePurchase({id:'disabled-tax-purchase',lines:[{productId:'disabled-tax-product',quantity:1,baseQuantity:1,unitCostMinor:1000}]});
  assert.equal(purchase.taxMinor,0);
  assert.equal(purchase.totalMinor,1000);
});
test('inventory adjustments update stock and generate balanced journal entries',()=>{
  product('adjustment-product');
  const added=adjustInventory({id:'adjustment-add',productId:'adjustment-product',branchId:'branch-main',quantityDelta:5,unitCostMinor:100,reason:'Opening count'});
  assert.equal(added.duplicate,false);
  assert.equal(getStockOnHand('adjustment-product','branch-main'),5);
  const removed=adjustInventory({id:'adjustment-remove',productId:'adjustment-product',branchId:'branch-main',quantityDelta:-2,reason:'Damaged goods'});
  assert.equal(removed.costTotalMinor,200);
  assert.equal(getStockOnHand('adjustment-product','branch-main'),3);
  assert.equal(adjustInventory({id:'adjustment-remove',productId:'adjustment-product',branchId:'branch-main',quantityDelta:-2}).duplicate,true);
  const rows=getTrialBalance();
  assert.equal(rows.reduce((sum,row)=>sum+row.debitMinor,0),rows.reduce((sum,row)=>sum+row.creditMinor,0));
});
test('offline sale with insufficient authoritative stock is held as a conflict',async()=>{
  product('offline-conflict-product');
  const owner=await createUser({username:'offline-owner',password:'offline-owner-password-123',displayName:'Owner',role:'owner'});
  db.prepare('INSERT INTO devices(id,name,platform,branch_id,owner_user_id,is_active,created_at) VALUES(?,?,?,?,?,1,?)').run('test-device-001','Test device','desktop','branch-main',owner.id,new Date().toISOString());
  const payload={id:'offline-sale-conflict',lines:[{lineType:'product',itemId:'offline-conflict-product',description:'Offline item',quantity:1,baseQuantity:1,unitPriceMinor:500,trackStock:true,taxRateBps:0}],payments:[{method:'cash',amountMinor:300}]};
  const first=acceptOfflineSale({operationId:'offline-operation-001',deviceId:'test-device-001',payload,userId:owner.id});
  assert.equal(first.status,'conflict');
  const second=acceptOfflineSale({operationId:'offline-operation-001',deviceId:'test-device-001',payload,userId:owner.id});
  assert.equal(second.conflictId,first.conflictId);
  const resolved=resolveSyncConflict(first.conflictId,{decision:'reject',userId:owner.id});
  assert.equal(resolved.status,'rejected');
});
test('purchase receiving converts alternate package units into base stock units',()=>{
  product('purchase-unit-product');
  const carton=createUnit({name:'Test carton',symbol:'ctn',precision:0});
  const productUnitId=saveProductUnit('purchase-unit-product',{unitId:carton,baseQuantity:12});
  const quote=quotePurchase({branchId:'branch-main',lines:[{productId:'purchase-unit-product',productUnitId,quantity:1,unitCostMinor:1200}]});
  assert.equal(quote.totalMinor,1200);
  receivePurchase({branchId:'branch-main',lines:[{productId:'purchase-unit-product',productUnitId,quantity:1,unitCostMinor:1200}],payments:[{method:'cash',amountMinor:1200}]});
  assert.equal(getStockOnHand('purchase-unit-product','branch-main'),12);
});
test('service sale consumes configured material components and records their cost',()=>{
  product('gift-box-material');
  receiveStock({productId:'gift-box-material',branchId:'branch-main',sourceType:'test',sourceId:'gift-box-stock',quantity:10,unitCostMinor:250});
  const serviceId=saveService({name:'Gift wrapping',priceMinor:2000});
  setServiceComponents(serviceId,[{productId:'gift-box-material',quantity:2}]);
  const result=checkoutSale({branchId:'branch-main',lines:[{lineType:'service',itemId:serviceId,quantity:1}],payments:[{method:'cash',amountMinor:2000}]});
  assert.equal(getStockOnHand('gift-box-material','branch-main'),8);
  const line=db.prepare('SELECT cost_total_minor FROM sale_lines WHERE sale_id=?').get(result.id);
  assert.equal(line.cost_total_minor,500);
});
test('inventory count reconciles actual quantities through stock adjustments',()=>{
  stock('counted-product');
  const count=createInventoryCount({branchId:null,productIds:['counted-product']});
  const line=getInventoryCount(count.id).lines.find(item=>item.productId==='counted-product');
  assert.ok(line);
  assert.equal(line.expectedQuantity,20);
  setInventoryCountLine(count.id,'counted-product',18);
  const result=completeInventoryCount(count.id);
  assert.equal(result.adjustments.length,1);
  assert.equal(getStockOnHand('counted-product'),18);
  assert.equal(completeInventoryCount(count.id).duplicate,true);
});
test('simple store report validates date ranges and returns summary fields only',()=>{
  const report=getSimpleReport({from:'2099-01-01',to:'2099-01-31'});
  assert.equal(report.salesCount,0);
  assert.equal(report.purchasesCount,0);
  assert.equal(report.grossProfitMinor,0);
  assert.deepEqual(report.topProducts,[]);
  assert.throws(()=>getSimpleReport({from:'not-a-date'}),/Invalid report date/);
  assert.throws(()=>getSimpleReport({from:'2026-12-02',to:'2026-12-01'}),/Start date must be before end date/);
});

test('detailed report catalog covers core store operations',()=>{
  assert.ok(availableReports.includes('sales-invoices'));
  assert.ok(availableReports.includes('sales-products'));
  assert.ok(availableReports.includes('purchase-invoices'));
  assert.ok(availableReports.includes('stock-on-hand'));
  assert.ok(availableReports.includes('cash-movements'));
  assert.equal(getDetailedReport({type:'sales-invoices',from:'2099-01-01',to:'2099-01-31'}).rows.length,0);
  assert.equal(getDetailedReport({type:'cash-movements',from:'2099-01-01',to:'2099-01-31'}).rows.length,0);
  assert.ok(Array.isArray(getDetailedReport({type:'stock-on-hand',branchId:'branch-main'}).rows));
  assert.throws(()=>getDetailedReport({type:'unknown'}),/Unknown report type/);
});
test('closes isolated SQLite test database',()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
