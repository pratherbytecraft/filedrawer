// Talks to the Swift helper (helper/filedrawer-helper.swift), one JSON line
// per request and per reply. The helper runs for the life of the app and
// comes back after a crash, waiting a bit longer each time. Without a
// helper every request answers null and the callers fall back.
import { spawn, type ChildProcessByStdio } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Readable, Writable } from 'stream';
import type { AppChoice, PhotosStatus, TrashedItem } from '../shared/types';

// Built at install time by scripts/build-helper.
const HELPER = path.join(__dirname, '..', '..', 'helper', 'filedrawer-helper');
const helperPath = () => (fs.existsSync(HELPER) ? HELPER : null);

const TIMEOUT = 5000;

// What the helper says about one path (info).
interface PathInfo {
  name: string;
  kind: string;
  hidden: boolean;
  package: boolean;
  added?: number;
  alias?: string;
  aliasDir?: boolean;
}

interface VolumeReply {
  name: string;
  free: number;
  total: number;
}

// The answer to each command, by name. Any of them can carry an error
// instead, which comes through when the request was asked with withError.
interface Replies {
  info: { items: PathInfo[] };
  icon: { png: string };
  typeIcon: { png: string };
  thumb: { png: string; width: number; height: number };
  // A path that didn't reach the Trash has no to, and an error.
  trash: { items: { from: string; to?: string; error?: string }[] };
  move: { ok: true };
  clipWrite: { change: number };
  clipRead: { paths: string[]; change: number };
  dragNames: { items: { path: string; name: string; asset?: string; mediaType?: number }[]; change: number };
  photosStatus: { status: PhotosStatus };
  askPhotos: { status: PhotosStatus };
  photoExport: { path: string; type: string };
  openWith: { apps: AppChoice[] };
  setDefault: { ok: true };
  flags: { locked: boolean; hidden: boolean; hideExt: boolean };
  setFlags: { ok: true };
  extra: { version: string; whereFrom: string[]; comment: string };
  lastUsed: { dates: number[] };
  appNames: { names: string[] };
  alias: { ok: true };
  viewer: { fileViewer: string };
  setViewer: { ok: true };
  volume: VolumeReply;
}

interface Failure {
  error?: string;
  // From setDefault, the Cocoa error behind it.
  domain?: string;
  code?: number;
}

type Reply<K extends keyof Replies> = Replies[K] & Failure;

interface Pending {
  resolve: (msg: Reply<keyof Replies> | null) => void;
  timer: NodeJS.Timeout;
  withError: boolean;
}

let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
let buffer = '';
let nextId = 1;
let restartDelay = 500;
const pending = new Map<number, Pending>();

// A failed request answers null, or { error } when it was asked with withError.
function finish(id: number, msg: (Reply<keyof Replies> & { id?: number }) | null) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(msg && msg.error && !p.withError ? null : msg);
}

function start() {
  const bin = helperPath();
  if (!bin || child) return;
  child = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined) finish(msg.id, msg);
      restartDelay = 500;
    }
  });
  child.on('exit', () => {
    child = null;
    buffer = '';
    for (const id of [...pending.keys()]) finish(id, null);
    setTimeout(start, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 30000);
  });
  child.stdin.on('error', () => {}); // the exit handler above covers it
}

// timeout is longer for a request that waits on the user, such as macOS's
// question before a new default app.
function request<K extends keyof Replies>(cmd: K, args: Record<string, unknown> = {}, { withError = false, timeout = TIMEOUT } = {}): Promise<Reply<K> | null> {
  const helper = child;
  if (!helper) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(id, null), timeout);
    // The reply to this id is the reply to cmd.
    pending.set(id, { resolve: resolve as Pending['resolve'], timer, withError });
    helper.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
  });
}

function stop() {
  if (!child) return;
  child.removeAllListeners('exit');
  child.kill();
  child = null;
}

// A plain exports object, the way CommonJS has it, so a unit test can put a
// stand-in in place of one of these functions and the other modules use it.
export = { start, request, stop };
