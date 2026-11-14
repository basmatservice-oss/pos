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
    purchasesCount:purchases.count,purchasesTotalMinor:purchases.totalMinor,grossProfitMinor:profit.grossProfitMinor,
    topProducts,lowStock};
}
