import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-clean-install-'));
const legacyPath=path.join(dir,'legacy-pos.sqlite');
const freshPath=path.join(dir,'DavinciPos.sqlite');
const legacy=new Database(legacyPath);
legacy.exec('CREATE TABLE legacy_customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO legacy_customers(name) VALUES (\'Disposable test customer\');');
legacy.close();

process.env.DAVINCIPOS_DB=freshPath;
const {db,initializeDatabase}=await import('./database.js');

test('fresh DavinciPos database starts clean and never imports legacy test records',()=>{
  initializeDatabase();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM suppliers').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM products').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchases').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_idempotency').get().count,0);
  assert.ok(db.prepare("SELECT name FROM branches WHERE id='branch-main'").get());
  assert.ok(db.prepare("SELECT name FROM accounts WHERE id='acc-cash'").get());
  const legacyCheck=new Database(legacyPath,{readonly:true});
  assert.equal(legacyCheck.prepare('SELECT COUNT(*) AS count FROM legacy_customers').get().count,1);
  legacyCheck.close();
});

test('closes clean-install databases',()=>{
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
