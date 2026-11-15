import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-sync-migration-'));
const dbPath=path.join(dir,'existing.sqlite');
const existing=new Database(dbPath);
existing.exec(`
  CREATE TABLE sync_receipts (
    operation_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
    response TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE sync_conflicts (
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL,
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT
  );
  INSERT INTO sync_receipts(operation_id,device_id,response,created_at)
    VALUES('old-operation','device-old','{"status":"accepted"}','2026-11-01T00:00:00.000Z');
`);
existing.close();

process.env.DAVINCIPOS_DB=dbPath;
const {db,initializeDatabase}=await import('./database.js');

test('existing DavinciPos sync tables migrate without losing receipts',()=>{
  initializeDatabase();
  const receiptColumns=db.prepare('PRAGMA table_info(sync_receipts)').all().map(row=>row.name);
  const conflictColumns=db.prepare('PRAGMA table_info(sync_conflicts)').all().map(row=>row.name);
  assert.ok(receiptColumns.includes('payload_hash'));
  assert.ok(conflictColumns.includes('payload_hash'));
  assert.deepEqual(db.prepare('SELECT operation_id,device_id,response FROM sync_receipts').get(),
    {operation_id:'old-operation',device_id:'device-old',response:'{"status":"accepted"}'});
});

test('closes sync migration database',()=>{
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
