import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { db, ensureDatabaseReady } from './db/db';
import { installNativeDatabaseMirrorHooks, mirrorNativePosDatabase, restoreNativePosDatabase } from './services/nativeDatabaseMirror';
import { isNativeAndroid } from './native/posLocalDatabase';

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

let nativeStartupError: unknown = null;

ensureDatabaseReady()
  .then(async () => {
    try {
      const restoredFromSQLite = await restoreNativePosDatabase();
    } catch (err) {
      console.error('Failed to restore Android SQLite business snapshot:', err);
      if (isNativeAndroid()) throw err;
    }
    await restoreDesktopRuntimeConfig();
    installNativeDatabaseMirrorHooks();
    try {
      if (!restoredFromSQLite) await mirrorNativePosDatabase();
    } catch (err) {
      console.error('Failed to refresh Android SQLite business snapshot:', err);
      if (isNativeAndroid()) throw err;
    }
  })
  .catch((err) => {
    console.error('Failed to initialize local database/runtime config:', err);
    if (isNativeAndroid()) nativeStartupError = err;
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
