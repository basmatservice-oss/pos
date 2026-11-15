import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-full-cycle-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {createCustomer,createSupplier}=await import('./catalog.js');
const {receivePurchase}=await import('./purchases.js');
const {checkoutSale}=await import('./sales.js');
const {createSalesReturn,createPurchaseReturn,getSalesReturnOptions,getPurchaseReturnOptions}=await import('./returns.js');
const {recordCustomerPayment,recordSupplierPayment,listCustomerBalances,listSupplierBalances}=await import('./settlements.js');
const {getStockOnHand,getInventoryValue}=await import('./inventory.js');
const {getTrialBalance,postJournalEntry,reverseJournalEntry}=await import('./accounting.js');
const {getSimpleReport,getDetailedReport}=await import('./reports.js');
const {updateSettings}=await import('./settings.js');
const {saveTaxProfile}=await import('./tax.js');
const {acceptOfflineSale,resolveSyncConflict}=await import('./offline.js');

initializeDatabase();
updateSettings({'tax.enabled':false});

test('offline sync receipt replay is restricted to the device that created the operation',()=>{
  const now=new Date().toISOString();
  const userId='offline-replay-owner';
  db.prepare("INSERT INTO users(id,username,password_hash,display_name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
    .run(userId,'offline-replay-owner','test-hash','Offline Replay Owner','owner',now,now);
  for(const deviceId of ['offline-device-a','offline-device-b']){
    db.prepare("INSERT INTO devices(id,name,platform,branch_id,owner_user_id,is_active,created_at) VALUES(?,?, 'web','branch-main',?,1,?)")
      .run(deviceId,deviceId,userId,now);
  }
  const operationId='shared-operation-id';
  db.prepare("INSERT INTO sync_receipts(operation_id,device_id,payload_hash,response,created_at) VALUES(?,?,?,?,?)")
    .run(operationId,'offline-device-a',createHash('sha256').update(JSON.stringify({test:'original'})).digest('hex'),JSON.stringify({status:'accepted',sale:{id:'already-recorded'}}),now);
  assert.deepEqual(acceptOfflineSale({operationId,deviceId:'offline-device-a',payload:{test:'original'},userId}),{status:'accepted',sale:{id:'already-recorded'}});
  assert.throws(()=>acceptOfflineSale({operationId,deviceId:'offline-device-b',payload:{test:'original'},userId}),/another device/);
  assert.throws(()=>acceptOfflineSale({operationId,deviceId:'offline-device-a',payload:{test:'changed'},userId}),/different payload/);

  const conflictOperation='offline-conflict-operation';
  const originalPayload={test:'conflict-payload'};
  const conflictId='offline-conflict-test';
  db.prepare("INSERT INTO sync_conflicts(id,operation_id,device_id,entity_type,entity_id,payload,payload_hash,reason,status,created_at) VALUES(?,?,?,'sale',?,?,?,?, 'pending',?)")
    .run(conflictId,conflictOperation,'offline-device-a',conflictOperation,JSON.stringify({...originalPayload,deviceId:'offline-device-a',cashierId:userId,branchId:'branch-main',allowCredit:false}),createHash('sha256').update(JSON.stringify(originalPayload)).digest('hex'),'test conflict',now);
  assert.equal(resolveSyncConflict(conflictId,{decision:'reject',userId}).status,'rejected');
  assert.equal(acceptOfflineSale({operationId:conflictOperation,deviceId:'offline-device-a',payload:originalPayload,userId}).status,'rejected');
  assert.throws(()=>acceptOfflineSale({operationId:conflictOperation,deviceId:'offline-device-a',payload:{test:'tampered'},userId}),/different payload/);
});

test('rejects impossible calendar dates in financial reports',()=>{
  assert.throws(()=>getSimpleReport({from:'2026-02-31'}),/Invalid report date/);
});

function assertLedgerBalanced({from=null,to=null}={}){
  const rows=getTrialBalance({from,to});
  const debits=rows.reduce((sum,row)=>sum+row.debitMinor,0);
  const credits=rows.reduce((sum,row)=>sum+row.creditMinor,0);
  assert.equal(debits,credits);
}

function assertProfitAndLossMatchesTrialBalance({from=null,to=null}={}){
  const rows=getTrialBalance({from,to});
  const ledgerNetProfit=rows.reduce((sum,row)=>sum+
    (row.accountType==='revenue'?row.creditMinor-row.debitMinor:
      row.accountType==='expense'?row.creditMinor-row.debitMinor:0),0);
  assert.equal(getSimpleReport({from,to}).netProfitMinor,ledgerNetProfit);
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
  const stockValue=getInventoryValue(productId,'branch-main');
  const inventoryLedger=getTrialBalance().find(account=>account.accountId==='acc-inventory');
  assert.equal(stockValue,5000,'Remaining stock valuation must reflect the net purchase, sale and return movements');
  assert.equal(inventoryLedger.netDebitMinor,stockValue,'Inventory asset ledger must reconcile to on-hand stock valuation');

  assert.throws(()=>recordCustomerPayment(sale.id,{amountMinor:5001,method:'cash'}),/exceeds the remaining invoice balance/);
  assert.throws(()=>recordSupplierPayment(purchase.id,{amountMinor:5001,method:'cash'}),/exceeds the remaining supplier balance/);
  assert.throws(()=>createSalesReturn(sale.id,{lines:[{saleLineId:saleLine.id,quantity:3}]}),/exceeds the unreturned quantity/);
  assert.throws(()=>createPurchaseReturn(purchase.id,{lines:[{purchaseLineId:purchaseLine.id,quantity:8}]}),/exceeds the unreturned quantity/);

  const report=getSimpleReport({});
  assert.equal(report.salesTotalMinor,6000);
  assert.equal(report.purchasesTotalMinor,7000);
  assert.equal(report.ledgerSalesMinor,6000);
  assert.equal(report.cogsMinor,2000);
  assert.equal(report.grossProfitMinor,4000);
  assert.equal(report.otherIncomeMinor,0);
  assert.equal(report.expensesTotalMinor,0);
  assert.equal(report.netProfitMinor,4000);
  assertProfitAndLossMatchesTrialBalance();
  const invoicePeriod=getSimpleReport({from:'2026-11-01',to:'2026-11-01'});
  assert.equal(invoicePeriod.salesTotalMinor,12000);
  assert.equal(invoicePeriod.purchasesTotalMinor,10000);
  assert.equal(invoicePeriod.ledgerSalesMinor,12000);
  assert.equal(invoicePeriod.cogsMinor,4000);
  assert.equal(invoicePeriod.grossProfitMinor,8000);
  assert.equal(invoicePeriod.topProducts[0].quantity,4);
  assert.equal(invoicePeriod.topProducts[0].totalMinor,12000);
  assertProfitAndLossMatchesTrialBalance({from:'2026-11-01',to:'2026-11-01'});
  const returnPeriod=getSimpleReport({from:'2026-11-15',to:'2026-11-15'});
  assert.equal(returnPeriod.salesTotalMinor,-6000);
  assert.equal(returnPeriod.purchasesTotalMinor,-3000);
  assert.equal(returnPeriod.ledgerSalesMinor,-6000);
  assert.equal(returnPeriod.cogsMinor,-2000);
  assert.equal(returnPeriod.grossProfitMinor,-4000);
  assert.equal(returnPeriod.topProducts[0].quantity,-2);
  assert.equal(returnPeriod.topProducts[0].totalMinor,-6000);
  assertProfitAndLossMatchesTrialBalance({from:'2026-11-15',to:'2026-11-15'});

  const dailyInvoice=getDetailedReport({type:'sales-daily',from:'2026-11-01',to:'2026-11-01'}).rows[0];
  assert.equal(dailyInvoice.day,'2026-11-01');
  assert.equal(dailyInvoice.invoices,1);
  assert.equal(dailyInvoice.returns,0);
  assert.equal(dailyInvoice.totalMinor,12000);
  const dailyReturns=getDetailedReport({type:'sales-daily',from:'2026-11-15',to:'2026-11-15'}).rows[0];
  assert.equal(dailyReturns.day,'2026-11-15');
  assert.equal(dailyReturns.invoices,0);
  assert.equal(dailyReturns.returns,2);
  assert.equal(dailyReturns.totalMinor,-6000);

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
  const salesProductsOnInvoiceDate=getDetailedReport({type:'sales-products',from:'2026-11-01',to:'2026-11-01'}).rows;
  assert.equal(salesProductsOnInvoiceDate.find(row=>row.itemId===productId).quantity,4);
  assert.equal(salesProductsOnInvoiceDate.find(row=>row.itemId===productId).profitMinor,8000);
  const salesProductsOnReturnDate=getDetailedReport({type:'sales-products',from:'2026-11-15',to:'2026-11-15'}).rows;
  assert.equal(salesProductsOnReturnDate.find(row=>row.itemId===productId).quantity,-2);
  assert.equal(salesProductsOnReturnDate.find(row=>row.itemId===productId).profitMinor,-4000);
  const purchaseProducts=getDetailedReport({type:'purchase-products'}).rows;
  assert.equal(purchaseProducts.find(row=>row.productId===productId).quantity,7);
  assert.equal(purchaseProducts.find(row=>row.productId===productId).netCostMinor,7000);
  const purchaseProductsOnInvoiceDate=getDetailedReport({type:'purchase-products',from:'2026-11-01',to:'2026-11-01'}).rows;
  assert.equal(purchaseProductsOnInvoiceDate.find(row=>row.productId===productId).quantity,10);
  assert.equal(purchaseProductsOnInvoiceDate.find(row=>row.productId===productId).netCostMinor,10000);
  const purchaseProductsOnReturnDate=getDetailedReport({type:'purchase-products',from:'2026-11-15',to:'2026-11-15'}).rows;
  assert.equal(purchaseProductsOnReturnDate.find(row=>row.productId===productId).quantity,-3);
  assert.equal(purchaseProductsOnReturnDate.find(row=>row.productId===productId).netCostMinor,-3000);

  const salesPayments=getDetailedReport({type:'sales-payments'}).rows;
  assert.equal(salesPayments.filter(row=>row.direction==='in').reduce((sum,row)=>sum+row.totalMinor,0),7000);
  assert.equal(salesPayments.filter(row=>row.direction==='out').reduce((sum,row)=>sum+row.totalMinor,0),6000);
  const salesPaymentPeriod=getDetailedReport({type:'sales-payments',from:'2026-11-15',to:'2026-11-15'}).rows;
  assert.equal(salesPaymentPeriod.filter(row=>row.direction==='in').reduce((sum,row)=>sum+row.totalMinor,0),3000);
  assert.equal(salesPaymentPeriod.filter(row=>row.direction==='out').reduce((sum,row)=>sum+row.totalMinor,0),6000);
  const purchasePayments=getDetailedReport({type:'purchase-payments'}).rows;
  assert.equal(purchasePayments.filter(row=>row.direction==='out').reduce((sum,row)=>sum+row.totalMinor,0),5000);
  assert.equal(purchasePayments.filter(row=>row.direction==='in').reduce((sum,row)=>sum+row.totalMinor,0),3000);
  const purchasePaymentPeriod=getDetailedReport({type:'purchase-payments',from:'2026-11-15',to:'2026-11-15'}).rows;
  assert.equal(purchasePaymentPeriod.filter(row=>row.direction==='out').reduce((sum,row)=>sum+row.totalMinor,0),2000);
  assert.equal(purchasePaymentPeriod.filter(row=>row.direction==='in').reduce((sum,row)=>sum+row.totalMinor,0),3000);

  assertLedgerBalanced();

  updateSettings({'tax.enabled':true,'tax.purchase_mode':'recoverable','tax.price_mode':'exclusive'});
  saveTaxProfile({id:'integration-tax-10',name:'Integration 10%',rateBps:1000,priceMode:'exclusive',isDefault:true});
  const taxedProductId='integrated-tax-product';
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,track_stock,created_at,updated_at) VALUES(?,?,?,1000,3000,1,?,?)")
    .run(taxedProductId,'Taxed integration item','unit-piece',new Date().toISOString(),new Date().toISOString());
  const taxedPurchase=receivePurchase({
    id:'integrated-tax-purchase',branchId:'branch-main',supplierId,occurredAt:'2026-11-01T11:00:00.000Z',
    lines:[{productId:taxedProductId,quantity:2,unitCostMinor:1000}],
    payments:[{method:'cash',amountMinor:2200}]
  });
  assert.equal(taxedPurchase.subtotalMinor,2000);
  assert.equal(taxedPurchase.taxMinor,200);
  assert.equal(taxedPurchase.totalMinor,2200);
  const taxedSale=checkoutSale({
    id:'integrated-tax-sale',branchId:'branch-main',customerId,allowCredit:false,occurredAt:'2026-11-01T12:00:00.000Z',
    lines:[{itemId:taxedProductId,quantity:2}],
    payments:[{method:'cash',amountMinor:6600}]
  });
  assert.equal(taxedSale.subtotalMinor,6000);
  assert.equal(taxedSale.taxMinor,600);
  assert.equal(taxedSale.totalMinor,6600);
  const taxedSaleLine=getSalesReturnOptions(taxedSale.id).lines[0];
  const taxedSalesReturn=createSalesReturn(taxedSale.id,{
    id:'integrated-tax-sales-return',occurredAt:'2026-11-15T10:00:00.000Z',
    lines:[{saleLineId:taxedSaleLine.id,quantity:1}],refundMethod:'cash'
  });
  assert.equal(taxedSalesReturn.totalMinor,3300);
  assert.equal(taxedSalesReturn.taxMinor,300);
  assert.equal(taxedSalesReturn.refundMinor,3300);
  const taxedPurchaseLine=getPurchaseReturnOptions(taxedPurchase.id).lines[0];
  const taxedPurchaseReturn=createPurchaseReturn(taxedPurchase.id,{
    id:'integrated-tax-purchase-return',occurredAt:'2026-11-15T11:00:00.000Z',
    lines:[{purchaseLineId:taxedPurchaseLine.id,quantity:1}],refundMethod:'cash'
  });
  assert.equal(taxedPurchaseReturn.totalMinor,1100);
  assert.equal(taxedPurchaseReturn.taxMinor,100);
  assert.equal(taxedPurchaseReturn.removedCostMinor,1000);

  const taxedSalesProducts=getDetailedReport({type:'sales-products'}).rows.find(row=>row.itemId===taxedProductId);
  assert.equal(taxedSalesProducts.quantity,1);
  assert.equal(taxedSalesProducts.netSalesMinor,3000);
  assert.equal(taxedSalesProducts.taxMinor,300);
  assert.equal(taxedSalesProducts.costMinor,1000);
  assert.equal(taxedSalesProducts.profitMinor,2000);
  const taxedPurchaseProducts=getDetailedReport({type:'purchase-products'}).rows.find(row=>row.productId===taxedProductId);
  assert.equal(taxedPurchaseProducts.quantity,1);
  assert.equal(taxedPurchaseProducts.netCostMinor,1000);
  assert.equal(taxedPurchaseProducts.taxMinor,100);
  const taxOnInvoiceDate=getDetailedReport({type:'tax-summary',from:'2026-11-01',to:'2026-11-01'}).rows[0];
  assert.equal(taxOnInvoiceDate.collectedTaxMinor,600);
  assert.equal(taxOnInvoiceDate.inputTaxMinor,200);
  assert.equal(taxOnInvoiceDate.netTaxMinor,400);
  assert.equal(taxOnInvoiceDate.returns,0);
  assert.equal(taxOnInvoiceDate.purchaseInvoices,2); // Original untaxed purchase plus the taxable purchase.
  const taxOnReturnDate=getDetailedReport({type:'tax-summary',from:'2026-11-15',to:'2026-11-15'}).rows[0];
  assert.equal(taxOnReturnDate.collectedTaxMinor,-300);
  assert.equal(taxOnReturnDate.inputTaxMinor,-100);
  assert.equal(taxOnReturnDate.netTaxMinor,-200);
  assert.equal(taxOnReturnDate.returns,3);
  assert.equal(taxOnReturnDate.purchaseReturns,3); // Two earlier purchase returns plus this taxable return.
  assertLedgerBalanced();
});

