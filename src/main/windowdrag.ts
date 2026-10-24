// Moving windows by their drag areas on macOS 27.2 and later.
//
// On 27.2 the Mac often turns down the drag Chromium asks for when a drag
// area is pressed, so a window stays put for a few seconds after a move
// (Chrome does the same). There the pages make their drag areas no-drag
// and tell main about a press instead, and main moves the window after the
// pointer until the button comes up. Earlier versions keep the Mac's own drag.
// FILEDRAWER_WINDOW_DRAG=code or =mac picks one by hand, for testing.
import { BrowserWindow, screen, systemPreferences } from 'electron';
import * as ipc from './ipc';

function wanted() {
  const forced = process.env.FILEDRAWER_WINDOW_DRAG;
  if (forced === 'code') return true;
  if (forced === 'mac') return false;
  if (process.platform !== 'darwin') return false;
  const [major, minor] = process.getSystemVersion().split('.').map(Number);
  return major > 27 || (major === 27 && minor >= 2);
}

export const codeDrag = wanted();

const STEP = 8; // ms between moves, about two a frame
const moving = new Map<BrowserWindow, NodeJS.Timeout>();
const hooked = new WeakSet<BrowserWindow>(); // windows whose blur and close end a move

function stop(win: BrowserWindow) {
  clearInterval(moving.get(win));
  moving.delete(win);
}

function start(win: BrowserWindow, x: number, y: number) {
  stop(win);
  // The page's points times its zoom are the window's points.
  const zoom = win.webContents.getZoomFactor();
  const off = { x: x * zoom, y: y * zoom };
  moving.set(win, setInterval(() => {
    if (win.isDestroyed()) return stop(win);
    const p = screen.getCursorScreenPoint();
    win.setPosition(Math.round(p.x - off.x), Math.round(p.y - off.y));
  }, STEP));
  if (!hooked.has(win)) {
    hooked.add(win);
    win.on('blur', () => stop(win));
    win.on('closed', () => stop(win));
  }
}

// Zoom the way the Mac does: a window still where zoom put it goes back to
// where it was, any other window fills the screen. Electron's isMaximized
// can't tell, so the frames are kept here.
const zoomed = new WeakMap<BrowserWindow, { from: Electron.Rectangle; to?: Electron.Rectangle }>();
const near = (a: Electron.Rectangle, b: Electron.Rectangle) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

function zoom(win: BrowserWindow) {
  const now = win.getBounds();
  const z = zoomed.get(win);
  if (z && z.to && near(now, z.to)) {
    zoomed.delete(win);
    win.setBounds(z.from, true);
    return;
  }
  const entry: { from: Electron.Rectangle; to?: Electron.Rectangle } = { from: now };
  zoomed.set(win, entry);
  win.maximize();
  // The zoom animates; its frame is read once it has settled.
  setTimeout(() => {
    if (!win.isDestroyed() && zoomed.get(win) === entry) entry.to = win.getBounds();
  }, 600);
}

// What a double click on a title bar does, from Desktop and Dock settings.
function titleDouble(win: BrowserWindow) {
  const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
  const minimize = action === 'Minimize' || (!action && systemPreferences.getUserDefault('AppleMiniaturizeOnDoubleClick', 'boolean'));
  if (action === 'None') return;
  if (minimize) {
    if (win.isMinimizable()) win.minimize();
  } else if (win.isMaximizable() && win.isResizable()) {
    zoom(win);
  }
}

export function init() {
  ipc.handle('window:codeDrag', () => codeDrag);
  const of = (e: Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);
  ipc.on('window:dragStart', (e, x, y) => {
    const win = of(e);
    if (codeDrag && win && Number.isFinite(x) && Number.isFinite(y)) start(win, x, y);
  });
  ipc.on('window:dragEnd', (e) => {
    const win = of(e);
    if (win) stop(win);
  });
  ipc.on('window:titleDouble', (e) => {
    const win = of(e);
    if (codeDrag && win) titleDouble(win);
  });
}
