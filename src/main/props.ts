// The Properties window for one or more items: kind, the app that opens it
// or an app's version, where it is and where a download came from, size and
// size on disk (folders counted in the background), dates, the Locked,
// Hidden and Hide extension switches, and Finder's comments. The name can be
// changed there too.
import { BrowserWindow, dialog, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron';
import fs from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import helper = require('./helper');
import * as folders from './folders';
import * as chooser from './chooser';
import * as ipc from './ipc';
import type { OpResult, PropsChange, PropsData, PropsSize } from '../shared/types';

interface Entry {
  paths: string[];
  stopped: boolean;
  id?: number;
}

type Totals = Omit<PropsSize, 'done'>;
type Flags = Pick<PropsChange, 'locked' | 'hidden' | 'hideExt'>;

const open = new Map<number, Entry>(); // window id -> { paths, stopped }
let renameItem: ((from: string, name: string) => Promise<OpResult>) | null = null; // (from, name) -> { path } | { error }, with Undo, from index.js

// Adds up a folder's files and folders as it goes, telling onStep now and
// then, and stops when stopped() says so.
async function measure(p: string, total: Totals, onStep: () => void, stopped: () => boolean): Promise<void> {
  const st = await fs.promises.lstat(p).catch(() => null);
  if (!st || stopped()) return;
  total.bytes += st.isDirectory() ? 0 : st.size;
  total.disk += st.blocks * 512;
  if (!st.isDirectory()) {
    total.files += 1;
    return;
  }
  total.folders += 1;
  const names = await fs.promises.readdir(p).catch((): string[] => []);
  for (const n of names) {
    await measure(path.join(p, n), total, onStep, stopped);
    if (stopped()) return;
    onStep();
  }
}

async function describe(paths: string[]): Promise<PropsData> {
  const items = await Promise.all(paths.map(async (p) => {
    const st = await fs.promises.lstat(p).catch(() => null);
    const info = await helper.request('info', { paths: [p] });
    const i = info && info.items[0];
    return { path: p, st, name: (i && i.name) || path.basename(p), kind: (i && i.kind) || (st && st.isDirectory() ? 'Folder' : 'Document'), package: i && i.package };
  }));
  const first = items[0];
  const icons = await folders.icons([{ key: 'i', path: first.path, ext: '', package: true }], 64);
  const flags = paths.length === 1 ? await helper.request('flags', { path: first.path }) : null;
  const extra = paths.length === 1 ? await helper.request('extra', { path: first.path }) : null;
  // A disk shows how full it is instead of having every file on it counted.
  const volume = paths.length === 1 && (first.path === '/' || /^\/Volumes\/[^/]+$/.test(first.path)) ? await folders.volume(first.path) : null;
  const kinds = new Set(items.map((it) => it.kind));
  const places = new Set(paths.map((p) => path.dirname(p)));
  return {
    one: paths.length === 1,
    name: paths.length === 1 ? (volume && volume.name) || first.name : `${paths.length} items`,
    volume: volume ? { free: volume.free, total: (await helper.request('volume', { path: first.path }))?.total || null } : null,
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
    // Hide extension, for an item with one that isn't a plain folder.
    hideExt: flags && path.extname(first.path) && !(first.st && first.st.isDirectory() && !first.package) ? flags.hideExt : null,
    version: extra ? extra.version : '',
    whereFrom: extra ? extra.whereFrom : [],
    comment: extra ? extra.comment : null,
    opensWith: volume ? null : await chooser.opensWith(paths)
  };
}

export function show(paths: string[], near: BrowserWindow | null) {
  const opts: BrowserWindowConstructorOptions = {
    width: 400,
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
  const entry: Entry = { paths, stopped: false };
  open.set(win.webContents.id, entry);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'props', 'index.html'));
  // Shown once it's sized to what it shows (props:fit), or after a moment.
  win.once('ready-to-show', () => setTimeout(() => !win.isDestroyed() && win.show(), 800));
  win.on('closed', () => {
    entry.stopped = true;
    open.delete(entry.id as number); // set just below, before the window can close
  });
  entry.id = win.webContents.id;
  return win;
}

