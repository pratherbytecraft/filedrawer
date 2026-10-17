// Which app opens a file: the app list window behind Change... in
// Properties (sets the default for every file with the extension, or for
// this file only) and Choose App... in Open With (opens the file, and can
// make the app the default too). Apps picked here are remembered for each
// extension, like the old windows, and listed first from then on.
const { BrowserWindow, ipcMain, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const helper = require('./helper');
const folders = require('./folders');
const settings = require('./settings');

const KEEP = 5; // apps remembered for each extension
const open = new Map(); // webContents id -> { paths, mode, onDone }

const extOf = (p) => path.extname(p).slice(1).toLowerCase();

const appName = (p) => path.basename(p).replace(/\.app$/i, '');

function remembered(ext) {
  return (ext && settings.get().openWith[ext]) || [];
}

function remember(ext, appPath) {
  if (!ext) return;
  const all = settings.get().openWith;
  const list = [appPath, ...remembered(ext).filter((p) => p !== appPath)].slice(0, KEEP);
  settings.update({ openWith: { ...all, [ext]: list } });
}

// The apps that can open the file, from Launch Services, with the ones
// picked here before added in (an app from Browse... may not say it can).
async function appsFor(p) {
  const res = await helper.request('openWith', { path: p });
  const apps = res ? res.apps : [];
  const ext = extOf(p);
  for (const r of remembered(ext)) {
    if (!apps.some((a) => a.path === r) && fs.existsSync(r)) apps.push({ path: r, name: appName(r), default: false, claims: false });
  }
  const order = remembered(ext);
  for (const a of apps) a.picked = order.includes(a.path);
  return apps;
}

// The app that opens these files now, for Properties: { path, name, icon },
// or null for folders, apps, disks and a mix of extensions.
async function opensWith(paths) {
  const exts = new Set(paths.map(extOf));
  if (exts.size !== 1) return null;
  for (const p of paths) {
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st || st.isDirectory()) return null;
  }
  const apps = await appsFor(paths[0]);
  const app = apps.find((a) => a.default);
  if (!app) return { path: null, name: 'No app', icon: null };
  const icons = await folders.icons([{ key: 'a', path: app.path, ext: '', package: true }], 32);
  return { path: app.path, name: app.name, icon: icons.a };
}

function show({ paths, mode, near, onDone }) {
  const opts = {
    width: 440,
    height: 460,
    minWidth: 380,
    minHeight: 360,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: mode === 'change' ? 'Change Default App' : 'Open With',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  };
  // Over the window it came from, so it reads as that window's question.
  if (near && !near.isDestroyed()) {
    const b = near.getBounds();
    opts.x = Math.round(b.x + (b.width - opts.width) / 2);
    opts.y = b.y + 40;
    opts.parent = near;
  }
  const win = new BrowserWindow(opts);
  const id = win.webContents.id;
  open.set(id, { paths, mode, onDone });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'chooser', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => open.delete(id));
  return win;
}

ipcMain.handle('chooser:get', async (e) => {
  const entry = open.get(e.sender.id);
  if (!entry) return null;
  const first = entry.paths[0];
  const apps = await appsFor(first);
  const icons = await folders.icons(apps.map((a, i) => ({ key: String(i), path: a.path, ext: '', package: true })), 32);
  apps.forEach((a, i) => { a.icon = icons[String(i)]; });
  const file = await folders.icons([{ key: 'f', path: first, ext: extOf(first) }], 32);
  const info = await helper.request('info', { paths: [first] });
  return {
    mode: entry.mode,
    name: entry.paths.length === 1 ? path.basename(first) : `${entry.paths.length} files`,
    ext: extOf(first),
    kind: (info && info.items[0] && info.items[0].kind) || 'Document',
    icon: file.f,
    apps,
    order: remembered(extOf(first))
  };
});

// An app from anywhere on the Mac, picked in the Mac's own open panel.
ipcMain.handle('chooser:browse', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose an App',
    buttonLabel: 'Choose',
    defaultPath: '/Applications',
    filters: [{ name: 'Applications', extensions: ['app'] }],
    properties: ['openFile']
  });
  const p = !res.canceled && res.filePaths[0];
  if (!p) return null;
  const icons = await folders.icons([{ key: 'a', path: p, ext: '', package: true }], 32);
  return { path: p, name: appName(p), default: false, claims: false, icon: icons.a };
});

// OK: { app, scope } where scope is type (every file like these), file
// (these files only), or open (Choose App... without the box ticked).
ipcMain.handle('chooser:done', async (e, { app, scope }) => {
  const entry = open.get(e.sender.id);
  if (!entry) return {};
  const win = BrowserWindow.fromWebContents(e.sender);
  remember(extOf(entry.paths[0]), app);
  let error = null;
  if (scope === 'type' || scope === 'file') {
    const targets = scope === 'type' ? [entry.paths[0]] : entry.paths;
    for (const p of targets) {
      // For a whole kind macOS asks first, and waits as long as that takes.
      const res = await helper.request('setDefault', { path: p, app, scope }, { withError: true, timeout: 10 * 60 * 1000 });
      // Keep on macOS's question comes back as a plain Cocoa error (256).
      if (res && res.error && res.domain === 'NSCocoaErrorDomain' && res.code === 256) break;
      if (!res || res.error) {
        error = `The default app couldn't be changed. ${res && res.error ? res.error : ''}`.trim();
        break;
      }
    }
  }
  if (error) {
    await dialog.showMessageBox(win, { type: 'warning', message: error, buttons: ['OK'] });
    return { error };
  }
  if (entry.mode === 'choose') execFile('open', ['-a', app, ...entry.paths], () => {});
  if (entry.onDone) entry.onDone();
  win.close();
  return {};
});

module.exports = { show, appsFor, opensWith, remember };
