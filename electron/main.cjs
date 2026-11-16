const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SERVER_PORT = Number(process.env.PORT) || 3000;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/api/health`;
const IS_DEV = process.env.NODE_ENV === 'development' && !app.isPackaged;

let mainWindow = null;
let serverProcess = null;

function waitForHealth(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve();
        } else if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Server health check returned status ${res.statusCode}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('Timed out waiting for POS backend server'));
        } else {
          setTimeout(attempt, 300);
        }
      });
      req.setTimeout(1500, () => req.destroy());
    };
    attempt();
  });
}

function startBackendServer() {
  if (IS_DEV) {
    return Promise.resolve();
  }

  const appRoot = app.getAppPath();
  const serverEntry = path.join(appRoot, 'dist', 'server.js');
  const dbPath = path.join(app.getPath('userData'), 'dev.db');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      POS_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(`[POS Server] ${chunk}`);
  });
  serverProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(`[POS Server ERR] ${chunk}`);
  });
  serverProcess.on('exit', (code) => {
    console.log(`POS backend exited with code ${code}`);
    serverProcess = null;
  });

  return waitForHealth(HEALTH_URL, 25000);
}

function stopBackendServer() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill('SIGTERM');
    } catch {}
    serverProcess = null;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const targetUrl = IS_DEV
    ? 'http://localhost:5173'
    : `http://127.0.0.1:${SERVER_PORT}`;

  await mainWindow.loadURL(targetUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:server-url', () => `http://127.0.0.1:${SERVER_PORT}`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startBackendServer();
      await createWindow();
    } catch (err) {
      console.error('Failed to start Electron POS app:', err);
      stopBackendServer();
      app.quit();
    }
  });
}

app.on('before-quit', () => {
  stopBackendServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopBackendServer();
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});
