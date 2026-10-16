// Builds Filedrawer.app at install time from Electron's own app bundle.
//
// Why: macOS asks for access to Documents, Desktop and Downloads in the
// name of the app bundle, so without this the asks would say Electron. A
// real app bundle also gives Filedrawer its own name in the Dock and the
// menu bar, lets Spotlight find it, and lets it open folders handed to it.
//
// The bundle goes to ~/Applications/Filedrawer.app. It is an APFS clone of
// Electron.app, so it takes no extra disk space. Spotlight does not index
// symlinks, which is why it is a copy and not a link. If ~/Applications can't
// be used, the bundle is built inside the package instead.
//
// The bundle holds no Filedrawer code and no version number.
// Contents/Resources/app is a two file stub that loads src/main from the
// installed package, so an update to the package is picked up as is.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE_ID = 'com.pratherbytecraft.filedrawer';

// Homebrew keeps each version in its own Cellar folder and links the current
// one at opt/filedrawer. The bundle points at the opt path, so it stays the
// same across brew upgrades and macOS keeps the folder access it was given.
function stableRoot(dir) {
  const m = dir.match(/^(.*)\/Cellar\/filedrawer\/[^/]+\/(.*)$/);
  if (!m) return dir;
  const opt = `${m[1]}/opt/filedrawer/${m[2]}`;
  return fs.existsSync(opt) ? opt : dir;
}

const root = stableRoot(path.join(__dirname, '..'));
const mainScript = path.join(root, 'src', 'main', 'index.js');

const userBundle = path.join(os.homedir(), 'Applications', 'Filedrawer.app');
const localBundle = path.join(root, 'bundle', 'Filedrawer.app');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${(res.stderr || res.stdout).trim()}`);
  return res.stdout;
}

function plistValue(bundle, key) {
  const res = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], {
    encoding: 'utf8'
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

// The package a built bundle points at, or null when it isn't one of ours.
function bundleTarget(bundle) {
  try {
    if (plistValue(bundle, 'CFBundleIdentifier') !== BUNDLE_ID) return null;
    const stub = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'));
    return stub.filedrawerPackage || null;
  } catch {
    return null;
  }
}

// The Filedrawer.app built for this package, or null when there isn't one.
function appPath() {
  for (const bundle of [userBundle, localBundle]) {
    if (bundleTarget(bundle) === root) return bundle;
  }
  return null;
}

function electronApp() {
  // require('electron') from Node gives the path to Electron.app/Contents/MacOS/Electron.
  return path.resolve(require('electron'), '..', '..', '..');
}

function pickDest() {
  // Never replace a Filedrawer.app that isn't ours.
  if (fs.existsSync(userBundle) && plistValue(userBundle, 'CFBundleIdentifier') !== BUNDLE_ID) return localBundle;
  try {
    fs.mkdirSync(path.dirname(userBundle), { recursive: true });
    fs.accessSync(path.dirname(userBundle), fs.constants.W_OK);
    return userBundle;
  } catch {
    return localBundle;
  }
}

function writeStub(dest) {
  const stubDir = path.join(dest, 'Contents', 'Resources', 'app');
  fs.mkdirSync(stubDir, { recursive: true });
  const stubPkg = {
    name: 'filedrawer',
    productName: 'Filedrawer',
    private: true,
    main: 'index.js',
    filedrawerPackage: root
  };
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify(stubPkg, null, 2) + '\n');
  fs.writeFileSync(
    path.join(stubDir, 'index.js'),
    `// Written by filedrawer/scripts/build-app.js. Loads Filedrawer from the installed package.
const fs = require('fs');
const target = ${JSON.stringify(mainScript)};
if (fs.existsSync(target)) {
  require(target);
} else {
  const { app, dialog } = require('electron');
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      message: 'Filedrawer is not installed anymore.',
      detail: 'Run npm install -g filedrawer in Terminal to install it again, or move this app to the Trash.'
    });
    app.quit();
  });
}
`
  );
}

function setPlist(dest) {
  const plist = path.join(dest, 'Contents', 'Info.plist');
  const set = (key, type, value) => run('plutil', ['-replace', key, `-${type}`, String(value), plist]);
  set('CFBundleName', 'string', 'Filedrawer');
  set('CFBundleDisplayName', 'string', 'Filedrawer');
  set('CFBundleIdentifier', 'string', BUNDLE_ID);
  set('CFBundleIconFile', 'string', 'Filedrawer.icns');
  set('LSApplicationCategoryType', 'string', 'public.app-category.utilities');
  set('NSHumanReadableCopyright', 'string', 'Prather Bytecraft. All rights reserved.');
  // Shown in macOS's prompt for Control Finder, which Filedrawer uses to ask
  // which folder a new Finder window shows.
  set('NSAppleEventsUsageDescription', 'string', 'Filedrawer asks Finder which folder a new Finder window shows, so it can open that folder itself.');
  // Folders can be opened with Filedrawer, from `filedrawer <folder>` and
  // later as the default folder viewer.
  set('CFBundleDocumentTypes', 'json', JSON.stringify([{
    CFBundleTypeName: 'Folder',
    CFBundleTypeRole: 'Viewer',
    LSHandlerRank: 'Alternate',
    LSItemContentTypes: ['public.folder', 'public.volume']
  }]));
  // Electron asks for these usage strings by default and Filedrawer uses
  // none of them. The version keys go too: the bundle stays the same from one
  // Filedrawer version to the next, so macOS keeps the folder access it gave
  // across updates. Filedrawer reads its version from the package instead.
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription',
    'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'LSUIElement']) {
    spawnSync('plutil', ['-remove', key, plist]);
  }
}

function build({ quiet = false } = {}) {
  if (process.platform !== 'darwin') return null;
  const log = (msg) => quiet || console.log(msg);
  let dest = pickDest();
  try {
    const src = electronApp();
    if (!fs.existsSync(src)) throw new Error(`Electron.app was not found at ${src}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // -c clones on APFS. Other file systems get a plain copy.
    if (spawnSync('cp', ['-cR', src, dest]).status !== 0) run('cp', ['-R', src, dest]);
    fs.copyFileSync(path.join(root, 'assets', 'Filedrawer.icns'), path.join(dest, 'Contents', 'Resources', 'Filedrawer.icns'));
    setPlist(dest);
    writeStub(dest);
    run('codesign', ['--force', '--deep', '--sign', '-', dest]);
    // Tell Spotlight and Launch Services about the new bundle right away.
    spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dest]);
    log(`Filedrawer: app built at ${dest}`);
    return dest;
  } catch (err) {
    log(`Filedrawer: the app bundle was not built, Filedrawer will run as Electron.\n${err.message}`);
    return null;
  }
}

if (require.main === module) build();

module.exports = { build, appPath, BUNDLE_ID };
