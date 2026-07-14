const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  openFolder: (folderPath) => ipcRenderer.invoke('shell:openFolder', folderPath)
});