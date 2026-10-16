// Makes sure Electron's own install finished. On recent Node versions
// (26 at least) Electron 33's install stops partway through unzipping
// Electron.app and still reports success, which leaves a 250 KB Electron.app
// and no path.txt. When that happens this unzips Electron's download again
// with macOS's ditto, which keeps the app's links and signature intact, and
// writes the files Electron's install would have written.
//
// npm runs Filedrawer's install script alongside Electron's, not after it,
// so first this waits for Electron's own install to finish. Unzipping over
// an install that's still going breaks both.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXECUTABLE = 'Electron.app/Contents/MacOS/Electron';

function electronDir() {
  return path.dirname(require.resolve('electron/package.json', { paths: [path.join(__dirname, '..')] }));
}

function isWhole(dir) {
  try {
    const { version } = require(path.join(dir, 'package.json'));
    return fs.readFileSync(path.join(dir, 'path.txt'), 'utf8') === EXECUTABLE &&
      fs.readFileSync(path.join(dir, 'dist', 'version'), 'utf8').replace(/^v/, '') === version &&
      fs.existsSync(path.join(dir, 'dist', EXECUTABLE));
  } catch {
    return false;
  }
}

// Whether Electron's own install script (node install.js, run in its
// folder) is still going.
function installRunning(dir) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (ps.status !== 0) return false;
  for (const line of ps.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+\S*node\S*\s+install\.js$/);
    if (!m) continue;
    const cwd = spawnSync('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    if (cwd.status === 0 && cwd.stdout.split('\n').some((l) => l === 'n' + dir)) return true;
  }
  return false;
}

// Electron's script can start a moment after this one, so it gets a few
// seconds to show up before it counts as not running.
async function waitForInstall(dir) {
  const start = Date.now();
  const until = start + 5 * 60 * 1000;
  while (!isWhole(dir) && Date.now() < until) {
    if (!installRunning(dir) && Date.now() - start > 3000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function fix({ quiet = false } = {}) {
  if (process.platform !== 'darwin') return true;
  const log = (msg) => quiet || console.log(msg);
  let dir;
  try {
    dir = electronDir();
  } catch {
    log('Filedrawer: Electron is not installed.');
    return false;
  }
  await waitForInstall(fs.realpathSync(dir));
  if (isWhole(dir)) return true;
  try {
    const { version } = require(path.join(dir, 'package.json'));
    const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [dir] }));
    const zip = await downloadArtifact({
      version,
      artifactName: 'electron',
      platform: 'darwin',
      arch: process.arch,
      cacheRoot: process.env.electron_config_cache,
      checksums: require(path.join(dir, 'checksums.json'))
    });
    const dist = path.join(dir, 'dist');
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    const res = spawnSync('ditto', ['-x', '-k', zip, dist], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(res.stderr || 'ditto did not unzip Electron');
    if (fs.existsSync(path.join(dist, 'electron.d.ts'))) fs.renameSync(path.join(dist, 'electron.d.ts'), path.join(dir, 'electron.d.ts'));
    fs.writeFileSync(path.join(dir, 'path.txt'), EXECUTABLE);
    if (!isWhole(dir)) throw new Error('Electron is still incomplete after unzipping');
    log('Filedrawer: finished installing Electron.');
    return true;
  } catch (err) {
    log(`Filedrawer: Electron did not install completely.\n${err.message}`);
    return false;
  }
}

if (require.main === module) fix();

module.exports = { fix };
