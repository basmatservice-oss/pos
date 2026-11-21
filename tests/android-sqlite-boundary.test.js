import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Android startup uses the verified SQLite snapshot and only imports legacy IndexedDB when needed', async () => {
  const source = await read('../src/main.tsx');
  const androidStart = source.indexOf('if (isNativeAndroid()) {');
  const windowsStart = source.indexOf('if (isElectronDesktop()) {', androidStart);
  assert.ok(androidStart >= 0 && windowsStart > androidStart, 'Android startup branch must remain explicit');
  const androidBranch = source.slice(androidStart, windowsStart);
  assert.match(androidBranch, /restoreNativePosDatabase\(\)/);
  assert.match(androidBranch, /if \(!restoredFromSQLite\)[\s\S]*?mirrorNativePosDatabase\(\)/);
  assert.doesNotMatch(androidBranch, /import\(['"]\.\/db\/db['"]\)|ensureDatabaseReady/);
  assert.match(androidBranch, /migrateLegacyAndroidQueueToSQLite/);
});

test('Android SQLite snapshot migration has no active Dexie write-through hooks', async () => {
  const source = await read('../src/services/nativeDatabaseMirror.ts');
  assert.match(source, /readLegacyIndexedDBStores/);
  assert.match(source, /export async function mirrorNativePosDatabase/);
  assert.match(source, /export async function restoreNativePosDatabase/);
  assert.doesNotMatch(source, /installNativeDatabaseMirrorHooks|mirrorNativePosRecord|table\.hook\(/);
});

test('business data access routes local Android reads and writes through the native SQLite repository', async () => {
  const source = await read('../src/services/posDataAccess.ts');
  assert.match(source, /if \(isLocalSqlite\(\)\) return \(await nativePosRepository\.get/);
  assert.match(source, /if \(isLocalSqlite\(\)\) return await nativePosRepository\.getAll/);
  assert.match(source, /if \(isLocalSqlite\(\)\) \{[\s\S]*?await nativePosRepository\.put/);
  assert.match(source, /if \(isLocalSqlite\(\)\) \{[\s\S]*?nativePosRepository\.applyChanges/);
});


test('Android legacy business migration never replaces the SQLite source of truth', async () => {
  const source = await read('../src/services/nativeDatabaseMirror.ts');
  assert.match(source, /business_snapshot_version/);
  assert.match(source, /Existing SQLite records always win/);
  assert.match(source, /currentRows = await nativePosRepository\.getAllWithSyncState/);
  assert.match(source, /missingRows = records\.filter\(\(record\) => !currentIds\.has\(record\.recordId\)\)/);
  assert.doesNotMatch(source, /replaceNativePosRecords\(entity, records\)/);
});

test('Android SQLite schema upgrades inspect columns before adding them', async () => {
  const source = await read('../native/android/PosLocalDatabasePlugin.kt');
  assert.match(source, /private fun ensureColumn/);
  assert.match(source, /PRAGMA table_info/);
  assert.match(source, /ensureColumn\(db, "pos_outbox", "tenant_id"/);
  assert.match(source, /ensureColumn\(db, "pos_outbox", "next_retry_at"/);
});

test('product save confirms visibility from the authoritative catalog before closing the editor', async () => {
  const source = await read('../src/pages/Inventory.tsx');
  assert.match(source, /const persistedProducts = await getPosRecords<Product>\('products'\)/);
  assert.match(source, /if \(!persistedProduct\)/);
  assert.match(source, /updateProducts\(persistedProducts\)/);
});
