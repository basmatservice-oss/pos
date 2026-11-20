const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let database = null;

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
  if (typeof entity !== 'string' || !entity.trim() ||
      typeof recordId !== 'string' || !recordId.trim()) {
    throw new Error('A non-empty entity and recordId are required');
  }
}

function getRecords(entity) {
  if (typeof entity !== 'string' || !entity.trim()) throw new Error('entity is required');
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
    return { ...item, syncState, json: JSON.stringify(item.record) };
  });
  const insert = db().prepare(`INSERT INTO pos_records(entity, record_id, json, updated_at, sync_state)
    VALUES(@entity, @recordId, @json, @updatedAt, @syncState)
    ON CONFLICT(entity, record_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at, sync_state=excluded.sync_state`);
  const apply = db().transaction(rows => {
    const findRecord = db().prepare('SELECT json FROM pos_records WHERE entity = ? AND record_id = ?');
    const findField = db().prepare('SELECT json FROM pos_records WHERE entity = ?');
    if (guards.ifAbsentEntity && guards.ifAbsentRecordId && findRecord.get(guards.ifAbsentEntity, guards.ifAbsentRecordId)) return { applied: 0, skipped: true };
    if (guards.ifAbsentEntity && guards.ifAbsentField) {
      const existing = findField.all(guards.ifAbsentEntity).some(row => JSON.stringify(JSON.parse(row.json)?.[guards.ifAbsentField]) === guards.ifAbsentValue);
      if (existing) return { applied: 0, skipped: true };
    }
    for (const guard of guards.ifMatchGuards || []) {
      const row = findRecord.get(guard.entity, guard.recordId);
      if (!row || JSON.stringify(JSON.parse(row.json)?.[guard.field]) !== guard.expectedValue) return { applied: 0, skipped: true };
    }
    const now = Date.now();
    for (const row of rows) insert.run({ ...row, updatedAt: now });
    return rows.length;
  });
  return { saved: true, count: apply(parsed) };
}

function applyRecordChanges(changes, guards = {}) {
  if (!Array.isArray(changes)) throw new Error('changes must be an array');
  const seen = new Set();
  const parsed = changes.map(change => {
    validateIdentity(change?.entity, change?.recordId);
    const identity = JSON.stringify([change.entity, change.recordId]);
    if (seen.has(identity)) throw new Error('Duplicate record change');
    seen.add(identity);
    if (change.action !== 'put' && change.action !== 'delete') throw new Error('Invalid record change action');
    if (change.action === 'put' && (!change.record || typeof change.record !== 'object' || Array.isArray(change.record))) throw new Error('put change requires a record object');
    return change;
  });
  const apply = db().transaction(rows => {
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

module.exports = { initializeLocalDatabase, getRecords, getRecord, putRecords, applyRecordChanges, getMeta, setMeta, closeLocalDatabase };
