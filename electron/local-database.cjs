const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let database = null;
const VALID_ENTITIES = new Set(['products','categories','orders','orderItems','returns','returnItems','accounts','shifts','shiftMovements','customers','customerPayments','expenses','suppliers','supplierPayments','employees','settings','purchases','purchaseItems','purchaseReturns','purchaseReturnItems','attendance','loyaltyTransactions','branches','payroll','offers','auditLogs','journalEntries','transactions','stocktakingSessions','stocktakingEntries','inventoryBatches','inventoryAlerts','heldOrders','serviceRecipes','exchangeRateHistory','fiscalPeriods','unitDefinitions','productUnits','inventoryMovements']);
const MAX_RECORD_BYTES = 5 * 1024 * 1024;

function initializeLocalDatabase(userDataPath) {
  if (database) return { ready: true, database: 'pos-local.db', schemaVersion: 1 };
  if (typeof userDataPath !== 'string' || !userDataPath.trim()) {
    throw new Error('A valid Electron user-data directory is required');
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  const filename = path.join(userDataPath, 'pos-local.db');
  const candidate = new Database(filename);
  try {
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('synchronous = FULL');
    candidate.pragma('busy_timeout = 5000');
    candidate.exec(`
      CREATE TABLE IF NOT EXISTS pos_records (
        entity TEXT NOT NULL,
        record_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY(entity, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pos_records_entity_updated
        ON pos_records(entity, updated_at);
      CREATE TABLE IF NOT EXISTS pos_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pos_outbox (
        operation_id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_retry_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pos_outbox_status_created
        ON pos_outbox(status, created_at);
    `);
    candidate.prepare(\"UPDATE pos_outbox SET status='pending' WHERE status='syncing'\").run();
    database = candidate;
    return { ready: true, database: 'pos-local.db', schemaVersion: 1 };
  } catch (error) {
    candidate.close();
    throw error;
  }
}

function db() {
  if (!database || !database.open) throw new Error('Electron local SQLite database is not initialized');
  return database;
}

function validateIdentity(entity, recordId) {
  if (typeof entity !== 'string' || !VALID_ENTITIES.has(entity) ||
      typeof recordId !== 'string' || !recordId.trim() || recordId.length > 512) {
    throw new Error('A non-empty entity and recordId are required');
  }
}

function getRecords(entity) {
  if (typeof entity !== 'string' || !VALID_ENTITIES.has(entity)) throw new Error('Unsupported entity');
  return db().prepare('SELECT record_id AS recordId, json, sync_state AS syncState, updated_at AS updatedAt FROM pos_records WHERE entity = ? ORDER BY updated_at, record_id')
    .all(entity).map(row => ({ recordId: row.recordId, record: JSON.parse(row.json), syncState: row.syncState, updatedAt: row.updatedAt }));
}

function getRecord(entity, recordId) {
  validateIdentity(entity, recordId);
  const row = db().prepare('SELECT record_id AS recordId, json, sync_state AS syncState, updated_at AS updatedAt FROM pos_records WHERE entity = ? AND record_id = ?')
    .get(entity, recordId);
  return row ? { found: true, item: { recordId: row.recordId, record: JSON.parse(row.json), syncState: row.syncState, updatedAt: row.updatedAt } } : { found: false, item: null };
}

function putRecords(records) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const seen = new Set();
  const parsed = records.map(item => {
    validateIdentity(item?.entity, item?.recordId);
    if (!item.record || typeof item.record !== 'object' || Array.isArray(item.record)) throw new Error('record must be an object');
    const syncState = item.syncState || 'local';
    if (!['local', 'pending', 'synced', 'error'].includes(syncState)) throw new Error('Invalid sync state');
    const identity = JSON.stringify([item.entity, item.recordId]);
    if (seen.has(identity)) throw new Error('Duplicate record in batch');
    seen.add(identity);
    const json = JSON.stringify(item.record);
    if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) throw new Error('Record exceeds the local SQLite size limit');
    return { ...item, syncState, json };
  });
  const insert = db().prepare(`INSERT INTO pos_records(entity, record_id, json, updated_at, sync_state)
    VALUES(@entity, @recordId, @json, @updatedAt, @syncState)
    ON CONFLICT(entity, record_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at, sync_state=excluded.sync_state`);
  const apply = db().transaction(rows => {
    const now = Date.now();
    for (const row of rows) insert.run({ ...row, updatedAt: now });
    return rows.length;
  });
  return { saved: true, count: apply(parsed) };
}

