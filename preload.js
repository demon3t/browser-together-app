const { contextBridge, ipcRenderer } = require('electron');

// Мост между панелью приложения (ui/) и главным процессом
contextBridge.exposeInMainWorld('bt', {
  getConfig: () => ipcRenderer.invoke('config'),
  navigate: (action, url) => ipcRenderer.send('navigate', action, url),
  onJoin: (callback) => ipcRenderer.on('join', (event, code) => callback(code)),
  onPage: (callback) => ipcRenderer.on('page', (event, page) => callback(page)),
});
