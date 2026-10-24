#!/usr/bin/env node
// Launches Filedrawer. `filedrawer` opens a window at the home folder,
// `filedrawer <folder>` opens one at that folder, and both return at once.
// `filedrawer --foreground` keeps it attached to the terminal so its log shows.
//
// Filedrawer.app is opened through Launch Services (`open`), not run
// directly, so macOS treats it as its own app and asks for folder access in
// its name. A folder is handed over the same way, which reaches Filedrawer
// whether it's running already or not.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

if (process.platform !== 'darwin') {
  console.error('Filedrawer runs on macOS only.');
  process.exit(1);
}

import { appPath, build, BUNDLE_ID } from '../scripts/build-app';
import { fix } from '../scripts/fix-electron';
const args = process.argv.slice(2);
const foreground = args.includes('--foreground');
const folders = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));

for (const folder of folders) {
  if (!fs.existsSync(folder)) {
    console.error(`Filedrawer: ${folder} was not found.`);
    process.exit(1);
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function terminalPath() {
  if (!process.stdin.isTTY) return null;
  const res = spawnSync('tty', { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

// Fallback when the bundle wasn't built: plain Electron, shown as Electron.
function runElectron() {
  const electron: string = require('electron'); // the path to the Electron binary when required from Node
  const child = spawn(electron, [path.join(__dirname, '..', '..'), ...folders], {
    detached: !foreground,
    stdio: foreground ? 'inherit' : 'ignore',
    env
  });
  if (foreground) {
    child.on('exit', (code) => process.exit(code ?? 0));
  } else {
    child.unref();
  }
}

function runBundle(bundle: string) {
  const openArgs = ['-a', bundle, ...folders];
  const tty = foreground ? terminalPath() : null;
  if (tty) openArgs.unshift('-W', '--stdout', tty, '--stderr', tty);
  const child = spawn('open', openArgs, { stdio: 'inherit', env });
  if (tty) {
    // Control C quits Filedrawer too, the way it did when it ran in this terminal.
    process.on('SIGINT', () => {
      spawnSync('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);
    });
  }
  child.on('exit', (code) => process.exit(code ?? 0));
}

// The install builds Filedrawer.app, except where it can't write to the home
// folder (Homebrew), or when the app belongs to an older install. Then the
// first run builds it, finishing Electron's install first if it stopped
// partway (see src/scripts/fix-electron.ts).
(async () => {
  let bundle = appPath();
  if (!bundle) {
    console.log('Filedrawer: setting up Filedrawer.app, this takes a moment the first time.');
    await fix({ quiet: true });
    build({ quiet: true });
    bundle = appPath();
  }
  if (bundle) {
    runBundle(bundle);
  } else {
    if (foreground) console.log('Filedrawer: Filedrawer.app was not found, running as Electron. Run `npm run build-app` to build it.');
    runElectron();
  }
})();
