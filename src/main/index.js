// Filedrawer main process. Owns the windows, the menus, the settings and
// everything that touches the disk. Renderers only draw.
const { app, ipcMain, shell, Menu, BrowserWindow, nativeTheme, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');
const system = require('./system');
const helper = require('./helper');
const folders = require('./folders');
const ops = require('./ops');
const undo = require('./undo');
const copier = require('./copier');

// From the package, not app.getVersion(): Filedrawer.app carries no version
// so it stays the same across updates (see scripts/build-app.js).
const PKG = require('../../package.json');
const VERSION = PKG.version;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Filedrawer');

const windows = new Set();
let cut = null; // { paths, change } after Cut, until a paste moves them or the clipboard changes
let ready = false;
const queued = []; // folders handed over before the app was ready

function state() {
  return {
    settings: settings.get(),
    system: system.snapshot(),
    home: folders.HOME,
    cut: cut ? cut.paths : [],
    computer: folders.COMPUTER,
    user: os.userInfo().username
  };
}

function broadcast(channel, payload) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushState() {
  broadcast('state', state());
}

// A new window sits a little below and right of the window in front, like
// the Mac's own new windows.
function placeFor() {
  const { width, height } = settings.get().window;
  const front = BrowserWindow.getFocusedWindow();
  if (!front || !windows.has(front)) return { width, height };
  const [x, y] = front.getPosition();
  return { width, height, x: x + 22, y: y + 22 };
}

function openWindow(dir) {
  const win = new BrowserWindow({
    ...placeFor(),
    minWidth: 560,
    minHeight: 360,
    show: false,
    title: path.basename(dir) || dir,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 9 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windows.add(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'window', 'index.html'), { query: { path: dir } });
  win.once('ready-to-show', () => win.show());
  // The size of the last window moved or resized is the size of the next one.
  let sizeTimer = null;
  win.on('resize', () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
      const [width, height] = win.getSize();
      settings.update({ window: { width, height } });
    }, 600);
  });
  win.on('focus', buildMenu);
  win.on('closed', () => {
    windows.delete(win);
    unwatch(win);
    buildMenu();
  });
  return win;
}

// Each window watches the folder it shows and is told when something in it
// changes, a moment after the changes stop. Computer watches /Volumes, so
// disks show up and go away. A folder's own watch hears nothing when the
// folder itself is deleted, moved or renamed, so every two seconds the window
// also checks that its folder is still there.
const watchers = new Map(); // window -> { dir, watcher, check, timer }

function unwatch(win) {
  const w = watchers.get(win);
  if (!w) return;
  clearTimeout(w.timer);
  clearInterval(w.check);
  w.watcher.close();
  watchers.delete(win);
}

function watch(win, dir) {
  const w = watchers.get(win);
  if (w && w.dir === dir) return;
  unwatch(win);
  const target = dir === folders.COMPUTER ? '/Volumes' : dir;
  let watcher;
  try {
    watcher = fs.watch(target, { persistent: false });
  } catch {
    return; // a folder that can't be watched is still shown, just not kept up to date
  }
  const entry = { dir, watcher, check: null, timer: null };
  const changed = () => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send('folder:changed', dir);
    }, 250);
  };
  watcher.on('change', changed);
  watcher.on('error', () => unwatch(win));
  entry.check = setInterval(() => {
    fs.access(target, (err) => {
      if (err && err.code === 'ENOENT') changed();
    });
  }, 2000);
  watchers.set(win, entry);
}

// A file handed to Filedrawer opens its folder.
function openPath(p) {
  let dir = p;
  try {
    if (!fs.statSync(p).isDirectory()) dir = path.dirname(p);
  } catch {
    return;
  }
  if (ready) openWindow(dir);
  else queued.push(dir);
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  openPath(p);
});

// Run as plain Electron (no Filedrawer.app), folders come in on the command line.
function argvFolders(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && path.isAbsolute(a));
}

app.on('second-instance', (_e, argv) => {
  const list = argvFolders(argv);
  if (list.length) list.forEach(openPath);
  else openWindow(folders.HOME);
});

// The Dock icon clicked with no windows open.
app.on('activate', () => {
  if (ready && windows.size === 0) openWindow(folders.HOME);
});

