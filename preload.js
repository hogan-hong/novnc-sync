const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('syncAPI', {
  scanClients: () => ipcRenderer.invoke('scan-clients'),
  setMaster: (ip) => ipcRenderer.invoke('set-master', ip),
  toggleSlave: (ip) => ipcRenderer.invoke('toggle-slave', ip),
  setSlaves: (ips) => ipcRenderer.invoke('set-slaves', ips),
  startSync: (masterClientUrl, masterWinIndex) => ipcRenderer.invoke('start-sync', masterClientUrl, masterWinIndex),
  stopSync: () => ipcRenderer.invoke('stop-sync'),
  sendCommand: (data) => ipcRenderer.invoke('send-command', data),
  refreshWindow: (clientUrl, windowIndex) => ipcRenderer.invoke('refresh-window', clientUrl, windowIndex),
  getConfig: () => ipcRenderer.invoke('get-config')
})
