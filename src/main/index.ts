// Filedrawer main process. Owns the windows, the menus, the settings and
// everything that touches the disk. Renderers only draw.
import {
  app, shell, Menu, BrowserWindow, nativeTheme, nativeImage, dialog, clipboard,
  type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type MessageBoxOptions, type NativeImage, type Rectangle
} from 'electron';

// Electron reads .asar files as folders. Filedrawer doesn't use any, and
// the ones inside other apps are plain files to list, measure and copy.
process.noAsar = true;
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as settings from './settings';
import * as system from './system';
import helper = require('./helper');
import * as folders from './folders';
import ops = require('./ops');
import * as undo from './undo';
import * as copier from './copier';
import * as props from './props';
import * as prefs from './prefs';
import * as search from './search';
import * as updates from './updates';
import * as finder from './finder';
import * as welcome from './welcome';
import * as chooser from './chooser';
import places = require('./places');
import * as ipc from './ipc';
import type {
  EditCommand, Events, LinkKey, OpResult, PhotosStatus, Settings, Sibling, SiblingKey, State, Theme, TrashedItem, UndoWhich, WatchSlot, WindowLook
} from '../shared/types';

// From the package, not app.getVersion(): Filedrawer.app carries no version
// so it stays the same across updates (see src/scripts/build-app.ts).
import PKG from '../../package.json';
import { BUNDLE_ID } from '../scripts/build-app';
const VERSION = PKG.version;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Filedrawer');

// The line that updates this copy, for the General page: Homebrew keeps
// what it installs in its Cellar folder, npm in a node_modules folder.
const BREW = /\/Cellar\/filedrawer\//.test(fs.realpathSync(__dirname));
const UPDATE_COMMAND = BREW ? 'brew upgrade filedrawer' : 'npm install -g filedrawer';

// A folder window, with what Filedrawer notes on it: when it was last
// placed over a Finder window, and whether its page has drawn.
type FolderWindow = BrowserWindow & { placedAt?: number; drawn?: boolean };

const windows = new Set<FolderWindow>();
let cut: { paths: string[]; change: number } | null = null; // { paths, change } after Cut, until a paste moves them or the clipboard changes
let ready = false;
const queued: [string, string | null][] = []; // folders handed over before the app was ready

function state(): State {
  return {
    settings: settings.get(),
    system: system.snapshot(),
    home: folders.HOME,
    cut: cut ? cut.paths : [],
    computer: folders.COMPUTER,
    trash: places.TRASH,
    recents: places.RECENTS,
    icloud: places.ICLOUD,
    icloudOn: places.icloudOn(),
    user: os.userInfo().username,
    version: VERSION,
    loginItem: prefs.loginItem(),
    update: updates.get(),
    updateCommand: UPDATE_COMMAND,
    themes: THEME_LIST,
    finder: finder.permission,
    photos,
    startbar: startbarInstalled(),
    siblings: siblingsAbout(),
    startFolder: prefs.startFolder()
  };
}

// Prather Bytecraft's other apps, Startbar (the taskbar) and Shotdrawer
// (recent screenshots), when they're installed. Each is found by its bundle
// id, looked up now and then, not on every redraw.
const SIBLINGS: Record<SiblingKey, { id: string; name: string }> = {
  startbar: { id: 'com.pratherbytecraft.startbar', name: 'Startbar.app' },
  shotdrawer: { id: 'com.pratherbytecraft.shotdrawer', name: 'Shotdrawer.app' }
};
const siblingSeen: Partial<Record<SiblingKey, { at: number; path: string | null }>> = {};