// Like other Mac apps, Filedrawer stays open with no windows.
app.on('window-all-closed', () => {});

app.on('will-quit', () => helper.stop());

const THEMES = [['system', 'System'], ['classic-2001', 'Classic 2001']];
const VIEWS = [['thumbs', 'Thumbnails'], ['tiles', 'Tiles'], ['icons', 'Icons'], ['list', 'List'], ['details', 'Details']];
const SORTS = [['name', 'Name'], ['size', 'Size'], ['kind', 'Kind'], ['modified', 'Date Modified']];

function send(command, arg) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && windows.has(win)) win.webContents.send('command', { command, arg });
}

// Opens a folder in the terminal app from the settings, or in Terminal if
// that app isn't there.
function openTerminal(dir) {
  const want = settings.get().terminal || 'Terminal';
  execFile('open', ['-a', want, dir], (err) => {
    if (err && want !== 'Terminal') execFile('open', ['-a', 'Terminal', dir], () => {});
  });
}

function buildMenu() {
  const s = { ...settings.get() };
  const front = BrowserWindow.getFocusedWindow();
  if (front && viewOf.has(front)) Object.assign(s, viewOf.get(front));
  const hasWindow = !!BrowserWindow.getFocusedWindow();
  const labels = undo.labels();
  const cmd = (label, command, accelerator, extra = {}) => ({ label, accelerator, enabled: hasWindow, click: () => send(command), ...extra });
  const template = [
    {
      label: 'Filedrawer',
      submenu: [
        { role: 'about', label: 'About Filedrawer' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Filedrawer' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Filedrawer' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win && windows.has(win)) send('newWindow');
            else openWindow(folders.HOME);
          }
        },
        cmd('Open', 'open', 'CmdOrCtrl+Down'),
        cmd('Open Terminal Here', 'terminal', 'CmdOrCtrl+Alt+T'),
        { type: 'separator' },
        cmd('New Folder', 'newFolder', 'CmdOrCtrl+Shift+N'),
        cmd('New Text Document', 'newText', null),
        cmd('Rename', 'rename', 'F2'),
        cmd('Move to Trash', 'trash', 'CmdOrCtrl+Backspace'),
        { type: 'separator' },
        { role: 'close', label: 'Close Window' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: labels.undo || 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => undoOrType('undo') },
        { label: labels.redo || 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => undoOrType('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => editOrFiles('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => editOrFiles('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => editOrFiles('paste') },
        cmd('Select All', 'selectAll', 'CmdOrCtrl+A')
      ]
    },
    {
      label: 'View',
      submenu: [
        ...VIEWS.map(([view, label], i) => cmd(label, 'view', `CmdOrCtrl+${i + 1}`, {
          type: 'radio', checked: s.view === view, click: () => send('view', view)
        })),
        {
          label: 'Arrange Icons By',
          enabled: hasWindow,
          submenu: SORTS.map(([key, label]) => ({
            label, type: 'radio', checked: s.sort.key === key, click: () => send('sort', key)
          }))
        },
        { type: 'separator' },
        cmd('Folders', 'pane', 'CmdOrCtrl+Shift+F', { type: 'checkbox', checked: s.pane === 'folders' }),
        {
          label: 'Show Hidden Files', accelerator: 'CmdOrCtrl+Shift+.', type: 'checkbox', checked: s.showHidden,
          click: () => settings.update({ showHidden: !settings.get().showHidden })
        },
        {
          label: 'Theme',
          submenu: THEMES.map(([theme, label]) => ({
            label, type: 'radio', checked: s.theme === theme, click: () => settings.update({ theme })
          }))
        },
        { type: 'separator' },
        cmd('Refresh', 'refresh', 'CmdOrCtrl+R'),
        { type: 'separator' },
        cmd('Back', 'back', 'CmdOrCtrl+['),
        cmd('Forward', 'forward', 'CmdOrCtrl+]'),
        cmd('Up One Folder', 'up', 'CmdOrCtrl+Up'),
        cmd('Home', 'home', 'CmdOrCtrl+Shift+H'),
        cmd('Computer', 'computer', 'CmdOrCtrl+Shift+C'),
        cmd('Go to Folder...', 'address', 'CmdOrCtrl+L'),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Pinned',
      submenu: [
        cmd(s.pins.includes(s.cwd) ? 'Unpin This Folder' : 'Pin This Folder', 'pinHere', 'Ctrl+Cmd+T'),
        { type: 'separator' },
        ...(s.pins.length ? s.pins.map((p) => ({
          label: path.basename(p) || p,
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win && windows.has(win)) send('navigate', p);
            else openWindow(p);
          }
        })) : [{ label: 'No Pinned Folders', enabled: false }])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Filedrawer on GitHub', click: () => shell.openExternal(PKG.homepage) },
        { label: 'Report an Issue', click: () => shell.openExternal(PKG.bugs.url) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('state', () => state());
ipcMain.handle('folder:list', (_e, dir, opts) => folders.list(dir, opts));
ipcMain.handle('folder:resolve', (_e, text, cwd) => folders.resolve(text, cwd));
ipcMain.handle('folder:complete', (_e, text, cwd) => folders.complete(text, cwd));
ipcMain.handle('folder:volume', (_e, dir) => folders.volume(dir));
ipcMain.handle('folder:count', (_e, dir, cwd) => folders.count(dir, cwd));
ipcMain.handle('folder:icons', (_e, reqs, px) => folders.icons(reqs, px));
ipcMain.handle('folder:thumbs', (_e, paths, px) => folders.thumbs(paths, px));
ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));
ipcMain.on('open', (_e, p) => shell.openPath(p));

// A file operation's answer. A failure is shown on the window that asked,
// as a sheet, before the answer goes back.
async function answer(e, res) {
  if (res && res.error) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { type: 'warning', message: res.error, buttons: ['OK'] };
    if (win) await dialog.showMessageBox(win, opts);
    else await dialog.showMessageBox(opts);
  }
  return res;
}
// Cut, Copy and Paste go to the window, which works on the text being typed
// or on the selected files. Other windows (a job's) get the text commands.
function editOrFiles(which) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && windows.has(win)) win.webContents.send('command', { command: which });
  else if (win) win.webContents[which]();
}
ipcMain.on('edit:text', (e, which) => {
  if (['cut', 'copy', 'paste'].includes(which)) e.sender[which]();
});

