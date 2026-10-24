// Runs the helper's watch mode (helper/filedrawer-helper.swift, FinderWatcher),
// which tells Filedrawer when Finder opens a folder window so Filedrawer can
// open one in the same spot. Events come in one JSON line each; see the top
// of the helper for the list. The watch comes back after a crash, waiting a
// bit longer each time, and starts again fresh once Accessibility is given.
import { spawn, type ChildProcessByStdio } from 'child_process';
import readline from 'readline';
import type { Readable, Writable } from 'stream';
import { helperPath } from '../scripts/build-helper';
import type { FinderPermission } from '../shared/types';

// The watch's events, one per line.
export interface WindowEvent {
  type: 'window';
  token: number;
  frame: [number, number, number, number];
  title: string;
}

export interface FolderEvent {
  type: 'folder';
  token: number;
  path: string;
}

export interface SkipEvent {
  type: 'skip';
  token: number;
}

interface PermissionEvent {
  type: 'permission';
  accessibility: boolean;
  automation?: string;
}

type FinderEvent = WindowEvent | FolderEvent | SkipEvent | PermissionEvent;

export interface Handlers {
  window?: (msg: WindowEvent) => void;
  folder?: (msg: FolderEvent) => void;
  skip?: (msg: SkipEvent) => void;
  permission?: (permission: FinderPermission) => void;
}

let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
let handlers: Handlers = {};
let stopping = false;
let relaunch = false;
let restarts = 0;
export let permission: FinderPermission = { accessibility: null, automation: 'unknown' };

function onLine(line: string) {
  let msg: FinderEvent;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'permission') {
    const wasOff = permission.accessibility === false;
    permission = { accessibility: !!msg.accessibility, automation: msg.automation || 'unknown' };
    if (handlers.permission) handlers.permission(permission);
    if (wasOff && msg.accessibility) restart();
  } else if (handlers[msg.type]) {
    // The handler for msg's own type.
    (handlers[msg.type] as (m: typeof msg) => void)(msg);
  }
}

// on: { window, folder, skip, permission }, each called with the event.
export function start(on?: Handlers) {
  handlers = on || handlers;
  const bin = helperPath();
  if (!bin || child) return;
  stopping = false;
  const startedAt = Date.now();
  child = spawn(bin, ['watch'], { stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  child.stdin.on('error', () => {}); // the exit handler below covers it
  child.on('error', (err) => console.log(`Filedrawer: the Finder watch did not start: ${err.message}`));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    if (relaunch) {
      relaunch = false;
      restarts = 0;
      return start();
    }
    restarts = Date.now() - startedAt > 60000 ? 0 : restarts + 1;
    const delay = Math.min(30000, 1000 * 2 ** restarts);
    console.log(`Filedrawer: the Finder watch stopped (${signal || code}), starting it again in ${delay / 1000}s.`);
    setTimeout(() => stopping || start(), delay);
  });
}

function restart() {
  if (!child) return;
  relaunch = true;
  child.kill();
}

export function stop() {
  stopping = true;
  if (child) child.kill();
  child = null;
}

function send(cmd: string) {
  if (child) child.stdin.write(JSON.stringify({ cmd }) + '\n');
}

// The next Finder window, in the next few seconds, stays Finder's.
export const pass = () => send('pass');
// Shows macOS's Control Finder prompt, once.
export const askAutomation = () => send('askAutomation');
// Adds Filedrawer to the Accessibility list, switched off, with macOS's note.
export const askAccessibility = () => send('askAccessibility');
export const running = () => !!child;
