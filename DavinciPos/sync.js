import { randomUUID } from 'node:crypto';
import { db } from './database.js';

export function enqueueSyncOperation({ deviceId, entityType, entityId, operation = 'upsert', payload }) {
  if (!deviceId || !entityType || !entityId || !payload) throw new Error('Incomplete sync operation.');
  const operationId = randomUUID();
  db.prepare(`INSERT INTO sync_outbox (id,device_id,operation_id,entity_type,entity_id,operation,payload,status,created_at)
    VALUES (?,?,?,?,?,?,?,'pending',?)`).run(randomUUID(), deviceId, operationId, entityType, entityId, operation, JSON.stringify(payload), new Date().toISOString());
  return operationId;
}

export function readPendingSyncOperations(limit = 100) {
  return db.prepare(`SELECT * FROM sync_outbox WHERE status IN ('pending','failed') ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(500, limit)));
}

export function acknowledgeSyncOperation(operationId) {
  return db.prepare(`UPDATE sync_outbox SET status='acknowledged', acknowledged_at=?, last_error=NULL WHERE operation_id=?`)
    .run(new Date().toISOString(), operationId).changes;
}

export function failSyncOperation(operationId, error) {
  return db.prepare(`UPDATE sync_outbox SET status='failed', attempts=attempts+1, last_error=? WHERE operation_id=?`)
    .run(String(error).slice(0,1000), operationId).changes;
}