function applyRecordChanges(changes, guards = {}) {
  if (!Array.isArray(changes) || changes.length > 10000) throw new Error('changes must be an array within the transaction limit');
  if (!guards || typeof guards !== 'object' || Array.isArray(guards)) throw new Error('Invalid transaction guards');
  if (guards.ifAbsentEntity && !VALID_ENTITIES.has(guards.ifAbsentEntity)) throw new Error('Unsupported idempotency entity');
  if (guards.ifAbsentRecordId && (typeof guards.ifAbsentRecordId !== 'string' || guards.ifAbsentRecordId.length > 512)) throw new Error('Invalid idempotency record ID');
  if (guards.ifAbsentField && (typeof guards.ifAbsentField !== 'string' || !guards.ifAbsentField.trim() || typeof guards.ifAbsentValue !== 'string')) throw new Error('Invalid field idempotency guard');
  if (guards.ifMatchGuards !== undefined && !Array.isArray(guards.ifMatchGuards)) throw new Error('Invalid compare guard list');
  for (const guard of guards.ifMatchGuards || []) {
    if (!guard || !VALID_ENTITIES.has(guard.entity) || typeof guard.recordId !== 'string' || guard.recordId.length > 512 || typeof guard.field !== 'string' || !guard.field.trim() || typeof guard.expectedValue !== 'string' || guard.expectedValue.length > 512) throw new Error('Invalid compare guard');
  }
  const seen = new Set();
  const parsed = changes.map(change => {
    validateIdentity(change?.entity, change?.recordId);
    const identity = JSON.stringify([change.entity, change.recordId]);
    if (seen.has(identity)) throw new Error('Duplicate record change');
    seen.add(identity);
    if (change.action !== 'put' && change.action !== 'delete') throw new Error('Invalid record change action');
    if (change.action === 'put' && (!change.record || typeof change.record !== 'object' || Array.isArray(change.record))) throw new Error('put change requires a record object');
    if (change.action === 'put' && Buffer.byteLength(JSON.stringify(change.record), 'utf8') > MAX_RECORD_BYTES) throw new Error('Record exceeds the local SQLite size limit');
    if (change.action === 'put' && change.syncState !== undefined && !['local','pending','synced','error'].includes(change.syncState)) throw new Error('Invalid record sync state');
    return change;
  });
  const apply = db().transaction(rows => {
    const findRecord = db().prepare('SELECT json FROM pos_records WHERE entity = ? AND record_id = ?');
    const findField = db().prepare('SELECT json FROM pos_records WHERE entity = ?');
    if (guards.ifAbsentEntity && guards.ifAbsentRecordId && findRecord.get(guards.ifAbsentEntity, guards.ifAbsentRecordId)) return { applied: 0, skipped: true };
    if (guards.ifAbsentEntity && guards.ifAbsentField) {
      const existing = findField.all(guards.ifAbsentEntity).some(row => String(JSON.parse(row.json)?.[guards.ifAbsentField] ?? '') === guards.ifAbsentValue);
      if (existing) return { applied: 0, skipped: true };
    }
    for (const guard of guards.ifMatchGuards || []) {
      const row = findRecord.get(guard.entity, guard.recordId);
      if (!row || String(JSON.parse(row.json)?.[guard.field] ?? '') !== guard.expectedValue) return { applied: 0, skipped: true };
    }
    const now = Date.now();
    for (const change of rows) {
      if (change.action === 'delete') {
        db().prepare('DELETE FROM pos_records WHERE entity = ? AND record_id = ?').run(change.entity, change.recordId);
      } else {
        db().prepare(`INSERT INTO pos_records(entity, record_id, json, updated_at, sync_state)
          VALUES(?, ?, ?, ?, ?) ON CONFLICT(entity, record_id) DO UPDATE SET
          json=excluded.json, updated_at=excluded.updated_at, sync_state=excluded.sync_state`)
          .run(change.entity, change.recordId, JSON.stringify(change.record), now, change.syncState || 'local');
      }
    }
    return { applied: rows.length, skipped: false };
  });
  return { ...apply(parsed), count: parsed.length };
}

