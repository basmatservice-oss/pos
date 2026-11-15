import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-fifo-returns-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {configureInventoryCostMethod,receiveStock,getStockOnHand,getInventoryValue,issueStock}=await import('./inventory.js');
const {checkoutSale}=await import('./sales.js');
const {createSalesReturn,getSalesReturnOptions}=await import('./returns.js');

initializeDatabase();
configureInventoryCostMethod('fifo');

test('partial sales returns restore the exact original FIFO cost layers',()=>{
  const productId='fifo-return-product';
  db.prepare("INSERT INTO products(id,name,base_unit_id,cost_minor,sale_price_minor,track_stock,created_at,updated_at) VALUES(?,?,?,100,300,1,?,?)")
    .run(productId,'FIFO return item','unit-piece',new Date().toISOString(),new Date().toISOString());
  receiveStock({productId,branchId:'branch-main',sourceType:'purchase',sourceId:'fifo-layer-cheap',quantity:1,unitCostMinor:100,occurredAt:'2026-11-01T08:00:00.000Z'});
  receiveStock({productId,branchId:'branch-main',sourceType:'purchase',sourceId:'fifo-layer-expensive',quantity:1,unitCostMinor:300,occurredAt:'2026-11-02T08:00:00.000Z'});

  const sale=checkoutSale({id:'fifo-return-sale',branchId:'branch-main',occurredAt:'2026-11-03T08:00:00.000Z',
    lines:[{itemId:productId,quantity:2}],payments:[{method:'cash',amountMinor:600}]});
  assert.equal(sale.costMinor,400);
  assert.equal(getStockOnHand(productId,'branch-main'),0);
  assert.equal(getInventoryValue(productId,'branch-main'),0);

  const line=getSalesReturnOptions(sale.id).lines[0];
  const first=createSalesReturn(sale.id,{id:'fifo-return-first',occurredAt:'2026-11-04T08:00:00.000Z',
    lines:[{saleLineId:line.id,quantity:1}],refundMethod:'cash'});
  assert.equal(first.restoredCostMinor,100);
  assert.equal(getStockOnHand(productId,'branch-main'),1);
  assert.equal(getInventoryValue(productId,'branch-main'),100);

  const reissue=issueStock({productId,branchId:'branch-main',sourceType:'test-reissue',sourceId:'fifo-reissue',quantity:1,costMethod:'fifo'});
  assert.equal(reissue.costTotalMinor,100);
  assert.equal(getStockOnHand(productId,'branch-main'),0);
  assert.equal(getInventoryValue(productId,'branch-main'),0);

  const second=createSalesReturn(sale.id,{id:'fifo-return-second',occurredAt:'2026-11-05T08:00:00.000Z',
    lines:[{saleLineId:line.id,quantity:1}],refundMethod:'cash'});
  assert.equal(second.restoredCostMinor,300);
  assert.equal(getStockOnHand(productId,'branch-main'),1);
  assert.equal(getInventoryValue(productId,'branch-main'),300);
});

test('closes FIFO return database',()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
