import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-settlements-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {createCustomer,createSupplier}=await import('./catalog.js');
const {receivePurchase}=await import('./purchases.js');
const {checkoutSale}=await import('./sales.js');
const {recordCustomerPayment,recordSupplierPayment,listCustomerBalances,listSupplierBalances,getCustomerStatement,getSupplierStatement}=await import('./settlements.js');
const {getTrialBalance}=await import('./accounting.js');
initializeDatabase();

test('customer collections reduce invoice balance and post balanced cash movement',()=>{
  const customerId=createCustomer({name:'Test Customer'});
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,track_stock,created_at,updated_at) VALUES('settlement-product','Test item','unit-piece',1000,10000,0,?,?)").run(new Date().toISOString(),new Date().toISOString());
  const sale=checkoutSale({customerId,allowCredit:true,lines:[{itemId:'settlement-product',quantity:1}],payments:[{method:'cash',amountMinor:2500}]});
  assert.equal(listCustomerBalances()[0].balanceMinor,7500);
  const collected=recordCustomerPayment(sale.id,{amountMinor:3000,method:'bank'});
  assert.equal(collected.remainingMinor,4500);
  assert.equal(getCustomerStatement(customerId).balanceMinor,4500);
  assert.throws(()=>recordCustomerPayment(sale.id,{amountMinor:5000}),/exceeds the remaining/);
  const totals=getTrialBalance().reduce((acc,row)=>({debit:acc.debit+row.debitMinor,credit:acc.credit+row.creditMinor}),{debit:0,credit:0});
  assert.equal(totals.debit,totals.credit);
});

test('supplier payments reduce payable balance and reject overpayment',()=>{
  const supplierId=createSupplier({name:'Test Supplier'});
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,track_stock,created_at,updated_at) VALUES('supplier-product','Stock item','unit-piece',1000,2000,1,?,?)").run(new Date().toISOString(),new Date().toISOString());
  const purchase=receivePurchase({supplierId,lines:[{productId:'supplier-product',quantity:2,unitCostMinor:5000}],payments:[{method:'cash',amountMinor:2000}]});
  assert.equal(listSupplierBalances()[0].balanceMinor,8000);
  const paid=recordSupplierPayment(purchase.id,{amountMinor:3000,method:'wallet',provider:'bankak'});
  assert.equal(paid.remainingMinor,5000);
  assert.equal(getSupplierStatement(supplierId).balanceMinor,5000);
  assert.throws(()=>recordSupplierPayment(purchase.id,{amountMinor:6000}),/exceeds the remaining/);
});

test('closes settlement database',()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
