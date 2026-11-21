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

test('Windows client startup migrates legacy IndexedDB directly and never initializes Dexie', async () => {
  const source = await read('../src/main.tsx');
  const runtimeStart = source.indexOf('async function initializeLocalRuntime');
  const desktopStart = source.indexOf('if (isElectronDesktop()) {', runtimeStart);
  const browserStart = source.indexOf('const { ensureDatabaseReady } = await import', desktopStart);
  assert.ok(desktopStart >= 0 && browserStart > desktopStart, 'Electron startup branch must remain explicit');
  const desktopBranch = source.slice(desktopStart, browserStart);
  assert.match(desktopBranch, /readLegacyIndexedDBStores\(\)/);
  assert.match(desktopBranch, /electronPosRepository\.putMany/);
  assert.match(desktopBranch, /missingAfterMigration/);
  assert.doesNotMatch(desktopBranch, /import\(['"]\.\/db\/db['"]\)|ensureDatabaseReady|db\.table\(/);
});

test('Android and Windows client data access share SQLite as their only local runtime repository', async () => {
  const source = await read('../src/services/posDataAccess.ts');
  assert.match(source, /const isLocalSqlite = \(\): boolean => isNativeAndroid\(\) \|\| isElectronLocalClient\(\)/);
  assert.match(source, /if \(isLocalSqlite\(\)\) return \(await nativePosRepository\.get/);
  assert.match(source, /if \(isLocalSqlite\(\)\) return await nativePosRepository\.getAll/);
  assert.match(source, /if \(isLocalSqlite\(\)\) \{[\s\S]*?await nativePosRepository\.put/);
  assert.match(source, /if \(isLocalSqlite\(\)\) \{[\s\S]*?nativePosRepository\.applyChanges/);
});

test('native SQLite services do not eagerly load the Dexie compatibility database', async () => {
  const files = [
    '../src/services/operationService.ts',
    '../src/services/syncService.ts',
    '../src/services/localAccountingEngine.ts',
    '../src/services/localInventoryEngine.ts',
    '../src/services/localOperationReconciliation.ts',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /import\s+\{\s*db\s*\}\s+from\s+['"][^'"]*db\/db/);
    assert.match(source, /isLocalSqlite\(\)/, file + ' must guard the native SQLite path');
    assert.match(source, /if \(isLocalSqlite\(\)[\s\S]{0,180}(?:return|\)\s*\{)/, file + ' must bypass its Dexie fallback on local SQLite');
  }
});

test('native Android and Windows bundles hard-disable Dexie and retain it only for browser builds', async () => {
  const vite = await read('../vite.config.ts');
  const stub = await read('../src/db/nativeRuntimeStub.ts');
  const pkg = JSON.parse(await read('../package.json'));
  assert.match(vite, /POS_NATIVE_SQLITE_BUILD/);
  assert.match(vite, /nativeRuntimeStub\.ts/);
  assert.match(vite, /source === 'dexie'/);
  assert.match(stub, /export function liveQuery/);
  assert.match(stub, /Legacy IndexedDB compatibility storage is disabled in native SQLite builds/);
  assert.equal(pkg.dependencies.dexie, undefined);
  assert.equal(pkg.devDependencies.dexie, '^4.3.0');
  assert.match(pkg.scripts['build:native'], /POS_NATIVE_SQLITE_BUILD=1/);
  assert.match(pkg.scripts['package:win'], /build:native/);
});

test('product upsert on Android and Windows client commits through SQLite before returning', async () => {
  const source = await read('../src/services/operationService.ts');
  const start = source.indexOf('async function applyEntityLocally');
  const end = source.indexOf('async function validateLocalOperationFiscalPeriod', start);
  assert.ok(start >= 0 && end > start, 'local entity operation handler must remain explicit');
  const handler = source.slice(start, end);
  assert.match(handler, /if \(isLocalSqlite\(\)\)[\s\S]*?nativePosRepository\.applyChanges\(changes\)/);
  assert.match(handler, /if \(applied !== changes\.length\) throw new Error\('لم تؤكد SQLite حفظ جميع سجلات الصنف'\)/);
  assert.match(handler, /if \(isLocalSqlite\(\)\) \{[\s\S]*?existingProduct = await nativePosRepository\.get<any>\('products'/);
});

test('native SQLite registry covers every legacy business store and routes the old operation table to the outbox', async () => {
  const schema = await read('../src/db/db.ts');
  const repository = await read('../src/native/nativePosRepository.ts');
  const electron = await read('../electron/local-database.cjs');
  const android = await read('../native/android/PosLocalDatabasePlugin.kt');

  const versions = [...schema.matchAll(/this\\.version\\((\\d+)\\)\\.stores\\(\\{/g)];
  assert.ok(versions.length, 'legacy Dexie schema versions must be discoverable');
  const latest = versions[versions.length - 1];
  const blockStart = latest.index + latest[0].length;
  const blockEnd = schema.indexOf('});', blockStart);
  assert.ok(blockEnd > blockStart, 'latest legacy table registry must be complete');
  const legacyTables = [...schema.slice(blockStart, blockEnd).matchAll(/^\\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]);

  const registryBlock = repository.match(/const NATIVE_PRIMARY_KEYS = \\{([\\s\\S]*?)\\} as const/);
  assert.ok(registryBlock, 'native primary-key registry must exist');
  const nativeTables = [...registryBlock[1].matchAll(/^\\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]);
  const electronSet = electron.match(/const VALID_ENTITIES = new Set\\(\\[([^\\]]+)\\]\\)/);
  assert.ok(electronSet, 'Electron SQLite entity allowlist must exist');
  const electronTables = [...electronSet[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

  for (const table of legacyTables.filter(name => name !== 'syncOperations')) {
    assert.ok(nativeTables.includes(table), 'native SQLite registry is missing legacy store ' + table);
  }
  for (const table of nativeTables) {
    assert.ok(electronTables.includes(table), 'Electron SQLite allowlist is missing native entity ' + table);
  }
  assert.ok(!nativeTables.includes('syncOperations'), 'operation queue must not be duplicated as a business table');
  assert.match(electron, /CREATE TABLE IF NOT EXISTS pos_outbox/);
  assert.match(android, /CREATE TABLE IF NOT EXISTS pos_outbox/);
});

test('product editor blocks duplicate submissions and reports success only after SQLite read-back', async () => {
  const source = await read('../src/pages/Inventory.tsx');
  const start = source.indexOf('const handleSubmit = async (e: React.FormEvent)');
  const end = source.indexOf('const handleDelete =', start);
  assert.ok(start >= 0 && end > start, 'product submit handler must remain explicit');
  const handler = source.slice(start, end);
  assert.match(handler, /if \\(isSavingProductRef\\.current\\) return/);
  assert.match(handler, /isSavingProductRef\\.current = true/);
  assert.match(handler, /finally \\{[\\s\\S]*?isSavingProductRef\\.current = false/);
  const readBack = handler.indexOf("getPosRecords<Product>('products')");
  const success = handler.indexOf('toast.success(editingProduct');
  assert.ok(readBack >= 0 && success > readBack, 'success must not appear before authoritative read-back');
  assert.match(handler, /if \\(!persistedProduct\\)/);
});
