// The settings window, and what its pages need from the Mac: the terminal
// apps on this Mac, open at login, and export, import and reset.
import { app, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as settings from './settings';
import * as folders from './folders';
import * as ipc from './ipc';
import type { LoginItem, SettingsPage, TerminalApp } from '../shared/types';

let win: BrowserWindow | null = null;
let version = '';

// The terminal apps Open Terminal Here can use, the ones on this Mac only.
const TERMINALS: [string, string[]][] = [
  ['Terminal', ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app']],
  ['iTerm', ['/Applications/iTerm.app']],
  ['Ghostty', ['/Applications/Ghostty.app']],
  ['Warp', ['/Applications/Warp.app']],
  ['Alacritty', ['/Applications/Alacritty.app']],
  ['kitty', ['/Applications/kitty.app']],
  ['WezTerm', ['/Applications/WezTerm.app']]
];

async function terminals(): Promise<TerminalApp[]> {
  const user = path.join(os.homedir(), 'Applications');
  const found: { name: string; path: string }[] = [];
  for (const [name, places] of TERMINALS) {
    const at = [...places, path.join(user, path.basename(places[0]))].find((p) => fs.existsSync(p));
    if (at) found.push({ name, path: at });
  }
  // One picked with Other... shows too.
  const picked = settings.get().terminal;
  if (picked.startsWith('/') && !found.some((t) => t.path === picked) && fs.existsSync(picked)) {
    found.push({ name: path.basename(picked, '.app'), path: picked });
  }
  const icons = await folders.icons(found.map((t) => ({ key: t.path, path: t.path, ext: 'app', package: true })), 64);
  return found.map((t) => ({ ...t, icon: icons[t.path] || null }));
}

export function loginItem(): LoginItem {
  try {
    const { status } = app.getLoginItemSettings({ type: 'mainAppService' });
    return { on: status === 'enabled' || status === 'requires-approval', needsApproval: status === 'requires-approval' };
  } catch {
    return { on: false, needsApproval: false };
  }
}

export function setLoginItem(on: boolean) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, type: 'mainAppService' });
  } catch (err) {
    console.log(`Filedrawer: the login item couldn't be changed: ${(err as Error).message}`);
  }
}

export function show(page?: SettingsPage) {
  if (win && !win.isDestroyed()) {
    if (page) ipc.send(win.webContents, 'settings:page', page);
    win.show();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Filedrawer Settings',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'), page ? { query: { page } } : undefined);
  // Still open: closed only comes after ready-to-show.
  win.once('ready-to-show', () => win!.show());
  win.on('closed', () => {
    win = null;
  });
  return win;
}

async function exportSettings() {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Settings',
    buttonLabel: 'Export',
    defaultPath: path.join(os.homedir(), 'Documents', 'Filedrawer Settings.json'),
    filters: [{ name: 'Filedrawer settings', extensions: ['json'] }]
  });
  if (canceled || !filePath) return;
  fs.writeFileSync(filePath, JSON.stringify({ filedrawer: version, settings: settings.get() }, null, 2) + '\n');
}

async function importSettings() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Settings',
    buttonLabel: 'Import',
    defaultPath: path.join(os.homedir(), 'Documents'),
    properties: ['openFile'],
    filters: [{ name: 'Filedrawer settings', extensions: ['json'] }]
  });
  if (canceled || !filePaths.length) return;
  let data: { settings?: unknown } | null = null;
  try {
    data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  } catch {
    data = null;
  }
  if (!data || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'That file isn\'t a Filedrawer settings file.',
      detail: 'Pick a file made with Export on this page.',
      buttons: ['OK']
    });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Replace your settings and pinned folders?',
    detail: 'Everything on these pages changes to what\'s in the file.',
    buttons: ['Replace', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  });
  if (response === 0) settings.replace(data.settings);
}

async function resetSettings() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Reset all settings?',
    detail: 'Every setting goes back to how it was when Filedrawer was installed. Pinned folders are kept.',
    buttons: ['Reset', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  });
  if (response !== 0) return;
  const { pins } = settings.get();
  settings.reset();
  settings.update({ pins });
}

async function chooseStartFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Start New Windows At',
    buttonLabel: 'Choose',
    defaultPath: settings.get().startPath || os.homedir(),
    properties: ['openDirectory']
  });
  if (!canceled && filePaths[0]) settings.update({ startFolder: 'custom', startPath: filePaths[0] });
}

async function chooseTerminal() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Terminal Here',
    buttonLabel: 'Choose',
    defaultPath: '/Applications',
    filters: [{ name: 'Applications', extensions: ['app'] }],
    properties: ['openFile']
  });
  if (!canceled && filePaths[0]) settings.update({ terminal: filePaths[0] });
}

// The folder a new window starts at.
export function startFolder() {
  const s = settings.get();
  const home = folders.HOME;
  const picks: Record<string, string> = { home, documents: path.join(home, 'Documents'), desktop: path.join(home, 'Desktop'), computer: folders.COMPUTER };
  if (s.startFolder === 'custom' && s.startPath && fs.existsSync(s.startPath)) return s.startPath;
  return picks[s.startFolder] || home;
}

export function init({ version: v, onChange }: { version: string; onChange: () => void }) {
  version = v;
  ipc.handle('settings:terminals', () => terminals());
  ipc.on('settings:login', (_e, on) => {
    setLoginItem(on);
    onChange();
  });
  ipc.on('settings:export', () => exportSettings());
  ipc.on('settings:import', () => importSettings());
  ipc.on('settings:reset', () => resetSettings());
  ipc.on('settings:startFolder', () => chooseStartFolder());
  ipc.on('settings:terminal', () => chooseTerminal());
}

export const window = () => win;