function siblingApp(key: SiblingKey) {
  const sib = SIBLINGS[key];
  const seen = siblingSeen[key];
  if (seen && Date.now() - seen.at < 30 * 1000) return seen.path;
  let found: string | null = null;
  for (const p of [path.join(os.homedir(), 'Applications', sib.name), path.join('/Applications', sib.name)]) {
    try {
      const id = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(p, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (id === sib.id) {
        found = p;
        break;
      }
    } catch {
      // not there
    }
  }
  siblingSeen[key] = { at: Date.now(), path: found };
  return found;
}

// Startbar installed: the Default File Manager page points to its own setting.
const startbarInstalled = () => !!siblingApp('startbar');

// The About page's Also from Prather Bytecraft group: each app, whether it's
// installed, and the line that installs it the same way this copy was.
const ABOUT: { key: SiblingKey; name: string; desc: string }[] = [
  { key: 'startbar', name: 'Startbar', desc: 'A taskbar along the bottom of the screen, with a Start menu and a button for every window.' },
  { key: 'shotdrawer', name: 'Shotdrawer', desc: 'Your recent screenshots in the menu bar. Click one to copy its path.' }
];

function siblingsAbout(): Sibling[] {
  return ABOUT.map((a) => ({
    ...a,
    installed: !!siblingApp(a.key),
    line: BREW ? `brew install pratherbytecraft/tap/${a.key}` : `npm install -g ${a.key}`
  }));
}

// Every window that shows settings: the folder windows and the settings window.
function broadcast<K extends keyof Events>(channel: K, ...payload: ipc.Payload<K>) {
  for (const win of windows) if (!win.isDestroyed()) ipc.send(win.webContents, channel, ...payload);
  for (const w of [prefs.window(), welcome.window()]) if (w && !w.isDestroyed()) ipc.send(w.webContents, channel, ...payload);
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

// select, when given, is an item in dir to pick once it's listed.
// A window with wait set opens before its folder is known, at the frame of
// the Finder window it stands in for, and asks for the folder once loaded.
// A spare one loads the same way but stays hidden until it's needed.
function openWindow(dir: string, select?: string | null, { wait = false, spare = false, bounds = null, title = null }: {
  wait?: boolean; spare?: boolean; bounds?: Rectangle | null; title?: string | null;
} = {}) {
  const win: FolderWindow = new BrowserWindow({
    ...(bounds || placeFor()),
    minWidth: 560,
    minHeight: 360,
    show: false,
    title: title || path.basename(dir) || dir,
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
  const query: Record<string, string> = { path: dir };
  if (select) query.select = select;
  if (wait) query.wait = '1';
  win.loadFile(path.join(__dirname, '..', 'renderer', 'window', 'index.html'), { query });
  // A window standing in for Finder's shows once its page has drawn in the
  // theme's colors (the page starts out light), the rest when ready.
  if (wait && !spare) whenDrawn(win, () => showStandIn(win));
  else if (!wait) {
    win.once('ready-to-show', () => {
      win.show();
      maybeWelcome();
    });
  }
  // The size of the last window moved or resized is the size of the next one.
  let sizeTimer: NodeJS.Timeout | undefined;
  win.on('resize', () => {
    if (Date.now() - (win.placedAt || 0) < 1000) return; // sized to a Finder window, not by the user
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
    waiting.delete(win);
    unwatch(win);
    buildMenu();
  });
  return win;
}

// ---------- Finder's new windows open here ----------

// Filedrawer windows standing in for a Finder window, by the helper's token,
// and the folder each is waiting for.
interface Waiting {
  path?: string;
  resolve?: (dir: string) => void;
}

const standIns = new Map<number, FolderWindow>(); // token -> window
const waiting = new Map<BrowserWindow, Waiting>(); // window -> { path, resolve }

// One window is kept loaded and hidden while the takeover is on, so it can
// cover Finder's window within a few frames. A fresh one takes about a
// second to draw.
let spare: FolderWindow | null = null;

function makeSpare() {
  if (spare && !spare.isDestroyed()) return;
  spare = openWindow(folders.HOME, null, { wait: true, spare: true });
}

function dropSpare() {
  if (spare && !spare.isDestroyed()) spare.destroy();
  spare = null;
}

function whenDrawn(win: FolderWindow, fn: () => void) {
  if (win.drawn) fn();
  // drawn is Filedrawer's own event, which BrowserWindow's typed events don't list.
  else (win as NodeJS.EventEmitter).once('drawn', fn);
}

function showStandIn(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  app.focus({ steal: true });
  win.show();
}

function standIn(bounds: Rectangle, title: string) {
  const win = spare && !spare.isDestroyed() ? spare : null;
  spare = null;
  if (!win) return openWindow(folders.HOME, null, { wait: true, bounds, title });
  win.placedAt = Date.now();
  win.setBounds(bounds);
  win.setTitle(title);
  ipc.send(win.webContents, 'command', { command: 'waitTitle', arg: title });
  // Still loading when Finder opened the window: it shows once it's drawn.
  whenDrawn(win, () => showStandIn(win));
  // The next one starts loading now, so folders opened one after another
  // each find one ready.
  setTimeout(() => settings.get().takeOverFinder && makeSpare(), 100);
  return win;
}

function folderFor(win: BrowserWindow, dir: string) {
  const w: Waiting = waiting.get(win) || {};
  if (w.resolve) w.resolve(dir);
  waiting.set(win, { path: dir });
}

const finderEvents: finder.Handlers = {
  window({ token, frame: [x, y, width, height], title }) {
    standIns.set(token, standIn({ x, y, width, height }, title));
  },
  folder({ token, path: dir }) {
    const win = standIns.get(token);
    standIns.delete(token);
    if (win && !win.isDestroyed()) folderFor(win, dir);
  },
  // Not a folder Filedrawer takes: Finder keeps its window.
  skip({ token }) {
    const win = standIns.get(token);
    standIns.delete(token);
    if (win && !win.isDestroyed()) win.destroy();
  },
  permission() {
    pushState();
    maybeWelcome();
  }
};

const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_';

// Show in Finder from other apps (NSFileViewer) follows the same switch.
async function setFileViewer(on: boolean) {
  const res = await helper.request('viewer');
  if (res && (res.fileViewer === BUNDLE_ID) !== on) await helper.request('setViewer', { bundleId: on ? BUNDLE_ID : '' });
}

let takingOver: boolean | null = null;

function watchFinder() {
  const on = settings.get().takeOverFinder;
  if (on) {
    finder.start(finderEvents);
    makeSpare();
  } else {
    finder.stop();
    dropSpare();
  }
  if (on === takingOver) return;
  // Turned on, from the settings page or by the first launch note: it only
  // works while Filedrawer runs, so Filedrawer opens at login from then on.
  if (on && takingOver === false) prefs.setLoginItem(true);
  takingOver = on;
  setFileViewer(on);
}

// The first launch note, once, on the first window, while the takeover is
// on and a permission is missing.
function maybeWelcome() {
  const s = settings.get();
  const p = finder.permission;
  if (s.welcomed || !s.takeOverFinder || p.accessibility === null) return;
  if (p.accessibility && p.automation === 'allowed') {
    settings.update({ welcomed: true });
    return;
  }
  const parent = [...windows].find((w) => w.isVisible() && !w.isDestroyed());
  if (!parent) return;
  settings.update({ welcomed: true });
  welcome.show(parent, {
    onContinue: () => {
      prefs.setLoginItem(true);
      pushState();
      if (!finder.permission.accessibility) shell.openExternal(PRIVACY + 'Accessibility');
      else if (finder.permission.automation !== 'allowed') askAutomation();
    },
    onClose: () => {}
  });
}

function askAutomation() {
  if (finder.permission.automation === 'denied') shell.openExternal(PRIVACY + 'Automation');
  else finder.askAutomation();
}

ipc.on('finder:accessibility', () => shell.openExternal(PRIVACY + 'Accessibility'));
ipc.on('finder:automation', () => askAutomation());

ipc.on('window:drawn', (e) => {
  const win: FolderWindow | null = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.drawn) return;
  win.drawn = true;
  win.emit('drawn');
});

// A waiting window asks for its folder once its page is up. Null closes it.
ipc.handle('window:waitFolder', (e) => {
  // The page asking is a folder window's.
  const win = BrowserWindow.fromWebContents(e.sender)!;
  const w = waiting.get(win);
  if (w && w.path) return w.path;
  return new Promise<string>((resolve) => waiting.set(win, { resolve }));
});

// Each window watches the folder it shows and is told when something in it
// changes, a moment after the changes stop. Computer watches /Volumes, so
// disks show up and go away. A folder's own watch hears nothing when the
// folder itself is deleted, moved or renamed, so every two seconds the window
// also checks that its folder is still there.
interface Watch {
  dir: string;
  watcher: fs.FSWatcher;
  check: NodeJS.Timeout | undefined;
  timer: NodeJS.Timeout | undefined;
}

const watchers = new Map<BrowserWindow, Map<WatchSlot, Watch>>(); // window -> slot -> { dir, watcher, check, timer }

// A window watches its folder (slot main) and, with two panes open, the
// other side's folder (slot other). Without a slot, both stop.
function unwatch(win: BrowserWindow, slot?: WatchSlot) {
  const mine = watchers.get(win);
  if (!mine) return;
  for (const s of slot ? [slot] : [...mine.keys()]) {
    const w = mine.get(s);
    if (!w) continue;
    clearTimeout(w.timer);
    clearInterval(w.check);
    w.watcher.close();
    mine.delete(s);
  }
  if (!mine.size) watchers.delete(win);
}

function watch(win: BrowserWindow, dir: string | null, slot: WatchSlot = 'main') {
  const w = watchers.get(win)?.get(slot);
  if (w && w.dir === dir) return;
  unwatch(win, slot);
  if (!dir) return;
  // Computer watches the disks, the Trash its folder in Home; Recents and
  // iCloud Drive's top aren't watched.
  if (dir === places.RECENTS || dir === places.ICLOUD) return;
  const target = dir === folders.COMPUTER ? '/Volumes' : dir === places.TRASH ? places.HOME_TRASH : dir;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(target, { persistent: false });
  } catch {
    return; // a folder that can't be watched is still shown, just not kept up to date
  }
  const entry: Watch = { dir, watcher, check: undefined, timer: undefined };
  const changed = () => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!win.isDestroyed()) ipc.send(win.webContents, 'folder:changed', dir);
    }, 250);
  };
  watcher.on('change', changed);
  watcher.on('error', () => unwatch(win, slot));
  entry.check = setInterval(() => {
    fs.access(target, (err) => {
      if (err && err.code === 'ENOENT') changed();
    });
  }, 2000);
  if (!watchers.has(win)) watchers.set(win, new Map());
  watchers.get(win)!.set(slot, entry); // made just above when it wasn't there
}