test('reversed journal entries remain in trial balance and net to zero in profit and loss',()=>{
  const beforeRows=getTrialBalance();
  const beforeProfit=getSimpleReport({}).netProfitMinor;
  const entryId=postJournalEntry({
    sourceType:'test-reversal',sourceId:'test-reversal-2026-11-15',
    description:'Reversal reconciliation test',occurredAt:'2026-11-15T12:00:00.000Z',
    lines:[{accountId:'acc-cash',debitMinor:1250},{accountId:'acc-sales',creditMinor:1250}]
  });
  const reversalId=reverseJournalEntry(entryId,'Integration test');
  assert.ok(reversalId);
  assert.equal(reverseJournalEntry(entryId,'Repeat reversal'),reversalId);
  const afterRows=getTrialBalance();
  for(const accountId of ['acc-cash','acc-sales']){
    const before=beforeRows.find(row=>row.accountId===accountId);
    const after=afterRows.find(row=>row.accountId===accountId);
    assert.equal(after.netDebitMinor-before.netDebitMinor,0);
  }
  assert.equal(getSimpleReport({}).netProfitMinor,beforeProfit);
});
test('trial balance totals reconcile and profit and loss matches ledger account balances',()=>{
  const rows=getTrialBalance();
  const debitTotal=rows.reduce((sum,row)=>sum+row.debitMinor,0);
  const creditTotal=rows.reduce((sum,row)=>sum+row.creditMinor,0);
  assert.equal(debitTotal,creditTotal,'Trial balance debits must equal credits');
  const ledgerNetProfit=rows
    .filter(row=>row.accountType==='revenue'||row.accountType==='expense')
    .reduce((sum,row)=>sum-row.netDebitMinor,0);
  const profitAndLoss=getSimpleReport({}).netProfitMinor;
  assert.equal(profitAndLoss,ledgerNetProfit,'Profit and loss must reconcile to revenue and expense ledger balances');
  const summary=getSimpleReport({});
  assert.equal(summary.grossProfitMinor,summary.ledgerSalesMinor-summary.cogsMinor);
});
test('closes integrated-cycle database',()=>{
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});

