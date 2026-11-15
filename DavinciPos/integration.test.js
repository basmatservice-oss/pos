import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-full-cycle-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {createCustomer,createSupplier}=await import('./catalog.js');
const {receivePurchase}=await import('./purchases.js');
const {checkoutSale}=await import('./sales.js');
const {createSalesReturn,createPurchaseReturn,getSalesReturnOptions,getPurchaseReturnOptions}=await import('./returns.js');
const {recordCustomerPayment,recordSupplierPayment,listCustomerBalances,listSupplierBalances}=await import('./settlements.js');
const {getStockOnHand}=await import('./inventory.js');
const {getTrialBalance}=await import('./accounting.js');
const {getSimpleReport}=await import('./reports.js');
const {updateSettings}=await import('./settings.js');

initializeDatabase();
updateSettings({'tax.enabled':false});

function assertLedgerBalanced(){
  const rows=getTrialBalance();
  const debits=rows.reduce((sum,row)=>sum+row.debitMinor,0);
  const credits=rows.reduce((sum,row)=>sum+row.creditMinor,0);
  assert.equal(debits,credits);
}

test('integrated purchase, supplier installments, purchase returns, sale, customer installments and sales returns reconcile',()=>{
  const customerId=createCustomer({name:'Integrated cycle customer'});
  const supplierId=createSupplier({name:'Integrated cycle supplier'});
  const productId='integrated-cycle-product';
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,track_stock,created_at,updated_at) VALUES(?,?,?,1000,3000,1,?,?)")
    .run(productId,'Integrated cycle item','unit-piece',new Date().toISOString(),new Date().toISOString());

  const purchase=receivePurchase({
    id:'integrated-cycle-purchase',branchId:'branch-main',supplierId,occurredAt:'2026-11-01T10:00:00.000Z',
    lines:[{productId,quantity:10,unitCostMinor:1000}],
    payments:[{method:'cash',amountMinor:3000}]
  });
  assert.equal(purchase.totalMinor,10000);
  assert.equal(listSupplierBalances().find(x=>x.id===supplierId).balanceMinor,7000);

  const supplierInstallment=recordSupplierPayment(purchase.id,{amountMinor:2000,method:'bank'});
  assert.equal(supplierInstallment.remainingMinor,5000);

  const purchaseLine=getPurchaseReturnOptions(purchase.id).lines[0];
  const firstPurchaseReturn=createPurchaseReturn(purchase.id,{
    id:'integrated-purchase-return-1',
    lines:[{purchaseLineId:purchaseLine.id,quantity:2}],
    refundMethod:'cash'
  });
  assert.equal(firstPurchaseReturn.totalMinor,2000);
  assert.equal(firstPurchaseReturn.refundMinor,2000);
  assert.equal(getStockOnHand(productId,'branch-main'),8);
  assert.equal(listSupplierBalances().find(x=>x.id===supplierId).balanceMinor,5000);

  const sale=checkoutSale({
    id:'integrated-cycle-sale',branchId:'branch-main',customerId,allowCredit:true,occurredAt:'2026-11-01T10:00:00.000Z',
    lines:[{itemId:productId,quantity:4}],
    payments:[{method:'cash',amountMinor:4000}]
  });
  assert.equal(sale.totalMinor,12000);
  assert.equal(getStockOnHand(productId,'branch-main'),4);
  assert.equal(listCustomerBalances().find(x=>x.id===customerId).balanceMinor,8000);

  const customerInstallment=recordCustomerPayment(sale.id,{amountMinor:3000,method:'bank'});
  assert.equal(customerInstallment.remainingMinor,5000);

  const saleLine=getSalesReturnOptions(sale.id).lines[0];
  const firstSalesReturn=createSalesReturn(sale.id,{
    id:'integrated-sales-return-1',
    lines:[{saleLineId:saleLine.id,quantity:1}],
    refundMethod:'cash'
  });
  assert.equal(firstSalesReturn.totalMinor,3000);
  assert.equal(firstSalesReturn.refundMinor,3000);
  assert.equal(getStockOnHand(productId,'branch-main'),5);
  assert.equal(listCustomerBalances().find(x=>x.id===customerId).balanceMinor,5000);

  const secondSalesReturn=createSalesReturn(sale.id,{
    id:'integrated-sales-return-2',
    lines:[{saleLineId:saleLine.id,quantity:1}],
    refundMethod:'bank'
  });
  assert.equal(secondSalesReturn.totalMinor,3000);
  assert.equal(secondSalesReturn.refundMinor,3000);
  assert.equal(getStockOnHand(productId,'branch-main'),6);
  assert.equal(listCustomerBalances().find(x=>x.id===customerId).balanceMinor,5000);

  const secondPurchaseReturn=createPurchaseReturn(purchase.id,{
    id:'integrated-purchase-return-2',
    lines:[{purchaseLineId:purchaseLine.id,quantity:1}],
    refundMethod:'bank'
  });
  assert.equal(secondPurchaseReturn.totalMinor,1000);
  assert.equal(secondPurchaseReturn.refundMinor,1000);
  assert.equal(getStockOnHand(productId,'branch-main'),5);
  assert.equal(listSupplierBalances().find(x=>x.id===supplierId).balanceMinor,5000);

  assert.throws(()=>recordCustomerPayment(sale.id,{amountMinor:5001,method:'cash'}),/exceeds the remaining invoice balance/);
  assert.throws(()=>recordSupplierPayment(purchase.id,{amountMinor:5001,method:'cash'}),/exceeds the remaining supplier balance/);
  assert.throws(()=>createSalesReturn(sale.id,{lines:[{saleLineId:saleLine.id,quantity:3}]}),/exceeds the unreturned quantity/);
  assert.throws(()=>createPurchaseReturn(purchase.id,{lines:[{purchaseLineId:purchaseLine.id,quantity:8}]}),/exceeds the unreturned quantity/);

  const report=getSimpleReport({});
  assert.equal(report.salesTotalMinor,6000);
  assert.equal(report.purchasesTotalMinor,7000);
  assert.equal(report.grossProfitMinor,4000);
  assert.equal(report.expensesTotalMinor,0);
  assert.equal(report.netProfitMinor,4000);
  const invoicePeriod=getSimpleReport({from:'2026-11-01',to:'2026-11-01'});
  assert.equal(invoicePeriod.salesTotalMinor,12000);
  assert.equal(invoicePeriod.purchasesTotalMinor,10000);
  assert.equal(invoicePeriod.grossProfitMinor,8000);
  const returnPeriod=getSimpleReport({from:'2026-11-15',to:'2026-11-15'});
  assert.equal(returnPeriod.salesTotalMinor,-6000);
  assert.equal(returnPeriod.purchasesTotalMinor,-3000);
  assert.equal(returnPeriod.grossProfitMinor,-4000);

  const salesReturnReport=getDetailedReport({type:'sales-returns'});
  assert.equal(salesReturnReport.count,2);
  assert.equal(salesReturnReport.totalMinor,6000);
  const purchaseReturnReport=getDetailedReport({type:'purchase-returns'});
  assert.equal(purchaseReturnReport.count,2);
  assert.equal(purchaseReturnReport.totalMinor,3000);

  const salesInvoices=getDetailedReport({type:'sales-invoices'}).rows;
  assert.equal(salesInvoices.find(row=>row.reference===sale.receiptNumber).dueMinor,5000);
  const purchaseInvoices=getDetailedReport({type:'purchase-invoices'}).rows;
  assert.equal(purchaseInvoices.find(row=>row.reference===purchase.invoiceNumber).dueMinor,5000);

  const salesProducts=getDetailedReport({type:'sales-products'}).rows;
  assert.equal(salesProducts.find(row=>row.itemId===productId).quantity,2);
  assert.equal(salesProducts.find(row=>row.itemId===productId).netSalesMinor,6000);
  assert.equal(salesProducts.find(row=>row.itemId===productId).costMinor,2000);
  assert.equal(salesProducts.find(row=>row.itemId===productId).profitMinor,4000);
  const purchaseProducts=getDetailedReport({type:'purchase-products'}).rows;
  assert.equal(purchaseProducts.find(row=>row.productId===productId).quantity,7);
  assert.equal(purchaseProducts.find(row=>row.productId===productId).netCostMinor,7000);

  const salesPayments=getDetailedReport({type:'sales-payments'}).rows;
  assert.equal(salesPayments.filter(row=>row.direction==='in').reduce((sum,row)=>sum+row.totalMinor,0),7000);
  assert.equal(salesPayments.filter(row=>row.direction==='out').reduce((sum,row)=>sum+row.totalMinor,0),6000);
  const purchasePayments=getDetailedReport({type:'purchase-payments'}).rows;
  assert.equal(purchasePayments.filter(row=>row.direction==='out').reduce((sum,row)=>sum+row.totalMinor,0),5000);
  assert.equal(purchasePayments.filter(row=>row.direction==='in').reduce((sum,row)=>sum+row.totalMinor,0),3000);

  assertLedgerBalanced();
});

test('closes integrated-cycle database',()=>{
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