// A file handed to Filedrawer, as other apps' Show in Finder does once
// Filedrawer is the file viewer, opens its folder with it picked.
function openPath(p: string) {
  let dir = p;
  let select: string | null = null;
  try {
    if (!fs.statSync(p).isDirectory() || folders.isPackage(p)) {
      dir = path.dirname(p);
      select = p;
    }
  } catch {
    return;
  }
  if (ready) openWindow(dir, select);
  else queued.push([dir, select]);
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  openPath(p);
});

// Run as plain Electron (no Filedrawer.app), folders come in on the command line.
function argvFolders(argv: string[]) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && path.isAbsolute(a));
}

app.on('second-instance', (_e, argv) => {
  const list = argvFolders(argv);
  if (list.length) list.forEach(openPath);
  else openWindow(prefs.startFolder());
});

// The Dock icon clicked with no windows open.
app.on('activate', () => {
  if (ready && ![...windows].some((w) => w.isVisible())) openWindow(prefs.startFolder());
});

// Like other Mac apps, Filedrawer stays open with no windows.
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  helper.stop();
  finder.stop();
});

const THEMES = [['system', 'System'], ['classic-2009', 'Classic 2009'], ['classic-2001', 'Classic 2001'], ['classic-1995', 'Classic 1995']];
const VIEWS = [['thumbs', 'Thumbnails'], ['tiles', 'Tiles'], ['icons', 'Icons'], ['list', 'List'], ['details', 'Details']];
const SORTS = [['name', 'Name'], ['size', 'Size'], ['kind', 'Kind'], ['modified', 'Date Modified'], ['created', 'Date Created'], ['added', 'Date Added']];

