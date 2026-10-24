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
import helper = require('./helper');

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
const EDGE = 2; // points from a screen's outer edge that count as against it
const moving = new Map<BrowserWindow, Move>();
const hooked = new WeakSet<BrowserWindow>(); // windows whose blur and close end a move

type Side = 'left' | 'right';
interface Move {
  timer: NodeJS.Timeout;
  side: Side | null; // the edge the pointer is against, while it is
  cut: number; // how much of that half Startbar covers
}

// Frames within a couple of points of each other.
const near = (a: Electron.Rectangle, b: Electron.Rectangle) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

// A window that took half the screen: where it was before, and the half.
const tiled = new WeakMap<BrowserWindow, { from: Electron.Rectangle; to: Electron.Rectangle }>();

// The left or right edge of a screen the pointer is pressed against. An edge
// with another screen beyond it doesn't count, so windows still cross over.
function sideAt(p: Electron.Point): { side: Side; display: Electron.Display } | null {
  const display = screen.getDisplayNearestPoint(p);
  const b = display.bounds;
  const beyond = (x: number) => screen.getAllDisplays().some((d) => d.id !== display.id &&
    x >= d.bounds.x && x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height);
  if (p.x <= b.x + EDGE - 1 && !beyond(b.x - 1)) return { side: 'left', display };
  if (p.x >= b.x + b.width - EDGE && !beyond(b.x + b.width)) return { side: 'right', display };
  return null;
}

function half(side: Side, display: Electron.Display): Electron.Rectangle {
  const a = display.workArea;
  const w = Math.round(a.width / 2);
  return side === 'left' ? { x: a.x, y: a.y, width: w, height: a.height } : { x: a.x + w, y: a.y, width: a.width - w, height: a.height };
}

// The frosted outline of the half a window will take, just under that
// window. The helper draws it (see outline in helper/filedrawer-helper.swift)
// and says how much of the half Startbar's bar covers, which the window
// then leaves out too. Without a helper the window still takes the half.
const INSET = 6;
function showOutline(win: BrowserWindow, move: Move, frame: Electron.Rectangle | null) {
  if (!frame) {
    helper.request('outline', { frame: null });
    return;
  }
  const below = Number(win.getMediaSourceId().split(':')[1]) || 0; // window:<number>:0
  const side = move.side;
  helper.request('outline', { frame, inset: INSET, below }).then((r) => {
    if (r && move.side === side) move.cut = r.cut || 0;
  });
}

// drop: the button came up, so a window against an edge takes that half.
function stop(win: BrowserWindow, drop = false) {
  const move = moving.get(win);
  if (!move) return;
  clearInterval(move.timer);
  moving.delete(win);
  showOutline(win, move, null);
  if (!drop || !move.side || win.isDestroyed()) return;
  const hit = sideAt(screen.getCursorScreenPoint());
  if (!hit || hit.side !== move.side) return;
  const to = half(hit.side, hit.display);
  to.height -= move.cut;
  const was = tiled.get(win);
  tiled.set(win, { from: was ? was.from : win.getBounds(), to });
  win.setBounds(to, true);
}

function start(win: BrowserWindow, x: number, y: number) {
  stop(win);
  // The page's points times its zoom are the window's points.
  const zoom = win.webContents.getZoomFactor();
  const off = { x: x * zoom, y: y * zoom };
  const from = screen.getCursorScreenPoint();
  // A window still on the half it took goes back to its old size once it
  // moves, keeping the pointer at the same share across it.
  const t = tiled.get(win);
  let untile = t && near(win.getBounds(), t.to) ? t.from : null;
  if (t && !untile) tiled.delete(win); // moved or resized since; its old size is no longer wanted
  const canTile = win.isResizable();
  const move: Move = {
    side: null,
    cut: 0,
    timer: setInterval(() => {
      if (win.isDestroyed()) return stop(win);
      const p = screen.getCursorScreenPoint();
      if (untile) {
        if (Math.abs(p.x - from.x) < 4 && Math.abs(p.y - from.y) < 4) return;
        off.x = Math.round(off.x / win.getBounds().width * untile.width);
        win.setBounds({ x: Math.round(p.x - off.x), y: Math.round(p.y - off.y), width: untile.width, height: untile.height });
        tiled.delete(win);
        untile = null;
        return;
      }
      win.setPosition(Math.round(p.x - off.x), Math.round(p.y - off.y));
      const hit = canTile ? sideAt(p) : null;
      const side = hit ? hit.side : null;
      if (side !== move.side) {
        move.side = side;
        move.cut = 0;
        showOutline(win, move, hit ? half(hit.side, hit.display) : null);
      }
    }, STEP)
  };
  moving.set(win, move);
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
    if (win) stop(win, true);
  });
  ipc.on('window:titleDouble', (e) => {
    const win = of(e);
    if (codeDrag && win) titleDouble(win);
  });
}
