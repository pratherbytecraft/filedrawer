// A stand-in for Electron in the unit tests, which run in plain Node. Once
// this is loaded, a module that requires 'electron' gets it instead.
// app.getPath('appData') answers with the temp folder from the last
// tempAppData().
import fs from 'fs';
import Module from 'module';
import os from 'os';
import path from 'path';

const paths: Record<string, string> = {};
const made: string[] = [];

export const app = {
  getPath: (name: string) => {
    if (!paths[name]) throw new Error(`no test path for ${name}, call tempAppData() first`);
    return paths[name];
  }
};

// Handlers registered with ipcMain.on, by channel, so a test can send.
type Handler = (...args: unknown[]) => unknown;

export const ipcMain = {
  handlers: {} as Record<string, Handler>,
  on(channel: string, fn: Handler) {
    this.handlers[channel] = fn;
  }
};

// Enough of a window for the copier's progress window. Each one made is
// kept in BrowserWindow.made, with the query it loaded and what it was sent.
export class BrowserWindow {
  static made: BrowserWindow[];
  opts: unknown;
  sent: { channel: string; payload: unknown }[];
  destroyed: boolean;
  listeners: Record<string, Handler>;
  webContents: { isLoading: () => boolean; send: (channel: string, payload: unknown) => void };
  query?: Record<string, string>;
  constructor(opts: unknown) {
    this.opts = opts;
    this.sent = [];
    this.destroyed = false;
    this.listeners = {};
    this.webContents = { isLoading: () => false, send: (channel: string, payload: unknown) => this.sent.push({ channel, payload }) };
    BrowserWindow.made.push(this);
  }
  loadFile(_file: string, { query }: { query?: Record<string, string> } = {}) { this.query = query || {}; }
  once(event: string, fn: () => void) { if (event === 'ready-to-show') fn(); }
  on(event: string, fn: Handler) { this.listeners[event] = fn; }
  removeAllListeners(event: string) { delete this.listeners[event]; }
  show() {}
  close() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
}
BrowserWindow.made = [];

// Named by a path of its own, so the tests run without Electron installed.
const id = path.join(__dirname, 'electron-stand-in.js');
// _resolveFilename is Node's own, left out of its types.
type Resolve = (this: unknown, request: string, ...rest: unknown[]) => string;
const internals = Module as unknown as { _resolveFilename: Resolve };
const resolve = internals._resolveFilename;
internals._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? id : resolve.call(this, request, ...rest);
};
const stub = new Module(id);
stub.filename = id;
stub.loaded = true;
stub.exports = { app, ipcMain, BrowserWindow };
require.cache[id] = stub;

// A new empty folder to stand in for ~/Library/Application Support.
export function tempAppData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filedrawer-test-'));
  made.push(dir);
  paths.appData = dir;
  return dir;
}

process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A new empty folder for a test to work in, gone when the tests end.
export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filedrawer-test-'));
  made.push(dir);
  return dir;
}