function send(command: string, arg?: string) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && windows.has(win)) ipc.send(win.webContents, 'command', { command, arg });
}

// Opens a folder in the terminal app from the settings, or in Terminal if
// that app isn't there.
// The themes and their color schemes, for the settings window.
const THEME_LIST: Theme[] = [
  { id: 'system', name: 'System', schemes: [] },
  { id: 'classic-2009', name: 'Classic 2009', schemes: [['sky', 'Sky'], ['dusk', 'Dusk'], ['sea', 'Sea'], ['leaf', 'Leaf'], ['lime', 'Lime'],
    ['sun', 'Sun'], ['pumpkin', 'Pumpkin'], ['ruby', 'Ruby'], ['pink', 'Pink'], ['blush', 'Blush'], ['violet', 'Violet'], ['lavender', 'Lavender'],
    ['taupe', 'Taupe'], ['cocoa', 'Cocoa'], ['slate', 'Slate'], ['frost', 'Frost'], ['graphite', 'Graphite']] },
  { id: 'classic-2001', name: 'Classic 2001', schemes: [['blue', 'Blue'], ['olive', 'Olive Green'], ['silver', 'Silver']] },
  { id: 'classic-1995', name: 'Classic 1995', schemes: [['standard', 'Standard'], ['brick', 'Brick'], ['desert', 'Desert'], ['eggplant', 'Eggplant'],
    ['lilac', 'Lilac'], ['maple', 'Maple'], ['marine', 'Marine'], ['plum', 'Plum'], ['pumpkin', 'Pumpkin'], ['rainy', 'Rainy Day'], ['rose', 'Rose'],
    ['slate', 'Slate'], ['spruce', 'Spruce'], ['storm', 'Storm'], ['teal', 'Teal'], ['wheat', 'Wheat']] }
];

function openTerminal(dir: string) {
  const want = settings.get().terminal || 'Terminal';
  execFile('open', ['-a', want, dir], (err) => {
    if (err && want !== 'Terminal') execFile('open', ['-a', 'Terminal', dir], () => {});
  });
}

function buildMenu() {
  const s: Settings & Partial<WindowLook> = { ...settings.get() };
  const front = BrowserWindow.getFocusedWindow();
  if (front && viewOf.has(front)) Object.assign(s, viewOf.get(front));
  const hasWindow = !!BrowserWindow.getFocusedWindow();
  const labels = undo.labels();
  // A null accelerator is none, which Electron takes though its type only lists a string.
  const cmd = (label: string, command: string, accelerator: string | null, extra: MenuItemConstructorOptions = {}): MenuItemConstructorOptions =>
    ({ label, accelerator: accelerator as string, enabled: hasWindow, click: () => send(command), ...extra });
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Filedrawer',
      submenu: [
        { label: 'About Filedrawer', click: () => prefs.show('about') },
        { type: 'separator' },
        { label: 'Settings...', accelerator: 'CmdOrCtrl+,', click: () => prefs.show() },
        { label: 'Check for Updates...', click: () => updates.check(VERSION).then(() => prefs.show('general')) },
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
            else openWindow(prefs.startFolder());
          }
        },
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win && windows.has(win)) send('newTab');
            else openWindow(prefs.startFolder());
          }
        },
        cmd('Open', 'open', 'CmdOrCtrl+Down'),
        cmd('Open Terminal Here', 'terminal', 'CmdOrCtrl+Alt+T'),
        cmd('Find...', 'find', 'CmdOrCtrl+F'),
        { type: 'separator' },
        cmd('New Folder', 'newFolder', 'CmdOrCtrl+Shift+N'),
        cmd('New Text Document', 'newText', null),
        cmd('Rename', 'rename', 'F2'),
        cmd('Duplicate', 'duplicate', 'CmdOrCtrl+D'),
        cmd('Make Alias', 'alias', 'Ctrl+Cmd+A'),
        cmd('Move to Trash', 'trash', 'CmdOrCtrl+Backspace'),
        cmd('Properties', 'props', 'CmdOrCtrl+I'),
        { type: 'separator' },
        // In a Filedrawer window Command W closes the tab (and the window with
        // its last one); other windows, Settings and Properties, just close.
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win && windows.has(win)) send('closeTab');
            else if (win) win.close();
          }
        },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: () => BrowserWindow.getFocusedWindow()?.close() }
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
        cmd('Copy Path', 'copyPath', 'Alt+CmdOrCtrl+C'),
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
            label, type: 'radio', checked: (s.sort || { key: 'name' }).key === key, click: () => send('sort', key)
          }))
        },
        { type: 'separator' },
        cmd('Folders', 'pane', 'CmdOrCtrl+Shift+F', { type: 'checkbox', checked: s.pane === 'folders' }),
        cmd('Two Panes', 'split', 'Alt+CmdOrCtrl+P', { type: 'checkbox', checked: !!s.split }),
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
        ...[['Desktop', 'Shift+D'], ['Documents', 'Shift+O'], ['Downloads', 'Alt+L']].map(([name, keys]) =>
          cmd(name, 'navigate', `CmdOrCtrl+${keys}`, { click: () => send('navigate', path.join(folders.HOME, name)) })),
        cmd('Applications', 'navigate', 'CmdOrCtrl+Shift+A', { click: () => send('navigate', '/Applications') }),
        cmd('Computer', 'computer', 'CmdOrCtrl+Shift+C'),
        cmd('Go to Folder...', 'address', 'CmdOrCtrl+L'),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Pinned',
      submenu: [
        // cwd is unknown until the front window has said.
        cmd((s.pins as (string | undefined)[]).includes(s.cwd) ? 'Unpin This Folder' : 'Pin This Folder', 'pinHere', 'Ctrl+Cmd+T'),
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
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        cmd('Show Previous Tab', 'prevTab', 'Ctrl+Shift+Tab'),
        cmd('Show Next Tab', 'nextTab', 'Ctrl+Tab'),
        { type: 'separator' },
        { role: 'front' }
      ]
    },
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

