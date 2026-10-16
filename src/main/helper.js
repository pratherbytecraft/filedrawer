// Talks to the Swift helper (helper/filedrawer-helper.swift), one JSON line
// per request and per reply. The helper runs for the life of the app and
// comes back after a crash, waiting a bit longer each time. Without a
// helper every request answers null and the callers fall back.
const { spawn } = require('child_process');
const { helperPath } = require('../../scripts/build-helper');

const TIMEOUT = 5000;

let child = null;
let buffer = '';
let nextId = 1;
let restartDelay = 500;
const pending = new Map();

// A failed request answers null, or { error } when it was asked with withError.
function finish(id, msg) {
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
  child.stdout.on('data', (chunk) => {
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
function request(cmd, args = {}, { withError = false, timeout = TIMEOUT } = {}) {
  if (!child) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(id, null), timeout);
    pending.set(id, { resolve, timer, withError });
    child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
  });
}

function stop() {
  if (!child) return;
  child.removeAllListeners('exit');
  child.kill();
  child = null;
}

module.exports = { start, request, stop };
