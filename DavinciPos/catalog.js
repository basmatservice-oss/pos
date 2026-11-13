import { randomUUID } from 'node:crypto';
import { db } from './database.js';

function requiredText(value,label,max=160){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new Error(`Invalid ${label}.`);return value.trim();}
function money(value,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error(`Invalid ${label}.`);return n;}
export function listProducts(branchId) {
  return db.prepare(`SELECT p.id,p.sku,p.barcode,p.name,p.category_id AS categoryId,p.base_unit_id AS baseUnitId,
    p.cost_minor AS costMinor,p.sale_price_minor AS salePriceMinor,p.tax_rate_bps AS taxRateBps,p.track_stock AS trackStock,
    p.min_stock AS minStock,p.is_active AS isActive,c.name AS categoryName,u.symbol AS baseUnitSymbol,
    COALESCE((SELECT SUM(sm.quantity_delta) FROM stock_movements sm WHERE sm.product_id=p.id AND sm.branch_id=?),0) AS stockOnHand
    FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN units u ON u.id=p.base_unit_id WHERE p.is_active=1 ORDER BY p.name`).all(branchId);
}
export function createProduct(input) {
  const name=requiredText(input?.name,'product name'),baseUnitId=requiredText(input?.baseUnitId,'base unit');
  if(!db.prepare('SELECT id FROM units WHERE id=?').get(baseUnitId))throw new Error('Base unit not found.');
  const taxRateBps=Number(input.taxRateBps||0),minStock=Number(input.minStock||0);
  if(!Number.isSafeInteger(taxRateBps)||taxRateBps<0||taxRateBps>10000||!Number.isFinite(minStock)||minStock<0)throw new Error('Invalid product tax rate or minimum stock.');
  const id=input.id||randomUUID(),now=new Date().toISOString();
  db.prepare(`INSERT INTO products(id,sku,barcode,name,category_id,base_unit_id,cost_minor,sale_price_minor,tax_rate_bps,track_stock,min_stock,is_active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id,input.sku?requiredText(input.sku,'SKU',80):null,input.barcode?requiredText(input.barcode,'barcode',100):null,name,input.categoryId||null,baseUnitId,money(input.costMinor||0,'cost'),money(input.salePriceMinor||0,'sale price'),taxRateBps,input.trackStock===false?0:1,minStock,now,now);
  return id;
}
export function updateProduct(id,input) {
  const current=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!current)throw new Error('Product not found.');
  const baseUnitId=input.baseUnitId??current.base_unit_id;
  if(baseUnitId!==current.base_unit_id&&db.prepare('SELECT 1 FROM stock_movements WHERE product_id=? LIMIT 1').get(id))throw new Error('Base unit cannot be changed after stock movements exist.');
  const taxRateBps=input.taxRateBps===undefined?current.tax_rate_bps:Number(input.taxRateBps);
  const minStock=input.minStock===undefined?current.min_stock:Number(input.minStock);
  if(!Number.isSafeInteger(taxRateBps)||taxRateBps<0||taxRateBps>10000||!Number.isFinite(minStock)||minStock<0)throw new Error('Invalid product tax rate or minimum stock.');
  const trackStock=input.trackStock===undefined?current.track_stock:input.trackStock===false?0:1;
  if(!trackStock&&db.prepare('SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM stock_movements WHERE product_id=?').get(id).quantity>0)throw new Error('A product with stock on hand cannot stop tracking stock.');
  db.prepare(`UPDATE products SET sku=?,barcode=?,name=?,category_id=?,base_unit_id=?,cost_minor=?,sale_price_minor=?,tax_rate_bps=?,track_stock=?,min_stock=?,is_active=?,updated_at=? WHERE id=?`)
    .run(input.sku===undefined?current.sku:(input.sku?requiredText(input.sku,'SKU',80):null),
      input.barcode===undefined?current.barcode:(input.barcode?requiredText(input.barcode,'barcode',100):null),
      input.name===undefined?current.name:requiredText(input.name,'product name'),
      input.categoryId===undefined?current.category_id:input.categoryId,baseUnitId,
      input.costMinor===undefined?current.cost_minor:money(input.costMinor,'cost'),
      input.salePriceMinor===undefined?current.sale_price_minor:money(input.salePriceMinor,'sale price'),
      taxRateBps,
      trackStock,minStock,
      input.isActive===undefined?current.is_active:input.isActive===false?0:1,new Date().toISOString(),id);
  return true;
}
export function createCategory(input) {
  const id=input.id||randomUUID(),name=requiredText(input?.name,'category name');
  db.prepare('INSERT INTO categories(id,name,color,created_at,updated_at) VALUES(?,?,?, ?,?)').run(id,name,input.color||'#64748b',new Date().toISOString(),new Date().toISOString());
  return id;
}
export function listCategories(){return db.prepare('SELECT id,name,color FROM categories ORDER BY name').all();}
export function createCustomer(input){
  const id=input.id||randomUUID(),name=requiredText(input?.name,'customer name');
  db.prepare('INSERT INTO customers(id,name,phone,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,name,input.phone||null,input.email||null,new Date().toISOString(),new Date().toISOString());
  return id;
}
export function listCustomers(){return db.prepare('SELECT id,name,phone,email FROM customers ORDER BY name').all();}
export function createSupplier(input){
  const id=input.id||randomUUID(),name=requiredText(input?.name,'supplier name');
  db.prepare('INSERT INTO suppliers(id,name,phone,email,address,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,name,input.phone||null,input.email||null,input.address||null,new Date().toISOString(),new Date().toISOString());
  return id;
}
export function listSuppliers(){return db.prepare('SELECT id,name,phone,email,address FROM suppliers ORDER BY name').all();}
export function listSales({limit=100}={}){return db.prepare("SELECT id,receipt_number AS receiptNumber,customer_id AS customerId,cashier_id AS cashierId,status,subtotal_minor AS subtotalMinor,tax_minor AS taxMinor,total_minor AS totalMinor,currency_code AS currencyCode,occurred_at AS occurredAt FROM sales ORDER BY occurred_at DESC LIMIT ?").all(Math.max(1,Math.min(500,Number(limit)||100)));}
export function listPurchases({limit=100}={}){return db.prepare("SELECT id,invoice_number AS invoiceNumber,supplier_id AS supplierId,status,subtotal_minor AS subtotalMinor,tax_minor AS taxMinor,total_minor AS totalMinor,tax_treatment AS taxTreatment,currency_code AS currencyCode,occurred_at AS occurredAt FROM purchases ORDER BY occurred_at DESC LIMIT ?").all(Math.max(1,Math.min(500,Number(limit)||100)));}