ipc.handle('state', () => state());
ipc.handle('folder:list', (_e, dir, opts) => folders.list(dir, opts));
ipc.handle('folder:resolve', (_e, text, cwd) => folders.resolve(text, cwd));
ipc.handle('folder:complete', (_e, text, cwd) => folders.complete(text, cwd));
ipc.handle('folder:volume', (_e, dir) => folders.volume(dir));
ipc.handle('folder:count', (_e, dir, cwd) => folders.count(dir, cwd));
ipc.handle('folder:icons', (_e, reqs, px) => folders.icons(reqs, px));
ipc.handle('folder:thumbs', (_e, paths, px) => folders.thumbs(paths, px));
ipc.handle('settings:update', (_e, patch) => settings.update(patch));
ipc.on('open', (_e, p) => (Array.isArray(p) ? execFile('open', p, () => {}) : shell.openPath(p)));

// A file operation's answer. A failure is shown on the window that asked,
// as a sheet, before the answer goes back.
async function answer<T extends { error?: string | null } | null | undefined>(e: IpcMainEvent | IpcMainInvokeEvent, res: T): Promise<T> {
  if (res && res.error) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: MessageBoxOptions = { type: 'warning', message: res.error, buttons: ['OK'] };
    if (win) await dialog.showMessageBox(win, opts);
    else await dialog.showMessageBox(opts);
  }
  return res;
}
// Cut, Copy and Paste go to the window, which works on the text being typed
// or on the selected files. Other windows (a job's) get the text commands.
function editOrFiles(which: EditCommand) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && windows.has(win)) ipc.send(win.webContents, 'command', { command: which });
  else if (win) win.webContents[which]();
}
ipc.on('edit:text', (e, which) => {
  if (['cut', 'copy', 'paste'].includes(which)) e.sender[which]();
});

// Files go on the Mac's clipboard the way Finder puts them there, so either
// app can paste them. Cut is remembered here: a paste moves the files as
// long as the clipboard still holds what was cut.
async function putOnClipboard(paths: string[], isCut: boolean) {
  const res = await helper.request('clipWrite', { paths });
  cut = isCut && res ? { paths, change: res.change } : null;
  pushState();
}
ipc.handle('clip:copy', (_e, paths) => putOnClipboard(paths, false));
ipc.handle('clip:cut', (_e, paths) => putOnClipboard(paths, true));

// { paths } of what was pasted, for the window to select.
ipc.handle('clip:paste', async (e, dest) => {
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

// Dragging items out of a window, as the Mac's own drag with the first
// item's icon under the pointer.
ipc.on('drag:start', async (e, paths) => {
  let icon: NativeImage | null;
  try {
    icon = await app.getFileIcon(paths[0], { size: 'normal' });
  } catch {
    icon = null;
  }
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'Filedrawer.icns'));
  // Every window hears that the drag is Filedrawer's own, so a drop moves
  // it (the Mac reports this drag as copy only, like Photos' drags).
  // startDrag returns when the drag ends.
  const tell = (own: boolean) => BrowserWindow.getAllWindows().forEach((w) => ipc.send(w.webContents, 'drag:own', own));
  tell(true);
  e.sender.startDrag({ file: paths[0], files: paths, icon });
  tell(false);
});

