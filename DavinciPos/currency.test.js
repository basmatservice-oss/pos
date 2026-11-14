import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-currency-'));
process.env.DAVINCIPOS_DB=path.join(dir,'test.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {createProduct}=await import('./catalog.js');
const {recordExchangeRate,getCurrentExchangeRate,configureProductCurrency}=await import('./currency.js');
initializeDatabase();
test('USD price sources update local prices when an exchange rate is recorded',()=>{
 const productId=createProduct({name:'USD Product',baseUnitId:'unit-piece',salePriceMinor:0});
 recordExchangeRate({rate:2500});
 const configured=configureProductCurrency(productId,{currency:'USD',foreignCostMinor:100,foreignSalePriceMinor:500,autoUpdate:true});
 assert.equal(configured.salePriceMinor,1250000);
 assert.equal(configured.priceCurrency,'USD');
 const changed=recordExchangeRate({rate:3000,applyAutomatically:true});
 assert.equal(changed.updatedProducts,1);
 assert.equal(db.prepare('SELECT sale_price_minor FROM products WHERE id=?').get(productId).sale_price_minor,1500000);
 assert.equal(getCurrentExchangeRate().rate,3000);
 const decreased=recordExchangeRate({rate:2000,applyAutomatically:true});
 assert.equal(decreased.updatedProducts,1);
 assert.equal(db.prepare('SELECT sale_price_minor FROM products WHERE id=?').get(productId).sale_price_minor,1000000);
});
test('rejects invalid exchange rates',()=>{
 assert.throws(()=>recordExchangeRate({rate:0}),/positive number/);
});
test('closes currency database',()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
