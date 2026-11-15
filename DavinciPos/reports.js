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
  const where=["status='posted'"],salesWhere=["status IN ('posted','partially_returned','returned')"],returnWhere=['1=1'],params=[];
  if(from){where.push('occurred_at>=?');salesWhere.push('occurred_at>=?');returnWhere.push('occurred_at>=?');params.push(from+'T00:00:00');}
  if(to){where.push('occurred_at<?');salesWhere.push('occurred_at<?');returnWhere.push('occurred_at<?');params.push(nextDate(to)+'T00:00:00');}
  const filter=where.join(' AND '),salesFilter=salesWhere.join(' AND '),returnsFilter=returnWhere.join(' AND ');
  const sales=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS totalMinor,COALESCE(SUM(tax_minor),0) AS taxMinor FROM sales WHERE ${salesFilter}`).get(...params);
  const salesReturns=db.prepare(`SELECT COALESCE(SUM(total_minor),0) AS totalMinor,COALESCE(SUM(tax_minor),0) AS taxMinor FROM sales_returns WHERE ${returnsFilter}`).get(...params);
  const purchases=db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS totalMinor FROM purchases WHERE ${filter}`).get(...params);
  const purchaseReturns=db.prepare(`SELECT COALESCE(SUM(total_minor),0) AS totalMinor FROM purchase_returns WHERE ${returnsFilter}`).get(...params);
  const expenseWhere=[],expenseParams=[];
  if(from){expenseWhere.push('occurred_at>=?');expenseParams.push(from+'T00:00:00');}
  if(to){expenseWhere.push('occurred_at<?');expenseParams.push(nextDate(to)+'T00:00:00');}
  const expenses=db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS totalMinor FROM expenses ${expenseWhere.length?'WHERE '+expenseWhere.join(' AND '):''}`).get(...expenseParams);
  const salesAliasFilter=salesFilter.split(' AND ').map(x=>'s.'+x).join(' AND ');
  const returnAliasFilter=returnsFilter.split(' AND ').filter(x=>x!=='1=1').map(x=>'sr.'+x).join(' AND ')||'1=1';
  const profit=db.prepare(`SELECT COALESCE(SUM(sl.line_total_minor-sl.tax_minor-sl.cost_total_minor),0)
    - COALESCE((SELECT SUM(srl.amount_minor-srl.tax_minor-srl.cost_minor) FROM sales_return_lines srl
      JOIN sales_returns sr ON sr.id=srl.return_id WHERE ${returnAliasFilter}),0) AS grossProfitMinor
    FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE ${salesAliasFilter}`).get(...params,...params);
  const topProducts=db.prepare(`SELECT itemId,name,SUM(quantity)-SUM(returnQuantity) AS quantity,
      SUM(netMinor)-SUM(returnNetMinor) AS totalMinor FROM (
      SELECT sl.item_id AS itemId,sl.description AS name,sl.quantity AS quantity,0 AS returnQuantity,
        sl.line_total_minor-sl.tax_minor AS netMinor,0 AS returnNetMinor
      FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE ${salesAliasFilter}
      UNION ALL
      SELECT sl.item_id AS itemId,sl.description AS name,0 AS quantity,srl.quantity AS returnQuantity,
        0 AS netMinor,srl.amount_minor-srl.tax_minor AS returnNetMinor
      FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.return_id
      JOIN sale_lines sl ON sl.id=srl.sale_line_id WHERE ${returnAliasFilter}
    ) activity GROUP BY itemId,name ORDER BY totalMinor DESC LIMIT 5`).all(...params,...params);
  const lowStock=db.prepare(`SELECT p.id,p.name,COALESCE(SUM(sm.quantity_delta),0) AS quantity,p.min_stock AS minStock
    FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id
    WHERE p.is_active=1 AND p.track_stock=1 GROUP BY p.id
    HAVING quantity<=p.min_stock ORDER BY quantity ASC,p.name LIMIT 20`).all();
  const salesTotalMinor=sales.totalMinor-salesReturns.totalMinor;
  const expensesTotalMinor=expenses.totalMinor;
  const grossProfitMinor=profit.grossProfitMinor;
  return {from,to,salesCount:sales.count,salesTotalMinor,salesTaxMinor:sales.taxMinor-salesReturns.taxMinor,
    purchasesCount:purchases.count,purchasesTotalMinor:purchases.totalMinor-purchaseReturns.totalMinor,
    grossProfitMinor,expensesTotalMinor,netProfitMinor:grossProfitMinor-expensesTotalMinor,topProducts,lowStock};
}

const REPORTS = {
  'sales-returns': `SELECT sr.return_number AS returnNumber,s.receipt_number AS sourceReference,sr.occurred_at AS occurredAt,
    COALESCE(c.name,'عميل نقدي') AS party,sr.total_minor AS totalMinor,sr.tax_minor AS taxMinor,
    sr.refund_minor AS refundMinor,sr.reason
    FROM sales_returns sr JOIN sales s ON s.id=sr.sale_id LEFT JOIN customers c ON c.id=s.customer_id
    WHERE {{where}} ORDER BY sr.occurred_at DESC`,
  'purchase-returns': `SELECT pr.return_number AS returnNumber,p.invoice_number AS sourceReference,pr.occurred_at AS occurredAt,
    COALESCE(s.name,'بدون مورد') AS party,pr.total_minor AS totalMinor,pr.tax_minor AS taxMinor,
    pr.refund_minor AS refundMinor,pr.reason
    FROM purchase_returns pr JOIN purchases p ON p.id=pr.purchase_id LEFT JOIN suppliers s ON s.id=p.supplier_id
    WHERE {{where}} ORDER BY pr.occurred_at DESC`,
  'expenses': `SELECT e.category,e.occurred_at AS occurredAt,e.amount_minor AS amountMinor,e.payment_method AS paymentMethod,e.provider,e.reference,e.note,u.display_name AS createdBy FROM expenses e LEFT JOIN users u ON u.id=e.created_by WHERE {{where}} ORDER BY e.occurred_at DESC`,
  'sales-daily': `SELECT day,SUM(invoices) AS invoices,SUM(returns) AS returns,
    SUM(totalMinor) AS totalMinor,SUM(taxMinor) AS taxMinor
    FROM (
      SELECT date(s.occurred_at) AS day,COUNT(*) AS invoices,0 AS returns,
        SUM(s.total_minor) AS totalMinor,SUM(s.tax_minor) AS taxMinor
      FROM sales s WHERE s.status IN ('posted','partially_returned','returned') AND {{salesWhere}}
      GROUP BY date(s.occurred_at)
      UNION ALL
      SELECT date(sr.occurred_at) AS day,0 AS invoices,COUNT(*) AS returns,
        -SUM(sr.total_minor) AS totalMinor,-SUM(sr.tax_minor) AS taxMinor
      FROM sales_returns sr WHERE {{returnWhere}} GROUP BY date(sr.occurred_at)
    ) daily GROUP BY day ORDER BY day DESC`,
    'sales-invoices': `SELECT s.receipt_number AS reference,s.occurred_at AS occurredAt,COALESCE(c.name,'عميل نقدي') AS party,
    s.status,s.subtotal_minor AS subtotalMinor,s.tax_minor AS taxMinor,s.total_minor AS totalMinor,
    COALESCE((SELECT SUM(CASE WHEN p.direction='in' THEN p.amount_minor ELSE -p.amount_minor END) FROM payments p WHERE p.sale_id=s.id),0) AS paidMinor,
    COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0) AS returnedMinor,
    s.total_minor-COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0)-COALESCE((SELECT SUM(CASE WHEN p.direction='in' THEN p.amount_minor ELSE -p.amount_minor END) FROM payments p WHERE p.sale_id=s.id),0) AS dueMinor
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='void' AND {{where}} ORDER BY s.occurred_at DESC`,
    'sales-products': `SELECT itemId,name,SUM(quantity) AS quantity,SUM(netSalesMinor) AS netSalesMinor,
      SUM(taxMinor) AS taxMinor,SUM(costMinor) AS costMinor,SUM(profitMinor) AS profitMinor FROM (
      SELECT sl.item_id AS itemId,sl.description AS name,sl.quantity AS quantity,
        sl.line_total_minor-sl.tax_minor AS netSalesMinor,sl.tax_minor AS taxMinor,
        sl.cost_total_minor AS costMinor,sl.line_total_minor-sl.tax_minor-sl.cost_total_minor AS profitMinor
      FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE s.status!='void' AND {{salesWhere}}
      UNION ALL
      SELECT sl.item_id AS itemId,sl.description AS name,-srl.quantity AS quantity,
        -(srl.amount_minor-srl.tax_minor) AS netSalesMinor,-srl.tax_minor AS taxMinor,
        -srl.cost_minor AS costMinor,-(srl.amount_minor-srl.tax_minor-srl.cost_minor) AS profitMinor
      FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.return_id
      JOIN sale_lines sl ON sl.id=srl.sale_line_id WHERE {{returnWhere}}
    ) activity GROUP BY itemId,name ORDER BY netSalesMinor DESC`,
    'sales-categories': `SELECT category,SUM(quantity) AS quantity,SUM(netSalesMinor) AS netSalesMinor,SUM(taxMinor) AS taxMinor FROM (
      SELECT COALESCE(c.name,'بدون تصنيف') AS category,sl.quantity AS quantity,
        sl.line_total_minor-sl.tax_minor AS netSalesMinor,sl.tax_minor AS taxMinor
      FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
      LEFT JOIN products p ON sl.line_type='product' AND p.id=sl.item_id LEFT JOIN categories c ON c.id=p.category_id
      WHERE s.status!='void' AND {{salesWhere}}
      UNION ALL
      SELECT COALESCE(c.name,'بدون تصنيف') AS category,-srl.quantity AS quantity,
        -(srl.amount_minor-srl.tax_minor) AS netSalesMinor,-srl.tax_minor AS taxMinor
      FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.return_id
      JOIN sale_lines sl ON sl.id=srl.sale_line_id LEFT JOIN products p ON sl.line_type='product' AND p.id=sl.item_id
      LEFT JOIN categories c ON c.id=p.category_id WHERE {{returnWhere}}
    ) activity GROUP BY category ORDER BY netSalesMinor DESC`,
    'sales-customers': `SELECT COALESCE(c.name,'عميل نقدي') AS customer,COUNT(DISTINCT s.id) AS invoices,
    SUM(s.total_minor-COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0)) AS totalMinor,
    SUM(s.total_minor-COALESCE((SELECT SUM(sr.total_minor) FROM sales_returns sr WHERE sr.sale_id=s.id),0)-COALESCE((SELECT SUM(CASE WHEN p.direction='in' THEN p.amount_minor ELSE -p.amount_minor END) FROM payments p WHERE p.sale_id=s.id),0)) AS dueMinor
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='void' AND {{where}} GROUP BY c.id,c.name ORDER BY totalMinor DESC`,
    'sales-payments': `SELECT p.method,p.provider,p.direction,COUNT(*) AS operations,SUM(p.amount_minor) AS totalMinor
    FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.status!='void' AND {{where}} GROUP BY p.method,p.provider,p.direction ORDER BY totalMinor DESC`,
  'purchase-invoices': `SELECT p.invoice_number AS reference,p.occurred_at AS occurredAt,COALESCE(s.name,'بدون مورد') AS party,
    p.status,p.subtotal_minor AS subtotalMinor,p.tax_minor AS taxMinor,p.total_minor AS totalMinor,
    COALESCE((SELECT SUM(CASE WHEN pp.direction='out' THEN pp.amount_minor ELSE -pp.amount_minor END) FROM purchase_payments pp WHERE pp.purchase_id=p.id),0) AS paidMinor,
    COALESCE((SELECT SUM(pr.total_minor) FROM purchase_returns pr WHERE pr.purchase_id=p.id),0) AS returnedMinor,
    p.total_minor-COALESCE((SELECT SUM(pr.total_minor) FROM purchase_returns pr WHERE pr.purchase_id=p.id),0)-COALESCE((SELECT SUM(CASE WHEN pp.direction='out' THEN pp.amount_minor ELSE -pp.amount_minor END) FROM purchase_payments pp WHERE pp.purchase_id=p.id),0) AS dueMinor
    FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.status!='void' AND {{where}} ORDER BY p.occurred_at DESC`,
    'purchase-products': `SELECT productId,name,SUM(quantity) AS quantity,SUM(netCostMinor) AS netCostMinor,SUM(taxMinor) AS taxMinor FROM (
      SELECT pr.id AS productId,pr.name,pl.quantity AS quantity,pl.line_total_minor AS netCostMinor,pl.tax_minor AS taxMinor
      FROM purchase_lines pl JOIN purchases pu ON pu.id=pl.purchase_id JOIN products pr ON pr.id=pl.product_id
      WHERE pu.status!='void' AND {{salesWhere}}
      UNION ALL
      SELECT pr.id AS productId,pr.name,-prl.quantity AS quantity,-(prl.amount_minor-prl.tax_minor) AS netCostMinor,-prl.tax_minor AS taxMinor
      FROM purchase_return_lines prl JOIN purchase_returns rr ON rr.id=prl.return_id
      JOIN purchase_lines pl ON pl.id=prl.purchase_line_id JOIN products pr ON pr.id=pl.product_id
      WHERE {{returnWhere}}
    ) activity GROUP BY productId,name ORDER BY netCostMinor DESC`,
    'purchase-categories': `SELECT category,SUM(quantity) AS quantity,SUM(netCostMinor) AS netCostMinor,SUM(taxMinor) AS taxMinor FROM (
      SELECT COALESCE(c.name,'بدون تصنيف') AS category,pl.quantity AS quantity,pl.line_total_minor AS netCostMinor,pl.tax_minor AS taxMinor
      FROM purchase_lines pl JOIN purchases pu ON pu.id=pl.purchase_id JOIN products pr ON pr.id=pl.product_id
      LEFT JOIN categories c ON c.id=pr.category_id WHERE pu.status!='void' AND {{salesWhere}}
      UNION ALL
      SELECT COALESCE(c.name,'بدون تصنيف') AS category,-prl.quantity AS quantity,-(prl.amount_minor-prl.tax_minor) AS netCostMinor,-prl.tax_minor AS taxMinor
      FROM purchase_return_lines prl JOIN purchase_returns rr ON rr.id=prl.return_id
      JOIN purchase_lines pl ON pl.id=prl.purchase_line_id JOIN products pr ON pr.id=pl.product_id
      LEFT JOIN categories c ON c.id=pr.category_id WHERE {{returnWhere}}
    ) activity GROUP BY category ORDER BY netCostMinor DESC`,
    'purchase-payments': `SELECT pp.method,pp.provider,pp.direction,COUNT(*) AS operations,SUM(pp.amount_minor) AS totalMinor
    FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id WHERE pu.status!='void' AND {{where}} GROUP BY pp.method,pp.provider,pp.direction ORDER BY totalMinor DESC`,
  'stock-on-hand': `SELECT p.id AS productId,p.name,p.sku,p.barcode,u.symbol AS unit,
    COALESCE(SUM(sm.quantity_delta),0) AS quantity,p.min_stock AS minStock,
    COALESCE(SUM(CASE WHEN sm.quantity_delta>0 THEN sm.cost_total_minor ELSE -sm.cost_total_minor END),0) AS stockValueMinor
    FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id AND sm.branch_id=? LEFT JOIN units u ON u.id=p.base_unit_id
    WHERE p.is_active=1 AND p.track_stock=1 GROUP BY p.id ORDER BY p.name`,
  'stock-movements': `SELECT sm.occurred_at AS occurredAt,p.name AS product,sm.source_type AS source,
    sm.source_id AS reference,sm.quantity_delta AS quantityDelta,sm.unit_cost_minor AS unitCostMinor,sm.cost_total_minor AS costTotalMinor
    FROM stock_movements sm JOIN products p ON p.id=sm.product_id WHERE {{where}} ORDER BY sm.occurred_at DESC`,
  'tax-summary': `SELECT currency,SUM(taxMinor) AS collectedTaxMinor,SUM(invoices) AS invoices,SUM(returns) AS returns
    FROM (
      SELECT s.currency_code AS currency,SUM(s.tax_minor) AS taxMinor,COUNT(*) AS invoices,0 AS returns
      FROM sales s WHERE s.status!='void' AND {{salesWhere}} GROUP BY s.currency_code
      UNION ALL
      SELECT s.currency_code AS currency,-SUM(sr.tax_minor) AS taxMinor,0 AS invoices,COUNT(*) AS returns
      FROM sales_returns sr JOIN sales s ON s.id=sr.sale_id WHERE {{returnWhere}} GROUP BY s.currency_code
    ) taxActivity GROUP BY currency`,
  'cash-movements': `SELECT occurredAt,source,reference,method,provider,direction,amountMinor FROM (
    SELECT p.occurred_at AS occurredAt,CASE WHEN p.direction='out' THEN 'مرتجع بيع' ELSE 'بيع' END AS source,s.receipt_number AS reference,p.method,p.provider,p.direction,p.amount_minor AS amountMinor
    FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.status!='void'
    UNION ALL
    SELECT pp.occurred_at AS occurredAt,CASE WHEN pp.direction='in' THEN 'مرتجع شراء' ELSE 'شراء' END AS source,pu.invoice_number AS reference,pp.method,pp.provider,CASE WHEN pp.direction='in' THEN 'in' ELSE 'out' END AS direction,pp.amount_minor AS amountMinor
    FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id WHERE pu.status!='void'
    UNION ALL
    SELECT e.occurred_at AS occurredAt,'مصروف' AS source,e.category AS reference,e.payment_method AS method,e.provider,'out' AS direction,e.amount_minor AS amountMinor
    FROM expenses e
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
    'sales-returns':'sr','purchase-returns':'pr','sales-daily':'s','sales-invoices':'s','sales-products':'s','sales-categories':'s','sales-customers':'s','sales-payments':'p',
    'purchase-invoices':'p','purchase-products':'pu','purchase-categories':'pu','purchase-payments':'pp',
    'stock-movements':'sm','tax-summary':'s','cash-movements':'x','expenses':'e'
  };
  const alias=aliasByType[type];
  let rows;
  if(type==='stock-on-hand') {
    rows=db.prepare(template).all(branchId||null);
  } else if(type==='cash-movements') {
    const filter={sql:(from?'x.occurredAt>=? AND ':'')+(to?'x.occurredAt<?':'1=1'),params:[...(from?[from+'T00:00:00']:[]),...(to?[nextDate(to)+'T00:00:00']:[])]};
    rows=db.prepare(template.replace('{{where}}',filter.sql)).all(...filter.params);
  } else if(type==='sales-daily'||type==='tax-summary') {
    const salesFilter=buildDateFilter('s',from,to),returnFilter=buildDateFilter('sr',from,to);
    rows=db.prepare(template.replace('{{salesWhere}}',salesFilter.sql).replace('{{returnWhere}}',returnFilter.sql))
      .all(...salesFilter.params,...returnFilter.params);
  } else if(['sales-products','sales-categories','purchase-products','purchase-categories'].includes(type)) {
    const returnAlias=type.startsWith('sales-')?'sr':'rr';
    const saleAlias=type.startsWith('sales-')?'s':'pu';
    const returnFilter=buildDateFilter(returnAlias,from,to),saleFilter=buildDateFilter(saleAlias,from,to);
    rows=db.prepare(template.replace('{{salesWhere}}',saleFilter.sql).replace('{{returnWhere}}',returnFilter.sql))
      .all(...saleFilter.params,...returnFilter.params);
  } else {
    const filter=buildDateFilter(alias,from,to);
    rows=db.prepare(template.replaceAll('{{where}}',filter.sql)).all(...filter.params);
  }
  const totalMinor=rows.reduce((sum,row)=>sum+Number(row.totalMinor??row.netSalesMinor??row.netCostMinor??row.amountMinor??row.collectedTaxMinor??0),0);
  return {type,from,to,count:rows.length,totalMinor,rows};
}

export const availableReports = Object.keys(REPORTS);
