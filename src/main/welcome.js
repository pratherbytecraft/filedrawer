// The note Filedrawer shows once, on its first launch, as a sheet on its
// first window: it offers to open folders in place of Finder and walks
// through the two permissions that needs. From mockups/default-viewer.html.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let sheet = null;

function show(parent, { onContinue, onClose }) {
  if (sheet && !sheet.isDestroyed()) return;
  sheet = new BrowserWindow({
    parent,
    modal: true,
    width: 460,
    height: 320,
    useContentSize: true,
    show: false,
    resizable: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  sheet.loadFile(path.join(__dirname, '..', 'renderer', 'welcome', 'index.html'));
  sheet.once('ready-to-show', () => sheet.show());
  sheet.on('closed', () => {
    sheet = null;
  });
  ipcMain.removeAllListeners('welcome');
  ipcMain.on('welcome', (_e, what) => {
    if (what === 'continue') onContinue();
    else if (sheet && !sheet.isDestroyed()) {
      sheet.close();
      onClose();
    }
  });
}

module.exports = { show, get window() { return sheet; } };
