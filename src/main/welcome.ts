// The note Filedrawer shows once, on its first launch, as a sheet on its
// first window: it offers to open folders in place of Finder and walks
// through the two permissions that needs. From mockups/default-viewer.html.
import { BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import * as ipc from './ipc';

let sheet: BrowserWindow | null = null;

export function show(parent: BrowserWindow, { onContinue, onClose }: { onContinue: () => void; onClose: () => void }) {
  if (sheet && !sheet.isDestroyed()) return;
  sheet = new BrowserWindow({
    parent,
    modal: true,
    width: 460,
    height: 320,
    useContentSize: true,
    show: false,
    resizable: false,
    // The first click after macOS's Control Finder prompt lands on a button
    // instead of only bringing the sheet back to the front.
    acceptFirstMouse: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  sheet.loadFile(path.join(__dirname, '..', 'renderer', 'welcome', 'index.html'));
  // Still open: closed only comes after ready-to-show.
  sheet.once('ready-to-show', () => sheet!.show());
  sheet.on('closed', () => {
    sheet = null;
  });
  ipcMain.removeAllListeners('welcome');
  ipc.on('welcome', (_e, what) => {
    if (what === 'continue') onContinue();
    else if (sheet && !sheet.isDestroyed()) {
      sheet.close();
      onClose();
    }
  });
}

export const window = () => sheet;
