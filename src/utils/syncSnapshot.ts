type SyncSnapshotRecord = {
  id?: unknown;
  key?: unknown;
  code?: unknown;
  syncState?: unknown;
  syncStatus?: unknown;
};

const PENDING_SYNC_STATES = new Set(['pending', 'error', 'conflict']);

function getRecordKey(record: SyncSnapshotRecord): string | null {
  const key = record.id ?? record.key ?? record.code;
  return key === undefined || key === null ? null : String(key);
}

/**
 * Identify unresolved local records independently of the storage engine.
 * SQLite stores the state beside the record; Dexie may store it on the row.
 */
export function getPendingSyncKeys(localRows: SyncSnapshotRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const row of localRows) {
    const state = String(row.syncState ?? row.syncStatus ?? '');
    const key = getRecordKey(row);
    if (key !== null && PENDING_SYNC_STATES.has(state)) keys.add(key);
  }
  return keys;
}

/** Keep server snapshots from overwriting unresolved local records. */
export function filterServerSnapshotPreservingLocalPending<T extends SyncSnapshotRecord>(
  serverRows: T[],
  pendingKeys: Set<string>,
): T[] {
  return serverRows.filter((row) => {
    const key = getRecordKey(row);
    return key === null || !pendingKeys.has(key);
  });
}
