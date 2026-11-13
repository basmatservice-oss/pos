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
    ['acc-expenses','6000','Operating Expenses','expense','debit'],['acc-purchase-variance','5010','Purchase Cost Rounding Variance','expense','debit']
  ];
  const seed = db.transaction(() => {
    accounts.forEach(row => insertAccount.run(...row));
    const setting=db.prepare('INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES(?,?,?)');
    const now=new Date().toISOString();
    setting.run('inventory.cost_method','weighted',now);
    setting.run('tax.price_mode','exclusive',now);
    setting.run('currency.code','SDG',now);
  });
  seed();
  const columns = db.prepare("PRAGMA table_info(purchases)").all().map(column => column.name);
  if (!columns.includes('tax_minor')) db.exec("ALTER TABLE purchases ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0 CHECK(tax_minor>=0)");
  if (!columns.includes('tax_treatment')) db.exec("ALTER TABLE purchases ADD COLUMN tax_treatment TEXT NOT NULL DEFAULT 'disabled' CHECK(tax_treatment IN ('recoverable','non_recoverable','disabled'))");
  return { path: DB_PATH, initializedAt: new Date().toISOString() };
}
export function inTransaction(work) { return db.transaction(work).immediate(); }

export function getDefaultBranchId() {
  const row=db.prepare('SELECT id FROM branches WHERE is_active=1 ORDER BY code LIMIT 1').get();
  if(!row) throw new Error('No active branch is configured.');
  return row.id;
}
