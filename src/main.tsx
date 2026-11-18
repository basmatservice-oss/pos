import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { db, ensureDatabaseReady } from './db/db';
import { installNativeDatabaseMirrorHooks, mirrorNativePosDatabase, restoreNativePosDatabase } from './services/nativeDatabaseMirror';

async function restoreDesktopRuntimeConfig() {
  const desktopApi = (window as any).electronAPI;
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

ensureDatabaseReady()
  .then(async () => {
    try {
      await restoreNativePosDatabase();
    } catch (err) {
      console.error('Failed to restore Android SQLite business snapshot:', err);
    }
    await restoreDesktopRuntimeConfig();
    installNativeDatabaseMirrorHooks();
    try {
      await mirrorNativePosDatabase();
    } catch (err) {
      console.error('Failed to refresh Android SQLite business snapshot:', err);
    }
  })
  .catch((err) => {
    console.error('Failed to initialize local database/runtime config:', err);
  })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
