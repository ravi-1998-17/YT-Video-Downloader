const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: (defaultPath) => ipcRenderer.invoke('dialog:selectFolder', defaultPath),
  openFolder: (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath)
});