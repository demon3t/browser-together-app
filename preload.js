const { contextBridge, ipcRenderer } = require('electron');

// Мост между панелью приложения (ui/) и главным процессом
contextBridge.exposeInMainWorld('bt', {
  getConfig: () => ipcRenderer.invoke('config'),
  navigate: (action, url) => ipcRenderer.send('navigate', action, url),
  copy: (text) => ipcRenderer.send('copy', text),
  onJoin: (callback) => ipcRenderer.on('join', (event, code) => callback(code)),
  onPage: (callback) => ipcRenderer.on('page', (event, page) => callback(page)),

  // Обязательное обновление
  startUpdate: () => ipcRenderer.send('update-start'),
  downloadInstaller: () => ipcRenderer.send('download-installer'),
  onUpdateRequired: (callback) => ipcRenderer.on('update-required', (event, version) => callback(version)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, percent) => callback(percent)),
  onUpdateInstalling: (callback) => ipcRenderer.on('update-installing', () => callback()),
  onUpdateError: (callback) => ipcRenderer.on('update-error', () => callback()),
});
