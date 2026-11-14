import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DAVINCIPOS_DB || path.join(ROOT, 'DavinciPos.sqlite');
export const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

export function initializeDatabase() {
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const insertBranch = db.prepare('INSERT OR IGNORE INTO branches(id,name,code,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)');
  const nowBranch=new Date().toISOString();
  insertBranch.run('branch-main','Main Branch','MAIN',nowBranch,nowBranch);
  const insertUnit = db.prepare('INSERT OR IGNORE INTO units (id,name,symbol,precision) VALUES (?,?,?,?)');
  for (const unit of [['unit-piece','Piece','pc',0],['unit-box','Box','box',0],['unit-kg','Kilogram','kg',3],['unit-liter','Liter','L',3]]) insertUnit.run(...unit);
  const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (id,code,name,account_type,normal_side) VALUES (?,?,?,?,?)');
  const accounts = [
    ['acc-cash','1000','Cash','asset','debit'],['acc-card','1020','Card Clearing','asset','debit'],
    ['acc-bank','1010','Bank','asset','debit'],['acc-wallet','1030','Wallet Clearing','asset','debit'],['acc-other-clearing','1040','Other Payment Clearing','asset','debit'],
    ['acc-ar','1100','Accounts Receivable','asset','debit'],['acc-inventory','1200','Inventory','asset','debit'],
    ['acc-ap','2000','Accounts Payable','liability','credit'],['acc-tax','2100','Tax Payable','liability','credit'],
    ['acc-capital','3000','Owner Equity','equity','credit'],['acc-tax-input','2110','Recoverable Input Tax','asset','debit'],['acc-sales','4000','Sales Revenue','revenue','credit'],
    ['acc-sales-returns','4010','Sales Returns','revenue','debit'],['acc-cogs','5000','Cost of Goods Sold','expense','debit'],
    ['acc-expenses','6000','Operating Expenses','expense','debit'],['acc-purchase-variance','5010','Purchase Cost Rounding Variance','expense','debit'],['acc-stock-adjustment-gain','4090','Inventory Adjustment Gain','revenue','credit'],['acc-stock-adjustment-loss','6010','Inventory Adjustment Loss','expense','debit']
  ];
  const seed = db.transaction(() => {
    accounts.forEach(row => insertAccount.run(...row));
    const setting=db.prepare('INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES(?,?,?)');
    const now=new Date().toISOString();
    setting.run('inventory.cost_method','weighted',now);
    setting.run('tax.enabled','true',now);
    setting.run('tax.purchase_mode','recoverable',now);
    setting.run('sync.offline_sales','true',now);
    setting.run('sync.stock_conflict_policy','hold_for_review',now);
    setting.run('tax.price_mode','exclusive',now);
    setting.run('currency.code','SDG',now);
  });
  seed();
  const productColumns = db.prepare('PRAGMA table_info(products)').all().map(column => column.name);
  if (!productColumns.includes('tax_exempt')) db.exec('ALTER TABLE products ADD COLUMN tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1))');
  const serviceColumns = db.prepare('PRAGMA table_info(services)').all().map(column => column.name);
  if (!serviceColumns.includes('tax_exempt')) db.exec('ALTER TABLE services ADD COLUMN tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1))');
  const salesColumns = db.prepare("PRAGMA table_info(sales)").all().map(column => column.name);
  if (!salesColumns.includes('tax_enabled')) db.exec('ALTER TABLE sales ADD COLUMN tax_enabled INTEGER NOT NULL DEFAULT 1 CHECK(tax_enabled IN (0,1))');
  if (!salesColumns.includes('tax_price_mode')) db.exec("ALTER TABLE sales ADD COLUMN tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))");
  const saleLineColumns = db.prepare("PRAGMA table_info(sale_lines)").all().map(column => column.name);
  if (!saleLineColumns.includes('tax_rate_bps')) db.exec('ALTER TABLE sale_lines ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000)');
  if (!saleLineColumns.includes('tax_profile_id')) db.exec('ALTER TABLE sale_lines ADD COLUMN tax_profile_id TEXT');
  if (!saleLineColumns.includes('tax_price_mode')) db.exec("ALTER TABLE sale_lines ADD COLUMN tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))");
  const columns = db.prepare("PRAGMA table_info(purchases)").all().map(column => column.name);
  if (!columns.includes('tax_minor')) db.exec("ALTER TABLE purchases ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0)");
  if (!columns.includes('tax_treatment')) db.exec("ALTER TABLE purchases ADD COLUMN tax_treatment TEXT NOT NULL DEFAULT 'disabled' CHECK(tax_treatment IN ('recoverable','non_recoverable','disabled'))");
  if (!columns.includes('tax_price_mode')) db.exec("ALTER TABLE purchases ADD COLUMN tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))");
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all().map(column => column.name);
  if (!deviceColumns.includes('owner_user_id')) db.exec('ALTER TABLE devices ADD COLUMN owner_user_id TEXT');
  if (!deviceColumns.includes('is_active')) db.exec('ALTER TABLE devices ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  const paymentColumns = db.prepare("PRAGMA table_info(payments)").all().map(column => column.name);
  if (!paymentColumns.includes('provider')) db.exec('ALTER TABLE payments ADD COLUMN provider TEXT');
  const purchasePaymentColumns = db.prepare("PRAGMA table_info(purchase_payments)").all().map(column => column.name);
  if (!purchasePaymentColumns.includes('provider')) db.exec('ALTER TABLE purchase_payments ADD COLUMN provider TEXT');
  if (!purchasePaymentColumns.includes('direction')) db.exec("ALTER TABLE purchase_payments ADD COLUMN direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out','in'))");
  const purchaseLineColumns = db.prepare("PRAGMA table_info(purchase_lines)").all().map(column => column.name);
  if (!purchaseLineColumns.includes('tax_minor')) db.exec('ALTER TABLE purchase_lines ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0)');
  if (!purchaseLineColumns.includes('tax_rate_bps')) db.exec('ALTER TABLE purchase_lines ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000)');
  if (!purchaseLineColumns.includes('tax_profile_id')) db.exec('ALTER TABLE purchase_lines ADD COLUMN tax_profile_id TEXT');
  if (!purchaseLineColumns.includes('tax_price_mode')) db.exec("ALTER TABLE purchase_lines ADD COLUMN tax_price_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_price_mode IN ('inclusive','exclusive'))");

  const productColumnsAfter = db.prepare('PRAGMA table_info(products)').all().map(column => column.name);
  if (!productColumnsAfter.includes('price_currency')) db.exec("ALTER TABLE products ADD COLUMN price_currency TEXT NOT NULL DEFAULT 'SDG' CHECK(price_currency IN ('SDG','USD'))");
  if (!productColumnsAfter.includes('foreign_cost_minor')) db.exec('ALTER TABLE products ADD COLUMN foreign_cost_minor INTEGER');
  if (!productColumnsAfter.includes('foreign_sale_price_minor')) db.exec('ALTER TABLE products ADD COLUMN foreign_sale_price_minor INTEGER');
  if (!productColumnsAfter.includes('auto_rate_update')) db.exec('ALTER TABLE products ADD COLUMN auto_rate_update INTEGER NOT NULL DEFAULT 0 CHECK(auto_rate_update IN (0,1))');
  db.exec(`CREATE TABLE IF NOT EXISTS exchange_rates (
    id TEXT PRIMARY KEY,from_currency TEXT NOT NULL,to_currency TEXT NOT NULL,rate REAL NOT NULL CHECK(rate>0),
    effective_at TEXT NOT NULL,created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date ON exchange_rates(from_currency,to_currency,effective_at DESC);`);
  return { path: DB_PATH, initializedAt: new Date().toISOString() };
}
export function inTransaction(work) { return db.transaction(work).immediate(); }

export function getDefaultBranchId() {
  const row=db.prepare('SELECT id FROM branches WHERE is_active=1 ORDER BY code LIMIT 1').get();
  if(!row) throw new Error('No active branch is configured.');
  return row.id;
}
