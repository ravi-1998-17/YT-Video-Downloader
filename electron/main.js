const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { execSync } = require('child_process');

let mainWindow;

function killBgProcesses() {
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /IM yt-dlp.exe /T', { stdio: 'ignore' });
    } catch (e) {}
    try {
      execSync('taskkill /F /IM ffmpeg.exe /T', { stdio: 'ignore' });
    } catch (e) {}
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    killBgProcesses();
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  killBgProcesses();
});

app.on('window-all-closed', () => {
  killBgProcesses();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:selectFolder', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:openFolder', async (event, folderPath) => {
  await shell.openPath(folderPath);
});