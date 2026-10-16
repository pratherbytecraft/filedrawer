// Filedrawer main process. Owns the windows, the menus, the settings and
// everything that touches the disk. Renderers only draw.
const { app, ipcMain, shell, Menu, BrowserWindow, nativeTheme } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');
const system = require('./system');
const helper = require('./helper');
const folders = require('./folders');

// From the package, not app.getVersion(): Filedrawer.app carries no version
// so it stays the same across updates (see scripts/build-app.js).
const PKG = require('../../package.json');
const VERSION = PKG.version;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Filedrawer');

const windows = new Set();
let ready = false;
const queued = []; // folders handed over before the app was ready

function state() {
  return {
    settings: settings.get(),
    system: system.snapshot(),
    home: folders.HOME,
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
    buildMenu();
  });
  return win;
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
        { role: 'close', label: 'Close Window' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
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
ipcMain.handle('settings:update', (_e, patch) => {
  const s = settings.update(patch);
  if (patch && (patch.view || patch.sort || patch.pane || patch.pins)) buildMenu();
  return s;
});
ipcMain.on('open', (_e, p) => shell.openPath(p));
ipcMain.on('terminal:open', (_e, dir) => openTerminal(dir));
ipcMain.on('window:open', (_e, dir) => openWindow(dir));
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
  settings.onChange(pushState);
  system.watch(pushState);
  buildMenu();
  ready = true;
  const start = queued.splice(0).concat(argvFolders(process.argv));
  if (start.length) start.forEach(openPath);
  else openWindow(folders.HOME);
});
