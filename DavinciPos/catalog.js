import { randomUUID } from 'node:crypto';
import { db } from './database.js';

function requiredText(value,label,max=160){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new Error(`Invalid ${label}.`);return value.trim();}
function money(value,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error(`Invalid ${label}.`);return n;}
export function listProducts(branchId) {
  return db.prepare(`SELECT p.id,p.sku,p.barcode,p.name,p.category_id AS categoryId,p.base_unit_id AS baseUnitId,
    p.cost_minor AS costMinor,p.sale_price_minor AS salePriceMinor,p.price_currency AS priceCurrency,p.foreign_cost_minor AS foreignCostMinor,p.foreign_sale_price_minor AS foreignSalePriceMinor,p.auto_rate_update AS autoRateUpdate,p.tax_rate_bps AS taxRateBps,p.tax_exempt AS taxExempt,p.track_stock AS trackStock,
    p.min_stock AS minStock,p.is_active AS isActive,c.name AS categoryName,u.symbol AS baseUnitSymbol,
    COALESCE((SELECT SUM(sm.quantity_delta) FROM stock_movements sm WHERE sm.product_id=p.id AND sm.branch_id=?),0) AS stockOnHand,
    COALESCE((SELECT SUM(CASE WHEN sm.quantity_delta>0 THEN sm.cost_total_minor ELSE -sm.cost_total_minor END) FROM stock_movements sm WHERE sm.product_id=p.id AND sm.branch_id=?),0) AS inventoryValueMinor
    FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN units u ON u.id=p.base_unit_id WHERE p.is_active=1 ORDER BY p.name`).all(branchId,branchId);
}
export function createProduct(input) {
  const name=requiredText(input?.name,'product name'),baseUnitId=requiredText(input?.baseUnitId,'base unit');
  if(!db.prepare('SELECT id FROM units WHERE id=?').get(baseUnitId))throw new Error('Base unit not found.');
  const taxRateBps=Number(input.taxRateBps||0),minStock=Number(input.minStock||0);
  if(!Number.isSafeInteger(taxRateBps)||taxRateBps<0||taxRateBps>10000||!Number.isFinite(minStock)||minStock<0)throw new Error('Invalid product tax rate or minimum stock.');
  const id=input.id||randomUUID(),now=new Date().toISOString();
  db.prepare(`INSERT INTO products(id,sku,barcode,name,category_id,base_unit_id,cost_minor,sale_price_minor,tax_rate_bps,tax_exempt,track_stock,min_stock,is_active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id,input.sku?requiredText(input.sku,'SKU',80):null,input.barcode?requiredText(input.barcode,'barcode',100):null,name,input.categoryId||null,baseUnitId,money(input.costMinor||0,'cost'),money(input.salePriceMinor||0,'sale price'),taxRateBps,input.taxExempt?1:0,input.trackStock===false?0:1,minStock,now,now);
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
  db.prepare(`UPDATE products SET sku=?,barcode=?,name=?,category_id=?,base_unit_id=?,cost_minor=?,sale_price_minor=?,tax_rate_bps=?,tax_exempt=?,track_stock=?,min_stock=?,is_active=?,updated_at=? WHERE id=?`)
    .run(input.sku===undefined?current.sku:(input.sku?requiredText(input.sku,'SKU',80):null),
      input.barcode===undefined?current.barcode:(input.barcode?requiredText(input.barcode,'barcode',100):null),
      input.name===undefined?current.name:requiredText(input.name,'product name'),
      input.categoryId===undefined?current.category_id:input.categoryId,baseUnitId,
      input.costMinor===undefined?current.cost_minor:money(input.costMinor,'cost'),
      input.salePriceMinor===undefined?current.sale_price_minor:money(input.salePriceMinor,'sale price'),
      taxRateBps,input.taxExempt===undefined?current.tax_exempt:input.taxExempt?1:0,
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

export function listUnits(){return db.prepare('SELECT id,name,symbol,precision FROM units ORDER BY name').all();}
export function createUnit(input){
  const name=requiredText(input?.name,'unit name'),symbol=requiredText(input?.symbol,'unit symbol',16),precision=Number(input?.precision??0);
  if(!Number.isInteger(precision)||precision<0||precision>6)throw new Error('Unit precision must be between 0 and 6.');
  const id=input.id||randomUUID();db.prepare('INSERT INTO units(id,name,symbol,precision) VALUES(?,?,?,?)').run(id,name,symbol,precision);return id;
}
export function listProductUnits(productId){
  return db.prepare(`SELECT pu.id,pu.product_id AS productId,pu.unit_id AS unitId,u.name,u.symbol,pu.base_quantity AS baseQuantity,
    pu.barcode,pu.sale_price_minor AS salePriceMinor,pu.is_default_sale AS isDefaultSale
    FROM product_units pu JOIN units u ON u.id=pu.unit_id WHERE pu.product_id=? ORDER BY pu.is_default_sale DESC,u.name`).all(productId);
}
export function saveProductUnit(productId,input){
  if(!db.prepare('SELECT id FROM products WHERE id=?').get(productId))throw new Error('Product not found.');
  const unitId=requiredText(input?.unitId,'unit'),baseQuantity=Number(input?.baseQuantity);
  if(!db.prepare('SELECT id FROM units WHERE id=?').get(unitId)||!Number.isFinite(baseQuantity)||baseQuantity<=0)throw new Error('Invalid unit conversion.');
  const barcode=input.barcode?requiredText(input.barcode,'barcode',100):null;
  const salePrice=input.salePriceMinor===undefined||input.salePriceMinor===''?null:money(input.salePriceMinor,'unit sale price');
  const id=input.id||randomUUID();
  db.prepare(`INSERT INTO product_units(id,product_id,unit_id,base_quantity,barcode,sale_price_minor,is_default_sale)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(product_id,unit_id) DO UPDATE SET base_quantity=excluded.base_quantity,barcode=excluded.barcode,
    sale_price_minor=excluded.sale_price_minor,is_default_sale=excluded.is_default_sale`)
    .run(id,productId,unitId,baseQuantity,barcode,salePrice,input.isDefaultSale?1:0);
  return id;
}
export function lookupBarcode(code){
  const value=requiredText(String(code||''),'barcode',100);
  const product=db.prepare(`SELECT p.id AS productId,p.name,p.barcode,p.sale_price_minor AS salePriceMinor,p.base_unit_id AS unitId,
    u.name AS unitName,u.symbol AS unitSymbol,1 AS baseQuantity,NULL AS productUnitId,'product' AS lineType
    FROM products p JOIN units u ON u.id=p.base_unit_id WHERE p.barcode=? AND p.is_active=1
    UNION ALL
    SELECT p.id,p.name,pu.barcode,COALESCE(pu.sale_price_minor,p.sale_price_minor),pu.unit_id,u.name,u.symbol,pu.base_quantity,'product'
    FROM product_units pu JOIN products p ON p.id=pu.product_id JOIN units u ON u.id=pu.unit_id
    WHERE pu.barcode=? AND p.is_active=1 LIMIT 1`).get(value,value);
  if(product)return product;
  const service=db.prepare("SELECT id AS productId,name,code AS barcode,price_minor AS salePriceMinor,'service' AS lineType FROM services WHERE code=? AND is_active=1").get(value);
  if(service)return service;
  throw new Error('لم يتم العثور على صنف أو خدمة بهذا الباركود.');
}
export function listServices(){
  return db.prepare(`SELECT s.id,s.code,s.name,s.price_minor AS priceMinor,s.tax_rate_bps AS taxRateBps,s.is_active AS isActive,
    COALESCE((SELECT SUM(sc.quantity*p.cost_minor) FROM service_components sc JOIN products p ON p.id=sc.product_id WHERE sc.service_id=s.id),0) AS componentCostMinor
    FROM services s ORDER BY s.name`).all();
}
export function saveService(input){
  const name=requiredText(input?.name,'service name'),price=money(input?.priceMinor,'service price');
  const code=input.code?requiredText(input.code,'service code',100):null;
  const taxRate=Number(input.taxRateBps||0);
  if(!Number.isInteger(taxRate)||taxRate<0||taxRate>10000)throw new Error('Invalid service tax rate.');
  const id=input.id||randomUUID(),now=new Date().toISOString();
  if(input.id)db.prepare('UPDATE services SET code=?,name=?,price_minor=?,tax_rate_bps=?,tax_exempt=?,is_active=?,updated_at=? WHERE id=?')
    .run(code,name,price,taxRate,input.taxExempt?1:0,input.isActive===false?0:1,now,id);
  else db.prepare('INSERT INTO services(id,code,name,price_minor,tax_rate_bps,tax_exempt,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)')
    .run(id,code,name,price,taxRate,input.taxExempt?1:0,now,now);
  return id;
}
export function setServiceComponents(serviceId,components){
  if(!db.prepare('SELECT id FROM services WHERE id=?').get(serviceId))throw new Error('Service not found.');
  if(!Array.isArray(components))throw new Error('Service components must be a list.');
  const rows=components.map(item=>({productId:requiredText(item.productId,'component product'),quantity:Number(item.quantity)}));
  if(rows.some(row=>!Number.isFinite(row.quantity)||row.quantity<=0||!db.prepare('SELECT id FROM products WHERE id=? AND track_stock=1').get(row.productId)))throw new Error('Each service component must be a stock-tracked product with a positive quantity.');
  db.transaction(()=>{db.prepare('DELETE FROM service_components WHERE service_id=?').run(serviceId);const insert=db.prepare('INSERT INTO service_components(id,service_id,product_id,quantity) VALUES(?,?,?,?)');for(const row of rows)insert.run(randomUUID(),serviceId,row.productId,row.quantity);})();
  return listServiceComponents(serviceId);
}
export function listServiceComponents(serviceId){
  return db.prepare(`SELECT sc.product_id AS productId,p.name,sc.quantity,u.symbol AS unitSymbol,p.cost_minor AS unitCostMinor,
    ROUND(sc.quantity*p.cost_minor) AS componentCostMinor FROM service_components sc JOIN products p ON p.id=sc.product_id
    JOIN units u ON u.id=p.base_unit_id WHERE sc.service_id=? ORDER BY p.name`).all(serviceId);
}
