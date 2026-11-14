import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-returns-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {createCustomer,createSupplier}=await import('./catalog.js');
const {receiveStock,getStockOnHand,getInventoryValue}=await import('./inventory.js');
const {checkoutSale}=await import('./sales.js');
const {receivePurchase}=await import('./purchases.js');
const {createSalesReturn,createPurchaseReturn,getSalesReturnOptions,getPurchaseReturnOptions}=await import('./returns.js');
const {listCustomerBalances,listSupplierBalances,getCustomerStatement,getSupplierStatement}=await import('./settlements.js');
const {getTrialBalance}=await import('./accounting.js');
const {updateSettings}=await import('./settings.js');
initializeDatabase();
updateSettings({'tax.enabled':false});

function product(id){
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,created_at,updated_at) VALUES(?,?,?,100,300,?,?)")
    .run(id,id,'unit-piece',new Date().toISOString(),new Date().toISOString());
}
function assertBalanced(){
  const rows=getTrialBalance();
  assert.equal(rows.reduce((sum,row)=>sum+row.debitMinor,0),rows.reduce((sum,row)=>sum+row.creditMinor,0));
}

test('sales return restores stock, refunds collected money and reduces the customer balance',()=>{
  const customerId=createCustomer({name:'Return customer'});
  product('sales-return-product');
  receiveStock({productId:'sales-return-product',branchId:'branch-main',sourceType:'test',sourceId:'sales-return-stock',quantity:10,unitCostMinor:100});
  const sale=checkoutSale({id:'sale-return-test',branchId:'branch-main',customerId,allowCredit:true,lines:[{itemId:'sales-return-product',quantity:4}],payments:[{method:'cash',amountMinor:600}]});
  assert.equal(getStockOnHand('sales-return-product','branch-main'),6);
  assert.equal(listCustomerBalances()[0].balanceMinor,600);
  const options=getSalesReturnOptions(sale.id);
  assert.equal(options.lines[0].remainingQuantity,4);
  const result=createSalesReturn(sale.id,{id:'sales-return-001',lines:[{saleLineId:options.lines[0].id,quantity:3}],refundMethod:'cash'});
  assert.equal(result.totalMinor,900);
  assert.equal(result.refundMinor,600);
  assert.equal(result.receivableReductionMinor,300);
  assert.equal(getStockOnHand('sales-return-product','branch-main'),9);
  assert.equal(listCustomerBalances()[0].balanceMinor,300);
  assert.equal(getCustomerStatement(customerId).invoices[0].returnedMinor,900);
  assert.equal(createSalesReturn(sale.id,{id:'sales-return-001',lines:[{saleLineId:options.lines[0].id,quantity:3}]}).duplicate,true);
  assert.throws(()=>createSalesReturn(sale.id,{lines:[{saleLineId:options.lines[0].id,quantity:2}]}),/exceeds the unreturned quantity/);
  assertBalanced();
});

test('sales returns cannot exceed sold quantity and service lines are not treated as stock returns',()=>{
  const customerId=createCustomer({name:'Quantity customer'});
  product('sales-return-limit-product');
  receiveStock({productId:'sales-return-limit-product',branchId:'branch-main',sourceType:'test',sourceId:'sales-return-limit-stock',quantity:2,unitCostMinor:100});
  const sale=checkoutSale({id:'sale-return-limit',branchId:'branch-main',customerId,allowCredit:true,lines:[{itemId:'sales-return-limit-product',quantity:2}],payments:[{method:'cash',amountMinor:600}]});
  const line=getSalesReturnOptions(sale.id).lines[0];
  createSalesReturn(sale.id,{lines:[{saleLineId:line.id,quantity:1}]});
  assert.throws(()=>createSalesReturn(sale.id,{lines:[{saleLineId:line.id,quantity:2}]}),/exceeds the unreturned quantity/);
  assert.equal(getStockOnHand('sales-return-limit-product','branch-main'),1);
});

test('purchase return removes stock, records supplier refund and reduces supplier balance',()=>{
  const supplierId=createSupplier({name:'Return supplier'});
  product('purchase-return-product');
  const purchase=receivePurchase({id:'purchase-return-test',branchId:'branch-main',supplierId,lines:[{productId:'purchase-return-product',quantity:10,unitCostMinor:100}],payments:[{method:'cash',amountMinor:400}]});
  assert.equal(getStockOnHand('purchase-return-product','branch-main'),10);
  assert.equal(listSupplierBalances()[0].balanceMinor,600);
  const options=getPurchaseReturnOptions(purchase.id);
  assert.equal(options.lines[0].remainingQuantity,10);
  const result=createPurchaseReturn(purchase.id,{id:'purchase-return-001',lines:[{purchaseLineId:options.lines[0].id,quantity:5}],refundMethod:'bank'});
  assert.equal(result.totalMinor,500);
  assert.equal(result.refundMinor,400);
  assert.equal(result.payableReductionMinor,100);
  assert.equal(getStockOnHand('purchase-return-product','branch-main'),5);
  assert.equal(listSupplierBalances()[0].balanceMinor,500);
  assert.equal(getSupplierStatement(supplierId).invoices[0].returnedMinor,500);
  assertBalanced();
});

test('purchase return rejects quantities beyond available stock and remaining invoice quantity',()=>{
  const supplierId=createSupplier({name:'Stock return supplier'});
  product('purchase-return-limit-product');
  const purchase=receivePurchase({id:'purchase-return-limit',branchId:'branch-main',supplierId,lines:[{productId:'purchase-return-limit-product',quantity:2,unitCostMinor:100}],payments:[{method:'cash',amountMinor:200}]});
  const line=getPurchaseReturnOptions(purchase.id).lines[0];
  assert.throws(()=>createPurchaseReturn(purchase.id,{lines:[{purchaseLineId:line.id,quantity:3}]}),/exceeds the unreturned quantity/);
  // A sale has consumed one unit, so the supplier return cannot remove two units from stock.
  checkoutSale({id:'consume-before-supplier-return',branchId:'branch-main',lines:[{itemId:'purchase-return-limit-product',quantity:1}],payments:[{method:'cash',amountMinor:300}]});
  assert.throws(()=>createPurchaseReturn(purchase.id,{lines:[{purchaseLineId:line.id,quantity:2}]}),/Insufficient stock/);
});

test('closes isolated return database',()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