// Files go on the Mac's clipboard the way Finder puts them there, so either
// app can paste them. Cut is remembered here: a paste moves the files as
// long as the clipboard still holds what was cut.
async function putOnClipboard(paths, isCut) {
  const res = await helper.request('clipWrite', { paths });
  cut = isCut && res ? { paths, change: res.change } : null;
  pushState();
}
ipcMain.handle('clip:copy', (_e, paths) => putOnClipboard(paths, false));
ipcMain.handle('clip:cut', (_e, paths) => putOnClipboard(paths, true));

// { paths } of what was pasted, for the window to select.
ipcMain.handle('clip:paste', async (e, dest) => {
  const clip = await helper.request('clipRead');
  if (!clip || !clip.paths.length) return { paths: [] };
  const move = !!cut && clip.change === cut.change;
  const res = await moveOrCopy(e, move ? 'move' : 'copy', clip.paths, dest);
  if (move && res.done.length) {
    cut = null;
    await helper.request('clipWrite', { paths: [] }); // the cut files have gone, like the old windows
    pushState();
  }
  return { paths: res.done.map((d) => d.to) };
});

// Runs a copy or move job, shows its error and puts it on the Undo list.
async function moveOrCopy(e, mode, sources, dest) {
  const near = BrowserWindow.fromWebContents(e.sender);
  const res = await copier.start({ mode, pairs: sources.map((src) => ({ src, target: null })), dest, near });
  if (res.error) await answer(e, { error: res.error });
  if (res.done.length) undo.push(mode === 'copy' ? copyStep(res) : moveStep(res));
  return res;
}

// Undoing a copy puts the copies in the Trash and brings back anything they replaced.
function copyStep(res) {
  const copies = res.done.map((d) => d.to);
  let trashed = [];
  let replaced = res.replaced;
  return {
    label: 'Copy',
    undo: async () => {
      const t = await ops.trash(copies);
      trashed = t.items;
      if (t.error) return t;
      return replaced.length ? ops.untrash(replaced) : {};
    },
    redo: async () => {
      if (replaced.length) replaced = (await ops.trash(replaced.map((r) => r.from))).items;
      return ops.untrash(trashed);
    }
  };
}