// A drop moves items that are on the same disk as the folder and copies
// the rest, or copies everything with Option held.
ipc.handle('op:drop', async (e, paths, dest, copy) => {
  const destDev = (await fs.promises.stat(dest)).dev;
  const names = await dragNames();
  const moves: copier.Pair[] = [];
  const copies: copier.Pair[] = [];
  const exported: copier.Pair[] = []; // pictures and videos from Photos, written to a temp folder first
  let videoError: string | null = null;
  for (const p of paths) {
    const st = await fs.promises.lstat(p).catch(() => null);
    if (!st) continue;
    const info: Partial<DragName> = names.get(p) || {};
    const isPhoto = info.asset && info.mediaType === 1;
    const isVideo = info.asset && info.mediaType === 2;
    const out = isPhoto || isVideo ? await photoExport(info) : null;
    if (out?.path) {
      exported.push({ src: out.path, target: null, name: path.basename(out.path) });
      continue;
    }
    // A video's file on the drag is only its poster frame, so without the
    // export there's nothing right to copy.
    if (isVideo) {
      videoError = out?.error || videoError;
      continue;
    }
    const pair = { src: p, target: null, name: info.name };
    if (!copy && st.dev === destDev) moves.push(pair);
    else copies.push(pair);
  }
  const done: copier.Done[] = [];
  if (moves.length) done.push(...(await moveOrCopy(e, 'move', moves, dest)).done);
  if (copies.length) done.push(...(await moveOrCopy(e, 'copy', copies, dest)).done);
  if (exported.length) {
    done.push(...(await moveOrCopy(e, 'copy', exported, dest)).done);
    for (const x of exported) fs.promises.rm(path.dirname(x.src), { recursive: true, force: true }).catch(() => {});
  }
  if (videoError) await answer(e, { error: videoError });
  return { paths: done.map((d) => d.to) };
});

// What the dragging app says about its files, by path: the name it suggests
// and, from Photos, the photo's id and whether it's a picture. Photos drags
// its originals, named by id inside its library, so the suggested name is
// the one to use; its extension is dropped for the file's real one, since
// an edited photo's original may be another format.
interface DragName {
  name: string;
  suggested: string;
  asset?: string;
  mediaType?: number;
}

async function dragNames() {
  const names = new Map<string, DragName>();
  const res = await helper.request('dragNames');
  for (const { path: p, name, asset, mediaType } of res?.items || []) {
    const stem = path.basename(name, path.extname(name));
    if (!stem || stem === '.') continue;
    names.set(p, { name: stem + path.extname(p), suggested: name, asset, mediaType });
  }
  return names;
}

// With the Photos permission, a picture or video dropped from Photos comes
// out as its current version, edits and all, the way Finder gets it. The
// file is written to a temp folder and the copy job takes it from there.
// When Photos isn't allowed or the export fails the answer carries the
// reason instead (a picture's original is copied then; a video is skipped,
// since the file on the drag is only its poster frame).
let photos: PhotosStatus = 'unknown';
async function refreshPhotos() {
  const res = await helper.request('photosStatus');
  if (res?.status) photos = res.status;
  return photos;
}
async function photoExport(info: Partial<DragName>): Promise<{ path?: string; error?: string }> {
  if (photos !== 'allowed' && (await refreshPhotos()) !== 'allowed') {
    return { error: 'Filedrawer needs the Photos permission to take a video dropped from Photos. You can allow it on the General page in Settings.' };
  }
  const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'filedrawer-photo-'));
  const res = await helper.request('photoExport', { asset: info.asset, dest: dir, name: info.suggested }, { timeout: 10 * 60 * 1000 });
  if (res?.path) return { path: res.path };
  fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { error: res?.error ? `The video couldn't be taken from Photos. ${res.error}` : "The video couldn't be taken from Photos." };
}

// The Photos row on the General page: macOS's prompt, or Privacy Settings
// once it was declined there.
ipc.on('photos:ask', async () => {
  if ((await refreshPhotos()) === 'denied') {
    shell.openExternal(PRIVACY + 'Photos');
    return;
  }
  const res = await helper.request('askPhotos', {}, { timeout: 10 * 60 * 1000 });
  if (res?.status) photos = res.status;
  pushState();
});
ipc.on('photos:refresh', async () => {
  const was = photos;
  if ((await refreshPhotos()) !== was) pushState();
});

// Runs a copy or move job, shows its error and puts it on the Undo list.
// sources are paths, or pairs with a name for the copy to take.
async function moveOrCopy(e: IpcMainEvent | IpcMainInvokeEvent, mode: 'copy' | 'move', sources: (string | copier.Pair)[], dest: string, label?: string) {
  const near = BrowserWindow.fromWebContents(e.sender);
  const pairs = sources.map((s) => (typeof s === 'string' ? { src: s, target: null } : s));
  const res = await copier.start({ mode, pairs, dest, near });
  if (res.error) await answer(e, { error: res.error });
  if (res.done.length) undo.push(mode === 'copy' ? copyStep(res, label) : moveStep(res));
  return res;
}

// Undoing a copy puts the copies in the Trash and brings back anything they replaced.
function copyStep(res: copier.JobResult, label = 'Copy'): undo.Step {
  const copies = res.done.map((d) => d.to);
  let trashed: TrashedItem[] = [];
  let replaced = res.replaced;
  return {
    label,
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
function moveStep(res: copier.JobResult): undo.Step {
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
function undoOrType(which: UndoWhich) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && windows.has(win)) ipc.send(win.webContents, 'command', { command: which });
  else runUndo(which);
}

async function runUndo(which: UndoWhich, e?: IpcMainInvokeEvent) {
  const res = which === 'redo' ? await undo.redo() : await undo.undo();
  if (res && res.error) {
    if (e) await answer(e, res);
    else await dialog.showMessageBox({ type: 'warning', message: res.error, buttons: ['OK'] });
  }
}
ipc.handle('op:undo', (e, which) => runUndo(which, e));

// Renames and puts it on the Undo list. Used by the window and Properties.
async function renameWithUndo(from: string, name: string): Promise<OpResult> {
  const res = await ops.rename(from, name);
  if (res.path && res.path !== from) {
    const to = res.path;
    undo.push({
      label: 'Rename',
      undo: () => ops.rename(to, path.basename(from)),
      redo: () => ops.rename(from, path.basename(to))
    });
  }
  return res;
}
ipc.handle('op:rename', async (e, from, name) => answer(e, await renameWithUndo(from, name)));
ipc.handle('ask:extension', async (e, was, now) => {
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: 'question',
    message: now ? `Are you sure you want to change the extension from ".${was}" to ".${now}"?` : `Are you sure you want to remove the extension ".${was}"?`,
    detail: 'If you make this change, the file may open in a different app.',
    buttons: [`Keep .${was}`, now ? `Use .${now}` : 'Remove'],
    defaultId: 0,
    cancelId: 0
  });
  return response === 0;
});

