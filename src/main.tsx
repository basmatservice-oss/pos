import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { mirrorNativePosDatabase, restoreNativePosDatabase } from './services/nativeDatabaseMirror';
import { isNativeAndroid } from './native/posLocalDatabase';
import { electronPosRepository, isElectronDesktop, setElectronDeviceRole } from './native/electronPosRepository';
import { NATIVE_POS_ENTITIES, getNativePosRecordId } from './native/nativePosRepository';
import { putPosSetting } from './services/posDataAccess';

async function restoreDesktopRuntimeConfig() {
  const desktopApi = (window as any).electronAPI;
  if (isElectronDesktop()) {
    const role = await desktopApi.getDeviceRole();
    const serverUrl = role === 'client' && desktopApi.getServerUrl ? await desktopApi.getServerUrl() : null;
    if (role === 'server' || role === 'client') await putPosSetting('deviceRole', role, 'synced');
    if (role === 'client' && serverUrl) await putPosSetting('serverUrl', serverUrl, 'synced');
    return;
  }
  const { db } = await import('./db/db');
  if (!desktopApi?.getDeviceRole) return;

  const role = await desktopApi.getDeviceRole();
  if (role !== 'server' && role !== 'client') return;

  const updatedAt = new Date().toISOString();
  await db.settings.put({
    key: 'deviceRole',
    value: role,
    syncStatus: 'synced',
    updatedAt,
  });

  if (role === 'client' && desktopApi.getServerUrl) {
    const serverUrl = await desktopApi.getServerUrl();
    if (serverUrl) {
      await db.settings.put({
        key: 'serverUrl',
        value: serverUrl,
        syncStatus: 'synced',
        updatedAt,
      });
    }
  }
}

let nativeStartupError: unknown = null;

