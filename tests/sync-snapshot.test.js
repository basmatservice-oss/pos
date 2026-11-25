import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterServerSnapshotPreservingLocalPending,
  getPendingSyncKeys,
} from '../src/utils/syncSnapshot.ts';

test('pending, error and conflict records are protected across SQLite and Dexie state shapes', () => {
  const localRows = [
    { id: 1, syncState: 'pending' },
    { id: 2, syncState: 'error' },
    { id: 3, syncState: 'conflict' },
    { id: 4, syncStatus: 'pending' },
    { id: 5, syncStatus: 'error' },
    { id: 6, syncStatus: 'conflict' },
    { id: 7, syncStatus: 'synced' },
  ];
  const pending = getPendingSyncKeys(localRows);
  assert.deepEqual([...pending].sort(), ['1', '2', '3', '4', '5', '6']);
});

test('server snapshots cannot overwrite unresolved local records but can refresh synced rows', () => {
  const pending = getPendingSyncKeys([
    { id: 11, syncState: 'pending' },
    { id: 12, syncStatus: 'error' },
    { id: 13, syncState: 'conflict' },
  ]);
  const serverRows = [
    { id: '11', value: 'server-stale' },
    { id: 12, value: 'server-stale' },
    { id: 13, value: 'server-stale' },
    { id: 14, value: 'server-fresh' },
    { value: 'server-row-without-key' },
  ];
  assert.deepEqual(
    filterServerSnapshotPreservingLocalPending(serverRows, pending),
    [serverRows[3], serverRows[4]],
  );
});

test('numeric and string primary keys reconcile identically and empty identifiers are not fabricated', () => {
  const pending = getPendingSyncKeys([
    { key: 42, syncState: 'pending' },
    { code: 'USD', syncStatus: 'conflict' },
    { id: null, syncStatus: 'error' },
  ]);
  const rows = [
    { id: '42' }, { code: 'USD' }, { id: null }, { key: 43 },
  ];
  assert.deepEqual(filterServerSnapshotPreservingLocalPending(rows, pending), [rows[2], rows[3]]);
});

test('unknown local sync states do not block authoritative server refreshes', () => {
  const pending = getPendingSyncKeys([
    { id: 'a', syncState: 'synced' },
    { id: 'b', syncStatus: 'complete' },
    { id: 'c', syncStatus: '' },
  ]);
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(filterServerSnapshotPreservingLocalPending(rows, pending), rows);
});

test('sync service applies the shared pending filter on SQLite and Dexie pull paths', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/services/syncService.ts', import.meta.url), 'utf8');
  assert.match(source, /getPendingSyncKeys\(existingNative\.map/);
  assert.match(source, /filterServerSnapshotPreservingLocalPending\(data, pendingIds\)/);
  assert.match(source, /const pendingNoStatus = getPendingSyncKeys\(existingNoStatus\)/);
  assert.match(source, /anyOf\(\['pending', 'error', 'syncing', 'conflict'\]\)/);
  assert.match(source, /if \(pendingOpsCount > 0\) continue;[\s\S]*?const existingNoStatus/);
});