// Properties, Open With and Quick Look.
ipc.on('props:open', (e, paths) => props.show(paths, BrowserWindow.fromWebContents(e.sender)));
ipc.handle('openWith:apps', (_e, p) => chooser.appsFor(p));
ipc.on('openWith:open', (_e, appPath, paths) => execFile('open', ['-a', appPath, ...paths], () => {}));
ipc.on('openWith:choose', (e, paths) => chooser.show({ paths, mode: 'choose', near: BrowserWindow.fromWebContents(e.sender) }));
// Space again on the same item closes its preview.
const previewing = new WeakMap(); // window -> the path in Quick Look
ipc.on('quicklook', (e, p) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (!p || previewing.get(win) === p) {
    win.closeFilePreview();
    previewing.delete(win);
  } else {
    win.previewFile(p, path.basename(p));
    previewing.set(win, p);
  }
});

// A new item's undo moves it to the Trash, and its redo takes it out again.
function newItemStep(label: string, p: string): undo.Step {
  let trashed: TrashedItem[] | null = null;
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
ipc.handle('op:newFolder', async (e, dir) => {
  const res = await answer(e, await ops.newFolder(dir));
  if (res.path) undo.push(newItemStep('New Folder', res.path));
  return res;
});
ipc.handle('op:newText', async (e, dir) => {
  const res = await answer(e, await ops.newTextFile(dir));
  if (res.path) undo.push(newItemStep('New Text Document', res.path));
  return res;
});

// Send To: a zip next to the items, aliases on the Desktop, a new mail
// with them attached, or copies in a pinned folder.
ipc.handle('send:zip', async (e, paths) => {
  const res = await answer(e, await ops.compress(paths));
  if (res.path) undo.push(newItemStep('Compress', res.path));
  return res;
});
ipc.handle('send:desktop', async (e, paths) => {
  const desktop = path.join(folders.HOME, 'Desktop');
  for (const p of paths) {
    const res = await answer(e, await ops.alias(p, desktop));
    if (res.error) return res;
    undo.push(newItemStep('Make Alias', res.path as string)); // no error, so the alias was made at path
  }
  return {};
});
ipc.on('send:mail', (_e, paths) => execFile('open', ['-a', 'Mail', ...paths], () => {}));
ipc.handle('send:copy', async (e, paths, dest) => {
  const res = await moveOrCopy(e, 'copy', paths, dest);
  return { paths: res.done.map((d) => d.to) };
});
ipc.handle('op:eject', async (e, volume) => answer(e, await ops.eject(volume)));

// Duplicate copies each item next to itself, named like a paste into the
// same folder ("Copy of X"). Search results can come from several folders.
ipc.handle('op:duplicate', async (e, paths) => {
  const byDir = new Map<string, string[]>();
  for (const p of paths) byDir.set(path.dirname(p), [...(byDir.get(path.dirname(p)) || []), p]);
  const done: copier.Done[] = [];
  for (const [dir, list] of byDir) done.push(...(await moveOrCopy(e, 'copy', list, dir, 'Duplicate')).done);
  return { paths: done.map((d) => d.to) };
});

// Make Alias puts "X alias" next to each item.
ipc.handle('op:alias', async (e, paths) => {
  const made: string[] = [];
  for (const p of paths) {
    const res = await answer(e, await ops.alias(p, path.dirname(p)));
    if (res.error) break;
    // No error, so the alias was made at path.
    undo.push(newItemStep('Make Alias', res.path as string));
    made.push(res.path as string);
  }
  return { paths: made };
});

// Copy Path puts the paths on the clipboard as text, one per line.
ipc.on('clip:path', (_e, paths) => {
  clipboard.writeText(paths.join('\n'));
  if (cut) {
    cut = null;
    pushState();
  }
});

ipc.handle('op:trash', async (e, paths) => {
  if (settings.get().confirmTrash) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const what = paths.length === 1 ? `"${path.basename(paths[0])}"` : `these ${paths.length} items`;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: `Move ${what} to the Trash?`,
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });
    if (response !== 0) return { items: [] };
  }
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
ipc.on('terminal:open', (_e, dir) => openTerminal(dir));
// Show in Finder from other apps: Filedrawer or Finder.
ipc.on('search:start', (e, id, q) => search.start(e.sender, id, q));
ipc.on('search:stop', (e) => search.stop(e.sender));
ipc.on('window:open', (_e, dir) => openWindow(dir));
ipc.on('folder:watch', (e, dir, slot) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) watch(win, dir, slot);
});
// Move to Other Side moves even to another disk.
ipc.handle('op:moveTo', async (e, paths, dest) => {
  const res = await moveOrCopy(e, 'move', paths, dest);
  return { paths: res.done.map((d) => d.to) };
});
// Each window has its own view, left pane and folder, so the menus show the front one's.
const viewOf = new WeakMap<BrowserWindow, WindowLook>();
ipc.on('window:view', (e, look) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  viewOf.set(win, look);
  buildMenu();
});
// Finder keeps the Trash to itself, so the Trash opens there, and Finder
// empties it (Filedrawer can't see inside without Full Disk Access).
ipc.on('trash:open', () => {
  finder.pass();
  shell.openPath(path.join(folders.HOME, '.Trash'));
});
ipc.on('trash:empty', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Are you sure you want to permanently erase the items in the Trash?',
    detail: 'You can\'t undo this action.',
    buttons: ['Empty Trash', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) return;
  execFile('osascript', ['-e', 'tell application "Finder" to empty trash'], (err, _out, stderr) => {
    if (!err) return;
    const message = /-1743/.test(stderr || '') ? 'Filedrawer needs Control Finder to empty the Trash. You can allow it on the Default File Manager page in Settings.'
      : `The Trash couldn't be emptied. ${(stderr || '').trim()}`.trim();
    dialog.showMessageBox(win, { type: 'warning', message, buttons: ['OK'] });
  });
});
ipc.on('window:title', (e, { name, dir }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.setTitle(name);
  win.setRepresentedFilename(dir);
});
// The Trash, shown in Filedrawer once it has Full Disk Access.
ipc.on('privacy:fda', () => shell.openExternal(PRIVACY + 'AllFiles'));
ipc.handle('trash:putBack', async (e, paths) => {
  const res = await places.putBack(paths);
  if (res.done.length) {
    const done = res.done;
    undo.push({
      label: 'Put Back',
      undo: () => places.moveAll(done.map((d) => ({ from: d.to, to: d.from }))),
      redo: () => places.moveAll(done)
    });
  }
  if (res.error) await answer(e, { error: res.error });
  return { paths: res.done.map((d) => d.to) };
});
ipc.handle('trash:delete', async (e, paths) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const what = paths.length === 1 ? `"${path.basename(paths[0])}"` : `these ${paths.length} items`;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: `Are you sure you want to delete ${what}?`,
    detail: paths.length === 1 ? 'This item will be deleted immediately. You can\'t undo this action.' : 'These items will be deleted immediately. You can\'t undo this action.',
    buttons: ['Delete', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) return {};
  return answer(e, await places.deleteNow(paths));
});
// The folder Up goes to from a folder that belongs to a place (the Trash's own folder).
ipc.handle('folder:place', (_e, dir) => places.placeOf(dir));
// macOS's own pane for folder access, for a folder Filedrawer wasn't allowed into.
ipc.on('privacy:open', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'));

app.whenReady().then(() => {
  settings.init();
  helper.start();
  props.init({ rename: renameWithUndo });
  prefs.init({ version: VERSION, onChange: pushState });
  updates.onChange(pushState);
  updates.schedule(VERSION, () => settings.get().updates.auto);
  ipc.on('updates:check', () => updates.check(VERSION));
  ipc.on('clipboard:text', (_e, text) => clipboard.writeText(String(text)));
  ipc.on('settings:open', (_e, page) => prefs.show(page));
  // Starts one of the other apps, or brings it forward when it's running.
  ipc.on('sibling:open', (_e, key) => {
    const at = SIBLINGS[key] && siblingApp(key);
    if (at) execFile('open', ['-a', at], (err) => err && console.log(`Filedrawer: ${key} didn't open: ${err.message}`));
  });
  ipc.on('link', (_e, name) => {
    const links: Record<LinkKey, string> = {
      website: 'https://pratherbytecraft.com',
      github: PKG.homepage,
      community: 'https://www.reddit.com/r/pratherbytecraft/',
      kofi: 'https://ko-fi.com/prathercc',
      issues: PKG.bugs.url
    };
    if (links[name]) shell.openExternal(links[name]);
  });
  app.setAboutPanelOptions({
    applicationName: 'Filedrawer',
    applicationVersion: VERSION,
    version: '',
    copyright: 'Prather Bytecraft. All rights reserved.'
  });
  settings.onChange(() => {
    watchFinder();
    pushState();
    buildMenu();
  });
  undo.onChange(buildMenu);
  system.watch(pushState);
  buildMenu();
  watchFinder();
  ready = true;
  const early = queued.splice(0);
  early.forEach(([dir, select]) => openWindow(dir, select));
  const start = argvFolders(process.argv);
  if (start.length) start.forEach(openPath);
  else if (!early.length && !openedAtLogin()) openWindow(prefs.startFolder());
});

// Opened at login, which Filedrawer does for the Finder takeover (it only
// works while Filedrawer runs): no window until one is asked for, from
// Finder, the Dock icon or a pin.
function openedAtLogin() {
  try {
    return !!app.getLoginItemSettings({ type: 'mainAppService' }).wasOpenedAtLogin;
  } catch {
    return false;
  }
}
