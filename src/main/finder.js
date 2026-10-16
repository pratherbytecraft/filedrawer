// Runs the helper's watch mode (helper/filedrawer-helper.swift, FinderWatcher),
// which tells Filedrawer when Finder opens a folder window so Filedrawer can
// open one in the same spot. Events come in one JSON line each; see the top
// of the helper for the list. The watch comes back after a crash, waiting a
// bit longer each time, and starts again fresh once Accessibility is given.
const { spawn } = require('child_process');
const readline = require('readline');
const { helperPath } = require('../../scripts/build-helper');

let child = null;
let handlers = {};
let stopping = false;
let relaunch = false;
let restarts = 0;
let permission = { accessibility: null, automation: 'unknown' };

function onLine(line) {
  let msg;
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
    handlers[msg.type](msg);
  }
}

// on: { window, folder, skip, permission }, each called with the event.
function start(on) {
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

function stop() {
  stopping = true;
  if (child) child.kill();
  child = null;
}

function send(cmd) {
  if (child) child.stdin.write(JSON.stringify({ cmd }) + '\n');
}

module.exports = {
  start,
  stop,
  // The next Finder window, in the next few seconds, stays Finder's.
  pass: () => send('pass'),
  // Shows macOS's Control Finder prompt, once.
  askAutomation: () => send('askAutomation'),
  // Adds Filedrawer to the Accessibility list, switched off, with macOS's note.
  askAccessibility: () => send('askAccessibility'),
  get running() { return !!child; },
  get permission() { return permission; }
};
