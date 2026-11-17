const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getServerUrl: () => ipcRenderer.invoke('app:server-url'),
  setDeviceRole: (role) => ipcRenderer.invoke('app:set-device-role', role),
});