async function initializeLocalRuntime(): Promise<void> {
  if (isNativeAndroid()) {
    const restoredFromSQLite = await restoreNativePosDatabase();
    if (!restoredFromSQLite) {
      // One-time migration reads the existing IndexedDB stores directly; it does not instantiate Dexie.
      await mirrorNativePosDatabase();

      // Do not expose the application until the newly written SQLite snapshot
      // has passed the same identity and completeness checks used on later starts.
      const migratedSnapshotIsValid = await restoreNativePosDatabase();
      if (!migratedSnapshotIsValid) {
        throw new Error('Android SQLite migration completed without a verifiable business snapshot');
      }
    }

    // Migrate any pre-SQLite operation queue even on standalone devices.
    // This function is guarded by a durable SQLite marker and loads Dexie only
    // for the one-time legacy migration.
    const { migrateLegacyAndroidQueueToSQLite } = await import('./services/syncService');
    await migrateLegacyAndroidQueueToSQLite();

    // Normal Android startup does not initialize or hydrate Dexie after migration.
    return;
  }

  if (isElectronDesktop()) {
    const configuredRole = await (window as any).electronAPI.getDeviceRole();
    if (configuredRole !== 'server' && configuredRole !== 'client') throw new Error('Invalid Windows device role');
    setElectronDeviceRole(configuredRole);
    if (configuredRole === 'server') {
      // Windows Server reads and writes the authoritative Drizzle database
      // through its local API; do not initialize a renderer-side Dexie cache.
      await restoreDesktopRuntimeConfig();
      return;
    }
    const marker = await electronPosRepository.getMeta('dexie-business-migration-v1');
    if (marker !== 'complete') {
      const { ensureDatabaseReady, db } = await import('./db/db');
      await ensureDatabaseReady();
      for (const entity of NATIVE_POS_ENTITIES) {
        const records = await db.table(entity).toArray() as Array<Record<string, unknown>>;
        for (const state of ['local', 'pending', 'synced', 'error'] as const) {
          const matching = records.filter((record) => (['local', 'pending', 'synced', 'error'].includes(String(record.syncStatus)) ? String(record.syncStatus) : 'local') === state);
          if (matching.length) await electronPosRepository.putMany(entity, matching, state);
        }
        const stored = await electronPosRepository.getAll(entity);
        const expectedById = new Map(records.map((record) => [getNativePosRecordId(entity, record), JSON.stringify(record)]));
        const storedById = new Map(stored.map((record) => [getNativePosRecordId(entity, record), JSON.stringify(record)]));
        if (storedById.size !== expectedById.size || [...expectedById].some(([id, json]) => storedById.get(id) !== json)) {
          throw new Error(`Electron SQLite migration content verification failed for ${entity}: ${records.length} source, ${stored.length} destination`);
        }
      }
      const legacyOperations = await db.syncOperations.toArray();
      const legacyPending = legacyOperations
        .filter((operation: any) => ['pending', 'error', 'conflict', 'syncing'].includes(String(operation.status || 'pending')))
        .map((operation: any, index: number) => {
          const rawId = operation.id ?? operation.operationId;
          const validIdentity = typeof rawId === 'string' && rawId.trim().length > 0 &&
            typeof operation.type === 'string' && operation.type.trim().length > 0;
          const validPayload = operation.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload);
          const createdAt = typeof operation.createdAt === 'number'
            ? operation.createdAt
            : new Date(operation.createdAt || Date.now()).getTime();
          const retryAt = operation.nextRetryAt
            ? (typeof operation.nextRetryAt === 'number' ? operation.nextRetryAt : new Date(operation.nextRetryAt).getTime())
            : null;
          const retryCount = Number(operation.retryCount || 0);
          const schemaVersion = Number(operation.schemaVersion || 1);
          const validMetadata = Number.isInteger(retryCount) && retryCount >= 0 &&
            Number.isInteger(schemaVersion) && schemaVersion >= 1 &&
            (retryAt === null || (Number.isFinite(retryAt) && retryAt > 0));
          return {
            operationId: validIdentity ? String(rawId).trim() : 'legacy-invalid-' + String(index),
            type: validIdentity ? String(operation.type) : 'legacy_malformed',
            payload: validPayload ? operation.payload : { legacyMalformed: true, originalId: rawId ?? null, originalType: operation.type ?? null },
            createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
            retryCount: validMetadata ? retryCount : 0,
            nextRetryAt: retryAt && Number.isFinite(retryAt) ? retryAt : null,
            deviceId: operation.deviceId,
            tenantId: operation.tenantId,
            branchId: operation.branchId,
            actor: operation.actor,
            schemaVersion: validMetadata ? schemaVersion : 1,
            status: !validIdentity || !validPayload || !validMetadata
              ? 'conflict'
              : operation.status === 'syncing' ? 'pending' : operation.status,
          };
        });
      const migratedQueue = await electronPosRepository.mergeOperations(legacyPending);
      if (migratedQueue.total !== legacyPending.length || migratedQueue.inserted + migratedQueue.duplicates !== legacyPending.length) {
        throw new Error('Electron SQLite legacy operation queue migration was incomplete');
      }
      await electronPosRepository.setMeta('dexie-business-migration-v1', 'complete');
    }
    await restoreDesktopRuntimeConfig();
    return;
  }

  const { ensureDatabaseReady } = await import('./db/db');
  await ensureDatabaseReady();
  await restoreDesktopRuntimeConfig();
}

initializeLocalRuntime()
  .catch((err) => {
    console.error('Failed to initialize local database/runtime config:', err);
    if (isNativeAndroid() || isElectronDesktop()) nativeStartupError = err;
  })
  .finally(() => {
    const root = document.getElementById('root')!;
    if (nativeStartupError) {
      const message = nativeStartupError instanceof Error ? nativeStartupError.message : String(nativeStartupError);
      const container = document.createElement('main');
      container.setAttribute('role', 'alert');
      container.style.cssText = 'min-height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:24px;text-align:center;gap:16px;direction:rtl;font-family:system-ui,sans-serif';
      const heading = document.createElement('h2');
      heading.textContent = 'تعذر فتح قاعدة البيانات المحلية';
      const details = document.createElement('p');
      details.textContent = 'تم إيقاف التشغيل لحماية بياناتك. ' + message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'إعادة المحاولة';
      retry.onclick = () => window.location.reload();
      container.append(heading, details, retry);
      root.replaceChildren(container);
      return;
    }
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
