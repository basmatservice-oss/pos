import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'davincipos-sync-outbox-'));
process.env.DAVINCIPOS_DB=path.join(directory,'sync.sqlite');
const {db,initializeDatabase}=await import('./database.js');
const {enqueueSyncOperation,readPendingSyncOperations,acknowledgeSyncOperation,failSyncOperation}=await import('./sync.js');

initializeDatabase();

test('server sync outbox preserves payloads, retries failures and acknowledges operations',()=>{
  const payload={id:'offline-sale-1',totalMinor:12500,lines:[{itemId:'item-1',quantity:2}]};
  const operationId=enqueueSyncOperation({
    deviceId:'device-test-0001',entityType:'sale',entityId:payload.id,operation:'upsert',payload
  });

  let pending=readPendingSyncOperations();
  assert.equal(pending.length,1);
  assert.equal(pending[0].operation_id,operationId);
  assert.equal(pending[0].status,'pending');
  assert.deepEqual(JSON.parse(pending[0].payload),payload);

  assert.equal(failSyncOperation(operationId,'Temporary network failure'),1);
  pending=readPendingSyncOperations();
  assert.equal(pending.length,1);
  assert.equal(pending[0].status,'failed');
  assert.equal(pending[0].attempts,1);
  assert.equal(pending[0].last_error,'Temporary network failure');

  assert.equal(acknowledgeSyncOperation(operationId),1);
  assert.equal(readPendingSyncOperations().length,0);
  const acknowledged=db.prepare('SELECT status,acknowledged_at,last_error FROM sync_outbox WHERE operation_id=?').get(operationId);
  assert.equal(acknowledged.status,'acknowledged');
  assert.ok(acknowledged.acknowledged_at);
  assert.equal(acknowledged.last_error,null);

  const deleteId=enqueueSyncOperation({
    deviceId:'device-test-0001',entityType:'sale',entityId:'sale-to-delete',operation:'delete',payload:{id:'sale-to-delete'}
  });
  assert.notEqual(deleteId,operationId);
  assert.equal(readPendingSyncOperations()[0].operation,'delete');
});

test('rejects incomplete outbox operations and clamps batch size',()=>{
  assert.throws(()=>enqueueSyncOperation({deviceId:'device-test-0001',entityType:'sale',entityId:'x'}),/Incomplete sync operation/);
  assert.equal(readPendingSyncOperations(0).length,1);
  assert.equal(readPendingSyncOperations(10000).length,1);
});

test('closes sync outbox test database',()=>{
  db.close();
  fs.rmSync(directory,{recursive:true,force:true});
});