function enqueueOperation(operation) {
  if (!operation || typeof operation.operationId !== 'string' || !operation.operationId.trim() || operation.operationId.length > 256 ||
      typeof operation.type !== 'string' || !operation.type.trim() || operation.type.length > 128 ||
      !operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload) ||
      Buffer.byteLength(JSON.stringify(operation.payload), 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('Invalid Electron outbox operation');
  }
  const createdAt = Number(operation.createdAt || Date.now());
  const retryCount = Number(operation.retryCount || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isInteger(retryCount) || retryCount < 0) throw new Error('Invalid outbox metadata');
  const result = db().prepare(`INSERT OR IGNORE INTO pos_outbox(operation_id,type,payload,created_at,status,retry_count,next_retry_at)
    VALUES(?,?,?,?,'pending',?,?)`).run(operation.operationId, operation.type, JSON.stringify(operation.payload), createdAt, retryCount, operation.nextRetryAt ?? null);
  return { queued: result.changes === 1, duplicate: result.changes === 0, operationId: operation.operationId };
}
function saveAndEnqueueOperation(operation) {
  if (!operation || typeof operation.operationId !== 'string' || !operation.operationId.trim() ||
      typeof operation.type !== 'string' || !operation.type.trim() ||
      !operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) throw new Error('Invalid operation payload');
  const record = operation.record && typeof operation.record === 'object' ? operation.record : operation.payload;
  const recordId = operation.recordId || operation.operationId;
  const tx = db().transaction(() => {
    const exists = db().prepare('SELECT operation_id FROM pos_outbox WHERE operation_id=?').get(operation.operationId);
    if (exists) return { saved: false, queued: false, duplicate: true, operationId: operation.operationId };
    db().prepare(`INSERT INTO pos_records(entity,record_id,json,updated_at,sync_state) VALUES(?,?,?,?,?)
      ON CONFLICT(entity,record_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at,sync_state=excluded.sync_state`)
      .run(operation.entity || 'operations', recordId, JSON.stringify(record), Date.now(), 'pending');
    const queued = enqueueOperation(operation);
    if (!queued.queued) throw new Error('Could not enqueue local operation');
    return { saved: true, queued: true, duplicate: false, operationId: operation.operationId };
  });
  return tx();
}
function listOperations(pendingOnly = false) {
  const rows = db().prepare(`SELECT * FROM pos_outbox ${pendingOnly ? "WHERE status IN ('pending','error','syncing')" : ''} ORDER BY created_at, operation_id`).all();
  return rows.map(row => ({ operationId: row.operation_id, type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at, status: row.status, retryCount: row.retry_count, nextRetryAt: row.next_retry_at ?? undefined, lastError: row.last_error ?? undefined }));
}
function updateOperation(operationId, status, message) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId is required');
  if (!['pending', 'syncing', 'error', 'conflict', 'synced'].includes(status)) throw new Error('Invalid outbox status');
  const result = db().prepare('UPDATE pos_outbox SET status=?, last_error=?, retry_count=CASE WHEN ? = \'error\' THEN retry_count+1 ELSE retry_count END WHERE operation_id=?')
    .run(status, typeof message === 'string' ? message.slice(0, 4000) : null, status, operationId);
  return { updated: result.changes === 1 };
}
function retryOperation(operationId) {
  const result = db().prepare("UPDATE pos_outbox SET status='pending', last_error=NULL, next_retry_at=NULL WHERE operation_id=?").run(operationId);
  return { updated: result.changes === 1 };
}
function updateOperationPayload(operationId, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  const result = db().prepare("UPDATE pos_outbox SET payload=?, status='pending' WHERE operation_id=? AND status IN ('pending','error')").run(JSON.stringify(payload), operationId);
  return { updated: result.changes === 1, rows: result.changes };
}
function deleteOperation(operationId) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId is required');
  const result = db().prepare('DELETE FROM pos_outbox WHERE operation_id=?').run(operationId);
  return { deleted: result.changes === 1 };
}
function acknowledgeOperation(operationId) {
  const result = db().prepare("UPDATE pos_outbox SET status='synced', last_error=NULL WHERE operation_id=?").run(operationId);
  return { updated: result.changes === 1 };
}
function applySnapshotAndReplaceOutbox(changes, operations) {
  if (!Array.isArray(operations) || operations.length > 100000) throw new Error('Invalid snapshot outbox');
  const tx = db().transaction(() => {
    const recordResult = applyRecordChanges(changes);
    if (recordResult.skipped || recordResult.applied !== changes.length) throw new Error('Snapshot record transaction was incomplete');
    db().prepare('DELETE FROM pos_outbox').run();
    for (const operation of operations) {
      const result = enqueueOperation(operation);
      if (!result.queued) throw new Error('Duplicate or invalid operation in snapshot outbox');
    }
    return { applied: recordResult.applied, operationCount: operations.length, committed: true };
  });
  return tx();
}
function getMeta(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('meta key is required');
  const row = db().prepare('SELECT value FROM pos_meta WHERE key = ?').get(key);
  return row ? { value: row.value } : {};
}

function setMeta(key, value) {
  if (typeof key !== 'string' || !key.trim() || typeof value !== 'string') throw new Error('meta key and string value are required');
  db().prepare('INSERT INTO pos_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  return { saved: true };
}

function closeLocalDatabase() {
  if (database?.open) {
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();
  }
  database = null;
}

module.exports = { initializeLocalDatabase, getRecords, getRecord, putRecords, applyRecordChanges, getMeta, setMeta, enqueueOperation, saveAndEnqueueOperation, applySnapshotAndReplaceOutbox, listOperations, updateOperation, retryOperation, updateOperationPayload, deleteOperation, acknowledgeOperation, closeLocalDatabase };
