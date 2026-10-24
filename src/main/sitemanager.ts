// Site Manager, the window where SSH sites are made and changed, and the
// sheet that asks for a site's password or a key's passphrase.
import { BrowserWindow, dialog, type BrowserWindowConstructorOptions } from 'electron';
import os from 'os';
import path from 'path';
import * as settings from './settings';
import * as secrets from './secrets';
import * as sites from './sites';
import * as sshconfig from './sshconfig';
import * as ipc from './ipc';
import type { SavedSite, SecretAnswer, SecretAsk, SiteManagerData } from '../shared/types';

const preload = () => path.join(__dirname, '..', 'preload.js');
const page = (name: string) => path.join(__dirname, '..', 'renderer', name, 'index.html');

// ---------- Site Manager ----------

let manager: BrowserWindow | null = null;
let from: BrowserWindow | null = null; // the window it was opened from, where Connect opens a site
let firstPick: string | null = null;
let onConnect: (id: string, win: BrowserWindow | null) => void = () => {};

export function init(opts: { onConnect: (id: string, win: BrowserWindow | null) => void }) {
  onConnect = opts.onConnect;
}

export function show(near: BrowserWindow | null, select: string | null = null) {
  from = near && !near.isDestroyed() ? near : null;
  if (manager && !manager.isDestroyed()) {
    if (select) ipc.send(manager.webContents, 'sites:select', select);
    manager.show();
    manager.focus();
    return manager;
  }
  firstPick = select;
  const opts: BrowserWindowConstructorOptions & { width: number } = {
    width: 720,
    height: 500,
    minWidth: 620,
    minHeight: 440,
    minimizable: false,
    fullscreenable: false,
    show: false,
    title: 'Site Manager',
    webPreferences: { preload: preload(), contextIsolation: true, nodeIntegration: false, sandbox: true }
  };
  if (from) {
    const b = from.getBounds();
    opts.x = Math.round(b.x + (b.width - opts.width) / 2);
    opts.y = b.y + 60;
  }
  const win = new BrowserWindow(opts);
  manager = win;
  win.loadFile(page('sites'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (manager === win) manager = null;
  });
  return win;
}

export const window = () => (manager && !manager.isDestroyed() ? manager : null);

ipc.handle('sites:get', (): SiteManagerData => {
  const s = settings.get();
  const pick = firstPick;
  firstPick = null;
  return {
    saved: s.sites,
    config: sites.info().filter((x) => x.from === 'config'),
    configShown: s.configShown,
    passwords: s.sites.filter((x) => secrets.has(x.id)).map((x) => x.id),
    select: pick
  };
});

// Names stay apart, so a site can be typed by its name in the address bar.
function uniqueNames(list: SavedSite[], taken: string[]) {
  const seen = new Set(taken.map((n) => n.toLowerCase()));
  return list.map((s) => {
    let name = (s.name || s.host).trim();
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${(s.name || s.host).trim()} (${n})`;
    seen.add(name.toLowerCase());
    return { ...s, name };
  });
}

ipc.handle('sites:save', (_e, change) => {
  const config = sshconfig.configHosts().map((h) => h.alias);
  const saved = uniqueNames(change.saved.filter((s) => s.host.trim()), config);
  settings.update({ sites: saved, configShown: change.configShown.filter((a) => config.includes(a)) });
  const ids = saved.map((s) => s.id);
  for (const [id, pw] of Object.entries(change.passwords)) {
    if (!ids.includes(id)) continue;
    if (pw === null) secrets.remove(id);
    else if (pw && !secrets.set(id, pw)) return { error: 'macOS couldn\'t keep the password safe, so it wasn\'t saved.' };
  }
  secrets.keepOnly(ids);
  return {};
});

ipc.handle('sites:browseKey', async (e, current) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const at = current ? current.replace(/^~(?=\/|$)/, os.homedir()) : sshconfig.sshDir();
  const res = await dialog.showOpenDialog(win!, {
    title: 'Choose a Key File',
    buttonLabel: 'Choose',
    defaultPath: at,
    properties: ['openFile', 'showHiddenFiles']
  });
  const p = !res.canceled && res.filePaths[0];
  return p ? p.replace(os.homedir(), '~') : null;
});

ipc.handle('sites:browseLocal', async (e, current) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win!, {
    title: 'Choose a Folder',
    buttonLabel: 'Choose',
    defaultPath: current ? current.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir(),
    properties: ['openDirectory', 'createDirectory']
  });
  const p = !res.canceled && res.filePaths[0];
  return p ? p.replace(os.homedir(), '~') : null;
});

ipc.on('sites:open', (e, select) => show(BrowserWindow.fromWebContents(e.sender), select || null));
ipc.on('sites:connect', (_e, id) => {
  const win = from && !from.isDestroyed() ? from : null;
  if (manager && !manager.isDestroyed()) manager.close();
  onConnect(id, win);
});
ipc.on('sites:close', () => {
  if (manager && !manager.isDestroyed()) manager.close();
});

// ---------- the password sheet ----------

interface Asking {
  ask: SecretAsk;
  done: (answer: SecretAnswer | null) => void;
}
const asking = new Map<number, Asking>(); // webContents id -> its question

// Site Manager or a password sheet: windows where Edit's commands work on the text being typed.
export const typesText = (win: BrowserWindow) => win === window() || asking.has(win.webContents.id);

// Asks for a password or passphrase in a sheet on the window in front.
export function askSecret(ask: SecretAsk): Promise<SecretAnswer | null> {
  const near = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((w) => w.isVisible()) || null;
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 380,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: ask.title,
      parent: near || undefined,
      modal: !!near,
      webPreferences: { preload: preload(), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const id = win.webContents.id;
    let answered = false;
    asking.set(id, {
      ask,
      done: (answer) => {
        if (answered) return;
        answered = true;
        resolve(answer);
        if (!win.isDestroyed()) win.close();
      }
    });
    win.loadFile(page('secret'));
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      asking.delete(id);
      if (!answered) {
        answered = true;
        resolve(null);
      }
    });
  });
}

ipc.handle('secret:get', (e) => {
  const a = asking.get(e.sender.id);
  return a ? a.ask : null;
});
ipc.on('secret:done', (e, answer) => {
  const a = asking.get(e.sender.id);
  if (a) a.done(answer && typeof answer.value === 'string' ? { value: answer.value, save: !!answer.save } : null);
});
