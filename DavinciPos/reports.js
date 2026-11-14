import { db } from './database.js';

function validDate(value) {
  if(value==null||value==='') return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z'))) throw new Error('Invalid report date.');
  return value;
}
function nextDate(value){const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}

export function getSimpleReport({from=null,to=null}={}) {
  from=validDate(from);to=validDate(to);
  if(from&&to&&from>to)throw new Error('Start date must be before end date.');
  const where=["status='posted'"],params=[];
  if(from){where.push('occurred_at>=?');params.push(from+'T00:00:00');}
  if(to){where.push('occurred_at<?');params.push(nextDate(to)+'T00:00:00');}
  const filter=where.join(' AND ');
  const sales=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS totalMinor,COALESCE(SUM(tax_minor),0) AS taxMinor FROM sales WHERE ${filter}`).get(...params);
  const purchases=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS totalMinor FROM purchases WHERE ${filter}`).get(...params);
  const expenseWhere=[],expenseParams=[];if(from){expenseWhere.push('occurred_at>=?');expenseParams.push(from+'T00:00:00');}if(to){expenseWhere.push('occurred_at<?');expenseParams.push(nextDate(to)+'T00:00:00');}
  const expenses=db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS totalMinor FROM expenses ${expenseWhere.length?'WHERE '+expenseWhere.join(' AND '):''}`).get(...expenseParams);
  const profit=db.prepare(`SELECT COALESCE(SUM(sl.line_total_minor-sl.tax_minor-sl.cost_total_minor),0) AS grossProfitMinor
    FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE ${filter.split(' AND ').map(x=>'s.'+x).join(' AND ')}`).get(...params);
  const topProducts=db.prepare(`SELECT sl.description AS name,SUM(sl.quantity) AS quantity,SUM(sl.line_total_minor-sl.tax_minor) AS totalMinor
    FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE ${filter.split(' AND ').map(x=>'s.'+x).join(' AND ')}
    GROUP BY sl.item_id,sl.description ORDER BY totalMinor DESC LIMIT 5`).all(...params);
  const lowStock=db.prepare(`SELECT p.id,p.name,COALESCE(SUM(sm.quantity_delta),0) AS quantity,p.min_stock AS minStock
    FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id
    WHERE p.is_active=1 AND p.track_stock=1 GROUP BY p.id
    HAVING quantity<=p.min_stock ORDER BY quantity ASC,p.name LIMIT 20`).all();
  return {from,to,salesCount:sales.count,salesTotalMinor:sales.totalMinor,salesTaxMinor:sales.taxMinor,
    purchasesCount:purchases.count,purchasesTotalMinor:purchases.totalMinor,grossProfitMinor:profit.grossProfitMinor,expensesTotalMinor:expenses.totalMinor,netProfitMinor:profit.grossProfitMinor-expenses.totalMinor,
    topProducts,lowStock};
}

const REPORTS = {
  'expenses': `SELECT e.category,e.occurred_at AS occurredAt,e.amount_minor AS amountMinor,e.payment_method AS paymentMethod,e.provider,e.reference,e.note,u.display_name AS createdBy FROM expenses e LEFT JOIN users u ON u.id=e.created_by WHERE {{where}} ORDER BY e.occurred_at DESC`,
  'sales-daily': `SELECT date(s.occurred_at) AS day,COUNT(*) AS invoices,SUM(s.total_minor) AS totalMinor,SUM(s.tax_minor) AS taxMinor
    FROM sales s WHERE s.status IN ('posted','partially_returned','returned') AND {{where}} GROUP BY date(s.occurred_at) ORDER BY day DESC`,
  'sales-invoices': `SELECT s.receipt_number AS reference,s.occurred_at AS occurredAt,COALESCE(c.name,'عميل نقدي') AS party,
    s.status,s.subtotal_minor AS subtotalMinor,s.tax_minor AS taxMinor,s.total_minor AS totalMinor,
    COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.sale_id=s.id AND p.direction='in'),0) AS paidMinor,
    s.total_minor-COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.sale_id=s.id AND p.direction='in'),0) AS dueMinor
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='void' AND {{where}} ORDER BY s.occurred_at DESC`,
  'sales-products': `SELECT sl.item_id AS itemId,sl.description AS name,SUM(sl.quantity) AS quantity,
    SUM(sl.line_total_minor-sl.tax_minor) AS netSalesMinor,SUM(sl.tax_minor) AS taxMinor,SUM(sl.cost_total_minor) AS costMinor,
    SUM(sl.line_total_minor-sl.tax_minor-sl.cost_total_minor) AS profitMinor
    FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE s.status!='void' AND {{where}} GROUP BY sl.item_id,sl.description ORDER BY netSalesMinor DESC`,
  'sales-categories': `SELECT COALESCE(c.name,'بدون تصنيف') AS category,SUM(sl.quantity) AS quantity,
    SUM(sl.line_total_minor-sl.tax_minor) AS netSalesMinor,SUM(sl.tax_minor) AS taxMinor
    FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id LEFT JOIN products p ON sl.line_type='product' AND p.id=sl.item_id
    LEFT JOIN categories c ON c.id=p.category_id WHERE s.status!='void' AND {{where}} GROUP BY c.id,c.name ORDER BY netSalesMinor DESC`,
  'sales-customers': `SELECT COALESCE(c.name,'عميل نقدي') AS customer,COUNT(DISTINCT s.id) AS invoices,
    SUM(s.total_minor) AS totalMinor, SUM(s.total_minor-COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.sale_id=s.id AND p.direction='in'),0)) AS dueMinor
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='void' AND {{where}} GROUP BY c.id,c.name ORDER BY totalMinor DESC`,
  'sales-payments': `SELECT p.method,p.provider,COUNT(*) AS operations,SUM(p.amount_minor) AS totalMinor
    FROM payments p JOIN sales s ON s.id=p.sale_id WHERE p.direction='in' AND s.status!='void' AND {{where}} GROUP BY p.method,p.provider ORDER BY totalMinor DESC`,
  'purchase-invoices': `SELECT p.invoice_number AS reference,p.occurred_at AS occurredAt,COALESCE(s.name,'بدون مورد') AS party,
    p.status,p.subtotal_minor AS subtotalMinor,p.tax_minor AS taxMinor,p.total_minor AS totalMinor,
    COALESCE((SELECT SUM(pp.amount_minor) FROM purchase_payments pp WHERE pp.purchase_id=p.id),0) AS paidMinor,
    p.total_minor-COALESCE((SELECT SUM(pp.amount_minor) FROM purchase_payments pp WHERE pp.purchase_id=p.id),0) AS dueMinor
    FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.status!='void' AND {{where}} ORDER BY p.occurred_at DESC`,
  'purchase-products': `SELECT pr.id AS productId,pr.name,SUM(pl.quantity) AS quantity,SUM(pl.line_total_minor) AS netCostMinor,SUM(pl.tax_minor) AS taxMinor
    FROM purchase_lines pl JOIN purchases pu ON pu.id=pl.purchase_id JOIN products pr ON pr.id=pl.product_id
    WHERE pu.status!='void' AND {{where}} GROUP BY pr.id,pr.name ORDER BY netCostMinor DESC`,
  'purchase-categories': `SELECT COALESCE(c.name,'بدون تصنيف') AS category,SUM(pl.quantity) AS quantity,
    SUM(pl.line_total_minor) AS netCostMinor,SUM(pl.tax_minor) AS taxMinor
    FROM purchase_lines pl JOIN purchases pu ON pu.id=pl.purchase_id JOIN products pr ON pr.id=pl.product_id
    LEFT JOIN categories c ON c.id=pr.category_id WHERE pu.status!='void' AND {{where}} GROUP BY c.id,c.name ORDER BY netCostMinor DESC`,
  'purchase-payments': `SELECT pp.method,pp.provider,COUNT(*) AS operations,SUM(pp.amount_minor) AS totalMinor
    FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id WHERE pu.status!='void' AND {{where}} GROUP BY pp.method,pp.provider ORDER BY totalMinor DESC`,
  'stock-on-hand': `SELECT p.id AS productId,p.name,p.sku,p.barcode,u.symbol AS unit,
    COALESCE(SUM(sm.quantity_delta),0) AS quantity,p.min_stock AS minStock,
    COALESCE(SUM(CASE WHEN sm.quantity_delta>0 THEN sm.cost_total_minor ELSE -sm.cost_total_minor END),0) AS stockValueMinor
    FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id AND sm.branch_id=? LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE p.is_active=1 AND p.track_stock=1 GROUP BY p.id ORDER BY p.name`,
  'stock-movements': `SELECT sm.occurred_at AS occurredAt,p.name AS product,sm.source_type AS source,
    sm.source_id AS reference,sm.quantity_delta AS quantityDelta,sm.unit_cost_minor AS unitCostMinor,sm.cost_total_minor AS costTotalMinor
    FROM stock_movements sm JOIN products p ON p.id=sm.product_id WHERE {{where}} ORDER BY sm.occurred_at DESC`,
  'tax-summary': `SELECT s.currency_code AS currency, SUM(s.tax_minor) AS collectedTaxMinor,COUNT(*) AS invoices
    FROM sales s WHERE s.status!='void' AND {{where}} GROUP BY s.currency_code`,
  'cash-movements': `SELECT occurredAt,source,reference,method,provider,direction,amountMinor FROM (
    SELECT p.occurred_at AS occurredAt,'بيع' AS source,s.receipt_number AS reference,p.method,p.provider,'in' AS direction,p.amount_minor AS amountMinor
    FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.status!='void'
    UNION ALL
    SELECT pp.occurred_at AS occurredAt,'شراء' AS source,pu.invoice_number AS reference,pp.method,pp.provider,'out' AS direction,pp.amount_minor AS amountMinor
    FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id WHERE pu.status!='void'
  ) x WHERE {{where}} ORDER BY occurredAt DESC`
};

function buildDateFilter(alias,from,to) {
  const clauses=[],params=[];
  if(from){clauses.push(alias+'.occurred_at>=?');params.push(from+'T00:00:00');}
  if(to){clauses.push(alias+'.occurred_at<?');params.push(nextDate(to)+'T00:00:00');}
  return {sql:clauses.length?clauses.join(' AND '):'1=1',params};
}

export function getDetailedReport({type,from=null,to=null,branchId=null}={}) {
  from=validDate(from);to=validDate(to);
  if(from&&to&&from>to)throw new Error('Start date must be before end date.');
  const template=REPORTS[type];
  if(!template)throw new Error('Unknown report type.');
  const aliasByType={
    'sales-daily':'s','sales-invoices':'s','sales-products':'s','sales-categories':'s','sales-customers':'s','sales-payments':'s',
    'purchase-invoices':'p','purchase-products':'pu','purchase-categories':'pu','purchase-payments':'pu',
    'stock-movements':'sm','tax-summary':'s','cash-movements':'x','expenses':'e'
  };
  const alias=aliasByType[type];
  let rows;
  if(type==='stock-on-hand') {
    rows=db.prepare(template).all(branchId||null);
  } else if(type==='cash-movements') {
    const filter={sql:(from?'x.occurredAt>=? AND ':'')+(to?'x.occurredAt<?':'1=1'),params:[...(from?[from+'T00:00:00']:[]),...(to?[nextDate(to)+'T00:00:00']:[])]};
    rows=db.prepare(template.replace('{{where}}',filter.sql)).all(...filter.params);
  } else {
    const filter=buildDateFilter(alias,from,to);
    rows=db.prepare(template.replaceAll('{{where}}',filter.sql)).all(...filter.params);
  }
  const totalMinor=rows.reduce((sum,row)=>sum+Number(row.totalMinor??row.netSalesMinor??row.netCostMinor??row.amountMinor??row.collectedTaxMinor??0),0);
  return {type,from,to,count:rows.length,totalMinor,rows};
}

export const availableReports = Object.keys(REPORTS);
