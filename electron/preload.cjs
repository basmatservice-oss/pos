const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  posLocalDatabase: {
    initialize: () => ipcRenderer.invoke('pos-db:initialize'),
    getRecords: (entity) => ipcRenderer.invoke('pos-db:get-records', entity),
    getRecord: (entity, recordId) => ipcRenderer.invoke('pos-db:get-record', entity, recordId),
    putRecords: (records) => ipcRenderer.invoke('pos-db:put-records', records),
    applyRecordChanges: (changes, guards) => ipcRenderer.invoke('pos-db:apply-record-changes', changes, guards),
    getMeta: (key) => ipcRenderer.invoke('pos-db:get-meta', key),
    setMeta: (key, value) => ipcRenderer.invoke('pos-db:set-meta', key, value),
    enqueueOperation: (operation) => ipcRenderer.invoke('pos-db:enqueue-operation', operation),
    saveAndEnqueueOperation: (operation) => ipcRenderer.invoke('pos-db:save-enqueue-operation', operation),
    applySnapshotAndReplaceOutbox: (changes, operations) => ipcRenderer.invoke('pos-db:apply-snapshot', changes, operations),
    listOperations: (pendingOnly) => ipcRenderer.invoke('pos-db:list-operations', pendingOnly),
    updateOperation: (id, status, message, nextRetryAt) => ipcRenderer.invoke('pos-db:update-operation', id, status, message, nextRetryAt),
    retryOperation: (id) => ipcRenderer.invoke('pos-db:retry-operation', id),
    updateOperationPayload: (id, payload) => ipcRenderer.invoke('pos-db:update-operation-payload', id, payload),
    acknowledgeOperation: (id) => ipcRenderer.invoke('pos-db:ack-operation', id),
    deleteOperation: (id) => ipcRenderer.invoke('pos-db:delete-operation', id),
  },
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getServerUrl: () => ipcRenderer.invoke('app:server-url'),
  getDeviceRole: () => ipcRenderer.invoke('app:device-role'),
  setServerUrl: (url) => ipcRenderer.invoke('app:set-server-url', url),
  setDeviceRole: (role) => ipcRenderer.invoke('app:set-device-role', role),
});
