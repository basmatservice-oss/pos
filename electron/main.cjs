const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const SERVER_PORT = Number(process.env.PORT) || 3000;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/api/health`;
const IS_DEV = process.env.NODE_ENV === 'development' && !app.isPackaged;

let mainWindow = null;
let serverProcess = null;
let quitting = false;

function getRoleConfigPath() {
  return path.join(app.getPath('userData'), 'runtime-config.json');
}

function readConfiguredRole() {
  try {
    const config = JSON.parse(fs.readFileSync(getRoleConfigPath(), 'utf8'));
    return config.deviceRole === 'client' ? 'client' : 'server';
  } catch {
    return 'server';
  }
}

function getRuntimeRoot() {
  if (!app.isPackaged) return app.getAppPath();
  // The server bundle is unpacked because it is launched as a child Node process.
  return path.join(process.resourcesPath, 'app.asar.unpacked');
}

function waitForHealth(url, timeoutMs = 30000) {
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
  if (IS_DEV) return Promise.resolve();

  const runtimeRoot = getRuntimeRoot();
  const serverEntry = path.join(runtimeRoot, 'dist', 'server.js');
  const dbPath = path.join(app.getPath('userData'), 'dev.db');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      POS_DB_PATH: dbPath,
      POS_SERVER_BIND: readConfiguredRole() === 'client' ? '127.0.0.1' : '0.0.0.0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(`[POS Server] ${chunk}`);
  });
  serverProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(`[POS Server ERR] ${chunk}`);
  });
  serverProcess.on('error', (error) => {
    console.error('Unable to launch POS backend:', error);
  });
  serverProcess.on('exit', (code) => {
    console.log(`POS backend exited with code ${code}`);
    serverProcess = null;
    if (!quitting && code !== 0) {
      console.error('POS backend stopped unexpectedly.');
    }
  });

  return waitForHealth(HEALTH_URL, 30000);
}

function stopBackendServer() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch (error) {
      console.warn('Failed to stop POS backend:', error);
    }
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
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const targetUrl = IS_DEV
    ? `http://127.0.0.1:${SERVER_PORT}`
    : `http://127.0.0.1:${SERVER_PORT}`;

  await mainWindow.loadURL(targetUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:server-url', () => `http://127.0.0.1:${SERVER_PORT}`);

ipcMain.handle('app:set-device-role', (_event, role) => {
  if (role !== 'server' && role !== 'client') {
    throw new Error('Invalid device role');
  }
  const previousRole = readConfiguredRole();
  const configPath = getRoleConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ deviceRole: role }, null, 2), 'utf8');

  // Restart once when the role changes so the local backend binds to the correct interface.
  if (!IS_DEV && previousRole !== role) {
    app.relaunch();
    app.quit();
  }
  return true;
});

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
      if (!IS_DEV) await startBackendServer();
      await createWindow();
    } catch (error) {
      console.error('Failed to start Electron POS app:', error);
      stopBackendServer();
      app.quit();
    }
  });
}

app.on('before-quit', () => {
  quitting = true;
  stopBackendServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      if (!IS_DEV && !serverProcess) await startBackendServer();
      await createWindow();
    } catch (error) {
      console.error('Failed to recreate POS window:', error);
      app.quit();
    }
  }
});
