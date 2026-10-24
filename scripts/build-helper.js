// Compiles the Swift helper at install time. If swiftc is missing the install
// still succeeds and Filedrawer runs in a reduced way (smaller icons from
// Electron, kinds from the file extension), with a note in the log on how to
// get the full set.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Built into dist/scripts, two folders down from the package.
const root = path.join(__dirname, '..', '..');
const src = path.join(root, 'helper', 'filedrawer-helper.swift');
const out = path.join(root, 'helper', 'filedrawer-helper');

function helperPath() {
  return fs.existsSync(out) ? out : null;
}

function build({ quiet = false } = {}) {
  if (process.platform !== 'darwin') return null;
  const which = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (which.status !== 0) {
    if (!quiet) {
      console.log('Filedrawer: swiftc was not found, so the helper was not built.');
      console.log('Filedrawer: install the Command Line Tools with `xcode-select --install`, then run `npm rebuild -g filedrawer`.');
    }
    return null;
  }
  const res = spawnSync('swiftc', ['-O', '-o', out, src], { encoding: 'utf8' });
  if (res.status !== 0) {
    if (!quiet) console.log('Filedrawer: the helper did not build.\n' + (res.stderr || res.stdout));
    return null;
  }
  if (!quiet) console.log('Filedrawer: helper built.');
  return out;
}

if (require.main === module) build();

module.exports = { build, helperPath };