// Undoing a move moves everything back, then brings back anything it replaced.
function moveStep(res) {
  const moved = res.done;
  let replaced = res.replaced;
  return {
    label: 'Move',
    undo: async () => {
      const back = await copier.start({ mode: 'move', pairs: moved.map((m) => ({ src: m.to, target: m.from })) });
      if (back.error) return back;
      return replaced.length ? ops.untrash(replaced) : {};
    },
    redo: async () => {
      if (replaced.length) replaced = (await ops.trash(replaced.map((r) => r.from))).items;
      return copier.start({ mode: 'move', pairs: moved.map((m) => ({ src: m.from, target: m.to })) });
    }
  };
}

// Undo and Redo go to the window first, which undoes typing in a name or
// the address bar itself, and asks for the file undo otherwise.
function undoOrType(which) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && windows.has(win)) win.webContents.send('command', { command: which });
  else runUndo(which);
}

async function runUndo(which, e) {
  const res = which === 'redo' ? await undo.redo() : await undo.undo();
  if (res && res.error) {
    if (e) await answer(e, res);
    else await dialog.showMessageBox({ type: 'warning', message: res.error, buttons: ['OK'] });
  }
}
ipcMain.handle('op:undo', (e, which) => runUndo(which, e));

ipcMain.handle('op:rename', async (e, from, name) => {
  const res = await answer(e, await ops.rename(from, name));
  if (res.path && res.path !== from) {
    const to = res.path;
    undo.push({
      label: 'Rename',
      undo: () => ops.rename(to, path.basename(from)),
      redo: () => ops.rename(from, path.basename(to))
    });
  }
  return res;
});

// A new item's undo moves it to the Trash, and its redo takes it out again.
function newItemStep(label, p) {
  let trashed = null;
  return {
    label,
    undo: async () => {
      const res = await ops.trash([p]);
      trashed = res.items;
      return res;
    },
    redo: () => ops.untrash(trashed || [])
  };
}
ipcMain.handle('op:newFolder', async (e, dir) => {
  const res = await answer(e, await ops.newFolder(dir));
  if (res.path) undo.push(newItemStep('New Folder', res.path));
  return res;
});
ipcMain.handle('op:newText', async (e, dir) => {
  const res = await answer(e, await ops.newTextFile(dir));
  if (res.path) undo.push(newItemStep('New Text Document', res.path));
  return res;
});

ipcMain.handle('op:trash', async (e, paths) => {
  const res = await answer(e, await ops.trash(paths));
  if (res.items.length) {
    let items = res.items;
    undo.push({
      label: 'Move to Trash',
      undo: () => ops.untrash(items),
      redo: async () => {
        const again = await ops.trash(items.map((it) => it.from));
        items = again.items;
        return again;
      }
    });
  }
  return res;
});
ipcMain.on('terminal:open', (_e, dir) => openTerminal(dir));
ipcMain.on('window:open', (_e, dir) => openWindow(dir));
ipcMain.on('folder:watch', (e, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) watch(win, dir);
});
// Each window has its own view, left pane and folder, so the menus show the front one's.
const viewOf = new WeakMap();
ipcMain.on('window:view', (e, look) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  viewOf.set(win, look);
  buildMenu();
});
// Finder keeps the Trash to itself, so the Trash opens there.
ipcMain.on('trash:open', () => shell.openPath(path.join(folders.HOME, '.Trash')));
ipcMain.on('window:title', (e, { name, dir }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.setTitle(name);
  win.setRepresentedFilename(dir);
});
// macOS's own pane for folder access, for a folder Filedrawer wasn't allowed into.
ipcMain.on('privacy:open', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'));

app.whenReady().then(() => {
  settings.init();
  helper.start();
  app.setAboutPanelOptions({
    applicationName: 'Filedrawer',
    applicationVersion: VERSION,
    version: '',
    copyright: 'Prather Bytecraft. All rights reserved.'
  });
  settings.onChange(() => {
    pushState();
    buildMenu();
  });
  undo.onChange(buildMenu);
  system.watch(pushState);
  buildMenu();
  ready = true;
  const start = queued.splice(0).concat(argvFolders(process.argv));
  if (start.length) start.forEach(openPath);
  else openWindow(folders.HOME);
});
