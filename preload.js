const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('syncAPI', {
  scanClients: () => ipcRenderer.invoke('scan-clients'),
  startSync: (data) => ipcRenderer.invoke('start-sync', data),
  stopSync: () => ipcRenderer.invoke('stop-sync'),
  reloadConfig: () => ipcRenderer.invoke('reload-config'),
  onSyncStopped: (callback) => ipcRenderer.on('sync-stopped', () => callback()),
  onMasterFocused: (callback) => ipcRenderer.on('master-focused', () => callback())
})
