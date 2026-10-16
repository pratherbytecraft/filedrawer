// The Properties window for one or more items: kind, where it is, size and
// size on disk (folders counted in the background), dates, and the Locked
// and Hidden switches. The name can be changed there too.
const { BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const helper = require('./helper');
const folders = require('./folders');
const chooser = require('./chooser');

const open = new Map(); // window id -> { paths, stopped }
let renameItem = null; // (from, name) -> { path } | { error }, with Undo, from index.js

// Adds up a folder's files and folders as it goes, telling onStep now and
// then, and stops when stopped() says so.
async function measure(p, total, onStep, stopped) {
  const st = await fs.promises.lstat(p).catch(() => null);
  if (!st || stopped()) return;
  total.bytes += st.isDirectory() ? 0 : st.size;
  total.disk += st.blocks * 512;
  if (!st.isDirectory()) {
    total.files += 1;
    return;
  }
  total.folders += 1;
  const names = await fs.promises.readdir(p).catch(() => []);
  for (const n of names) {
    await measure(path.join(p, n), total, onStep, stopped);
    if (stopped()) return;
    onStep();
  }
}

async function describe(paths) {
  const items = await Promise.all(paths.map(async (p) => {
    const st = await fs.promises.lstat(p).catch(() => null);
    const info = await helper.request('info', { paths: [p] });
    const i = info && info.items[0];
    return { path: p, st, name: (i && i.name) || path.basename(p), kind: (i && i.kind) || (st && st.isDirectory() ? 'Folder' : 'Document'), package: i && i.package };
  }));
  const first = items[0];
  const icons = await folders.icons([{ key: 'i', path: first.path, ext: '', package: true }], 64);
  const flags = paths.length === 1 ? await helper.request('flags', { path: first.path }) : null;
  // A disk shows how full it is instead of having every file on it counted.
  const volume = paths.length === 1 && (first.path === '/' || /^\/Volumes\/[^/]+$/.test(first.path)) ? await folders.volume(first.path) : null;
  const kinds = new Set(items.map((it) => it.kind));
  const places = new Set(paths.map((p) => path.dirname(p)));
  return {
    one: paths.length === 1,
    name: paths.length === 1 ? (volume && volume.name) || first.name : `${paths.length} items`,
    volume: volume ? { free: volume.free, total: (await helper.request('volume', { path: first.path }) || {}).total || null } : null,
    fullName: path.basename(first.path),
    kind: kinds.size === 1 ? first.kind : 'Multiple kinds',
    location: places.size === 1 ? path.dirname(first.path) : 'More than one folder',
    icon: icons.i,
    folder: items.some((it) => it.st && it.st.isDirectory()),
    created: paths.length === 1 && first.st ? first.st.birthtimeMs : null,
    modified: paths.length === 1 && first.st ? first.st.mtimeMs : null,
    accessed: paths.length === 1 && first.st ? first.st.atimeMs : null,
    locked: flags ? flags.locked : null,
    hidden: flags ? flags.hidden : null,
    opensWith: volume ? null : await chooser.opensWith(paths)
  };
}

function show(paths, near) {
  const opts = {
    width: 380,
    height: 500,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: paths.length === 1 ? `${path.basename(paths[0])} Properties` : 'Properties',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  };
  if (near && !near.isDestroyed()) {
    const b = near.getBounds();
    opts.x = b.x + 60 + open.size * 22;
    opts.y = b.y + 60 + open.size * 22;
  }
  const win = new BrowserWindow(opts);
  const entry = { paths, stopped: false };
  open.set(win.webContents.id, entry);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'props', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    entry.stopped = true;
    open.delete(entry.id);
  });
  entry.id = win.webContents.id;
  return win;
}

ipcMain.handle('props:get', async (e) => {
  const entry = open.get(e.sender.id);
  if (!entry) return null;
  const data = await describe(entry.paths);
  if (data.volume) return data;
  // Sizes come afterwards, counted in the background.
  const total = { bytes: 0, disk: 0, files: 0, folders: 0 };
  let last = 0;
  const report = (done) => {
    if (e.sender.isDestroyed()) return;
    const now = Date.now();
    if (!done && now - last < 200) return;
    last = now;
    e.sender.send('props:size', { ...total, done });
  };
  (async () => {
    for (const p of entry.paths) await measure(p, total, () => report(false), () => entry.stopped);
    report(true);
  })();
  return data;
});

async function setFlags(p, flags) {
  const res = await helper.request('setFlags', { path: p, ...flags });
  return res ? {} : { error: 'The item\'s switches couldn\'t be changed.' };
}

// { error } or {} after setting what changed: the name (through rename, so
// it can be undone) and the switches. A locked item can't be renamed, so an
// unlock comes first and a lock last.
ipcMain.handle('props:apply', async (e, change) => {
  const res = await apply(e, change);
  if (res.error) {
    const win = BrowserWindow.fromWebContents(e.sender);
    await dialog.showMessageBox(win, { type: 'warning', message: res.error, buttons: ['OK'] });
  }
  return res;
});

async function apply(e, change) {
  const entry = open.get(e.sender.id);
  if (!entry || entry.paths.length !== 1) return {};
  let p = entry.paths[0];
  if (change.locked === false) {
    const res = await setFlags(p, { locked: false });
    if (res.error) return res;
  }
  if (change.name !== undefined && renameItem) {
    const res = await renameItem(p, change.name);
    if (res.error) return res;
    entry.paths[0] = p = res.path;
  }
  const rest = {};
  if (change.locked === true) rest.locked = true;
  if (change.hidden !== undefined) rest.hidden = change.hidden;
  return Object.keys(rest).length ? setFlags(p, rest) : {};
}

// Change... next to Opens with: the app list over Properties, and the row
// shows the new app once it's set.
ipcMain.on('props:changeApp', (e) => {
  const entry = open.get(e.sender.id);
  if (!entry) return;
  const sender = e.sender;
  chooser.show({
    paths: entry.paths,
    mode: 'change',
    near: BrowserWindow.fromWebContents(sender),
    onDone: async () => {
      const now = await chooser.opensWith(entry.paths);
      if (!sender.isDestroyed()) sender.send('props:opensWith', now);
    }
  });
});

function init({ rename }) {
  renameItem = rename;
}

module.exports = { show, init };
