import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase, db } from './database.js';
import { checkoutSale } from './sales.js';\nimport { receivePurchase } from './purchases.js';\nimport { getTrialBalance } from './accounting.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

initializeDatabase();

app.get('/api/health', (_req,res) => res.json({ status: 'ok', database: 'sqlite', version: 1 }));
app.get('/api/products', (_req,res) => {
  const rows = db.prepare(`SELECT p.*, c.name AS category_name,
    COALESCE((SELECT SUM(sm.quantity_delta) FROM stock_movements sm WHERE sm.product_id=p.id),0) AS stock_on_hand
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.is_active=1 ORDER BY p.name`).all();
  res.json({ data: rows });
});
app.post('/api/sales/checkout', (req,res) => {
  try {
    const result = checkoutSale(req.body);
    res.status(201).json({ data: result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to complete sale.' });
  }
});
app.post('/api/purchases/receive', (req,res) => {\n  try { const result=receivePurchase(req.body); res.status(201).json({data:result}); }\n  catch(error) { res.status(400).json({error:error.message||'Unable to receive purchase.'}); }\n});\napp.get('/api/accounting/trial-balance', (req,res) => {\n  try { res.json({data:getTrialBalance({from:req.query.from||null,to:req.query.to||null})}); }\n  catch(error) { res.status(400).json({error:error.message||'Unable to build trial balance.'}); }\n});\napp.get('/api/summary', (_req,res) => {
  const products = db.prepare('SELECT COUNT(*) AS count FROM products WHERE is_active=1').get().count;
  const sales = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_minor),0) AS total FROM sales WHERE status='posted'").get();
  res.json({ data: { products, salesCount: sales.count, salesTotalMinor: sales.total } });
});

app.get('/desktop', (_req,res) => res.sendFile(path.join(ROOT,'desktop.html')));
app.get('/mobile', (_req,res) => res.sendFile(path.join(ROOT,'mobile.html')));
const publicAssets = new Set(['desktop.css','desktop.js','mobile.css','mobile.js']);\napp.get('/assets/:asset', (req,res) => {\n  if(!publicAssets.has(req.params.asset)) return res.sendStatus(404);\n  res.sendFile(path.join(ROOT,req.params.asset));\n});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`DavinciPos listening on http://localhost:${port}`);
});
