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
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  db.exec(schema);
  const now = new Date().toISOString();
  const insertUnit = db.prepare('INSERT OR IGNORE INTO units (id,name,symbol,precision) VALUES (?,?,?,?)');
  insertUnit.run('unit-piece', 'Piece', 'pc', 0);
  insertUnit.run('unit-box', 'Box', 'box', 0);
  insertUnit.run('unit-kg', 'Kilogram', 'kg', 3);
  insertUnit.run('unit-liter', 'Liter', 'L', 3);
  const insertAccount = db.prepare(
    'INSERT OR IGNORE INTO accounts (id,code,name,account_type,normal_side) VALUES (?,?,?,?,?)'
  );
  const accounts = [
    ['acc-cash','1000','Cash','asset','debit'],
    ['acc-bank','1010','Bank','asset','debit'],
    ['acc-ar','1100','Accounts Receivable','asset','debit'],
    ['acc-inventory','1200','Inventory','asset','debit'],
    ['acc-ap','2000','Accounts Payable','liability','credit'],
    ['acc-tax','2100','Tax Payable','liability','credit'],
    ['acc-capital','3000','Owner Equity','equity','credit'],
    ['acc-sales','4000','Sales Revenue','revenue','credit'],
    ['acc-sales-returns','4010','Sales Returns','revenue','debit'],
    ['acc-cogs','5000','Cost of Goods Sold','expense','debit'],
    ['acc-expenses','6000','Operating Expenses','expense','debit']
  ];
  const insertMany = db.transaction(() => accounts.forEach(row => insertAccount.run(...row)));
  insertMany();
  return { path: DB_PATH, initializedAt: now };
}

export function inTransaction(work) {
  return db.transaction(work).immediate();
}
