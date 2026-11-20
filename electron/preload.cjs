const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  posLocalDatabase: {
    initialize: () => ipcRenderer.invoke('pos-db:initialize'),
    getRecords: (entity) => ipcRenderer.invoke('pos-db:get-records', entity),
    getRecord: (entity, recordId) => ipcRenderer.invoke('pos-db:get-record', entity, recordId),
    putRecords: (records) => ipcRenderer.invoke('pos-db:put-records', records),
    applyRecordChanges: (changes) => ipcRenderer.invoke('pos-db:apply-record-changes', changes),
  },
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getServerUrl: () => ipcRenderer.invoke('app:server-url'),
  getDeviceRole: () => ipcRenderer.invoke('app:device-role'),
  setServerUrl: (url) => ipcRenderer.invoke('app:set-server-url', url),
  setDeviceRole: (role) => ipcRenderer.invoke('app:set-device-role', role),
});