ipc.handle('props:get', async (e) => {
  const entry = open.get(e.sender.id);
  if (!entry) return null;
  const data = await describe(entry.paths);
  if (data.volume) return data;
  // Sizes come afterwards, counted in the background.
  const total = { bytes: 0, disk: 0, files: 0, folders: 0 };
  let last = 0;
  const report = (done: boolean) => {
    if (e.sender.isDestroyed()) return;
    const now = Date.now();
    if (!done && now - last < 200) return;
    last = now;
    ipc.send(e.sender, 'props:size', { ...total, done });
  };
  (async () => {
    for (const p of entry.paths) await measure(p, total, () => report(false), () => entry.stopped);
    report(true);
  })();
  return data;
});

async function setFlags(p: string, flags: Flags): Promise<OpResult> {
  const res = await helper.request('setFlags', { path: p, ...flags });
  return res ? {} : { error: 'The item\'s switches couldn\'t be changed.' };
}

// { error } or {} after setting what changed: the name (through rename, so
// it can be undone) and the switches. A locked item can't be renamed, so an
// unlock comes first and a lock last.
ipc.handle('props:apply', async (e, change) => {
  const res = await apply(e, change);
  if (res.error) {
    const win = BrowserWindow.fromWebContents(e.sender);
    await dialog.showMessageBox(win, { type: 'warning', message: res.error, buttons: ['OK'] });
  }
  return res;
});

async function apply(e: IpcMainInvokeEvent, change: PropsChange): Promise<OpResult> {
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
    entry.paths[0] = p = res.path as string; // no error, so the rename gave its path
  }
  if (change.comment !== undefined) {
    const res = await setComment(p, change.comment);
    if (res.error) return res;
  }
  const rest: Flags = {};
  if (change.locked === true) rest.locked = true;
  if (change.hidden !== undefined) rest.hidden = change.hidden;
  if (change.hideExt !== undefined) rest.hideExt = change.hideExt;
  return Object.keys(rest).length ? setFlags(p, rest) : {};
}

// Comments are Finder's, set through Finder so its Get Info shows the same.
function setComment(p: string, text: string) {
  const script = ['on run argv', 'tell application "Finder" to set comment of (POSIX file (item 1 of argv) as alias) to (item 2 of argv)', 'end run'];
  return new Promise<OpResult>((resolve) => {
    execFile('osascript', [...script.flatMap((l) => ['-e', l]), p, text], (err, _out, stderr) => {
      if (!err) return resolve({});
      if (/-1743/.test(stderr || '')) resolve({ error: 'Filedrawer needs Control Finder to change comments. You can allow it on the Default File Manager page in Settings.' });
      else resolve({ error: `The comment couldn't be saved. ${(stderr || '').trim()}`.trim() });
    });
  });
}

ipc.on('props:fit', (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !open.has(e.sender.id)) return;
  const [width] = win.getContentSize();
  win.setContentSize(width, Math.max(300, Math.min(760, Math.ceil(height))));
  if (!win.isVisible()) win.show();
});

// Change... next to Opens with: the app list over Properties, and the row
// shows the new app once it's set.
ipc.on('props:changeApp', (e) => {
  const entry = open.get(e.sender.id);
  if (!entry) return;
  const sender = e.sender;
  chooser.show({
    paths: entry.paths,
    mode: 'change',
    near: BrowserWindow.fromWebContents(sender),
    onDone: async () => {
      const now = await chooser.opensWith(entry.paths);
      if (!sender.isDestroyed()) ipc.send(sender, 'props:opensWith', now);
    }
  });
});

export function init({ rename }: { rename: (from: string, name: string) => Promise<OpResult> }) {
  renameItem = rename;
}

