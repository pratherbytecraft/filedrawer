// Filedrawer's helper, asked the same questions the app asks, on temp files.
// The clipboard and the Trash are put back the way they were.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('../support/electron');
const { serve } = require('../support/helper');

const helper = serve();
after(() => helper.stop());

// A temp folder with these files and folders (name ending in /).
function folder(entries = []) {
  const dir = tempDir();
  for (const e of entries) {
    if (e.endsWith('/')) fs.mkdirSync(path.join(dir, e), { recursive: true });
    else fs.writeFileSync(path.join(dir, e), e);
  }
  return dir;
}

const isPng = (b64) => Buffer.from(b64, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

test('info gives names, kinds, hidden and package flags', async () => {
  const dir = folder(['notes.txt', '.secret', 'Sub/', 'Tool.app/']);
  const paths = ['notes.txt', '.secret', 'Sub', 'Tool.app'].map((n) => path.join(dir, n));
  const { items } = await helper.request('info', { paths });
  const [notes, secret, sub, tool] = items;
  assert.equal(notes.name, 'notes.txt');
  assert.match(notes.kind, /text/i);
  assert.equal(notes.hidden, false);
  assert.equal(secret.hidden, true);
  assert.equal(sub.package, false);
  assert.equal(tool.package, true);
  assert.equal(tool.name, 'Tool', 'apps show without .app');
  assert.equal(typeof notes.added, 'number');
});

test('icons come back as PNG pictures, for a file and for a kind', async () => {
  const dir = folder(['a.txt']);
  assert.ok(isPng((await helper.request('icon', { path: path.join(dir, 'a.txt'), size: 32 })).png));
  assert.ok(isPng((await helper.request('typeIcon', { ext: 'pdf', size: 64 })).png));
  assert.equal((await helper.request('icon', { path: path.join(dir, 'gone'), size: 32 })).error, 'no icon');
});

test('thumb gives a picture in the file\'s own shape, and nothing for a file with only an icon', async () => {
  const dir = folder(['notes.txt']);
  const wide = path.join(dir, 'wide.jpg');
  execFileSync('sips', ['-s', 'format', 'jpeg', '-z', '85', '140', '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns', '--out', wide], { stdio: 'ignore' });
  execFileSync('zip', ['-q', 'a.zip', 'notes.txt'], { cwd: dir });
  const pic = await helper.request('thumb', { path: wide, size: 96 });
  assert.ok(isPng(pic.png));
  assert.equal(pic.width, 96);
  assert.ok(pic.height < pic.width, 'a wide picture stays wide');
  assert.equal((await helper.request('thumb', { path: path.join(dir, 'a.zip'), size: 96 })).error, 'no picture');
  assert.equal((await helper.request('thumb', { path: path.join(dir, 'gone.jpg'), size: 96 })).error, 'no picture');
});

test('volume gives the disk name and space', async () => {
  const res = await helper.request('volume', { path: tempDir() });
  assert.ok(res.name.length > 0);
  assert.ok(res.free > 0 && res.total > res.free);
});

test('flags lock, hide and hide the extension, and come off again', async () => {
  const dir = folder(['a.txt']);
  const file = path.join(dir, 'a.txt');
  assert.deepEqual((await helper.request('setFlags', { path: file, locked: true, hideExt: true })).ok, true);
  const flags = await helper.request('flags', { path: file });
  assert.equal(flags.locked, true);
  assert.equal(flags.hideExt, true);
  assert.throws(() => fs.renameSync(file, path.join(dir, 'b.txt')), /EPERM/, 'a locked file stays put');
  assert.equal((await helper.request('info', { paths: [file] })).items[0].name, 'a', 'the extension is hidden');
  await helper.request('setFlags', { path: file, locked: false, hideExt: false });
  const after = await helper.request('flags', { path: file });
  assert.deepEqual([after.locked, after.hidden, after.hideExt], [false, false, false]);
});

test('an alias points back at its item', async () => {
  const dir = folder(['a.txt', 'Sub/']);
  const out = path.join(dir, 'a.txt alias');
  assert.equal((await helper.request('alias', { path: path.join(dir, 'a.txt'), to: out })).ok, true);
  const [info] = (await helper.request('info', { paths: [out] })).items;
  assert.equal(fs.realpathSync(info.alias), fs.realpathSync(path.join(dir, 'a.txt')));
  assert.equal(info.aliasDir, false);
  await helper.request('alias', { path: path.join(dir, 'Sub'), to: path.join(dir, 'Sub alias') });
  assert.equal((await helper.request('info', { paths: [path.join(dir, 'Sub alias')] })).items[0].aliasDir, true);
});

test('open with lists the apps for a file, one of them the default', async () => {
  const dir = folder(['a.txt']);
  const { apps } = await helper.request('openWith', { path: path.join(dir, 'a.txt') });
  assert.ok(apps.length > 0);
  assert.equal(apps.filter((a) => a.default).length, 1);
  assert.ok(apps.some((a) => a.path.endsWith('/TextEdit.app') && a.claims));
});

test('app names, versions and last used dates', async () => {
  assert.deepEqual((await helper.request('appNames', { ids: ['com.apple.TextEdit', 'com.example.not-here'] })).names, ['TextEdit', '']);
  assert.match((await helper.request('extra', { path: '/System/Applications/TextEdit.app' })).version, /^\d/);
  const { dates } = await helper.request('lastUsed', { paths: [path.join(folder(['a']), 'a')] });
  assert.equal(dates.length, 1);
  assert.equal(typeof dates[0], 'number');
});

test('the app Show in Finder uses can be read', async () => {
  assert.equal(typeof (await helper.request('viewer')).fileViewer, 'string');
});

test('an unknown request gets an error', async () => {
  assert.ok((await helper.request('nonsense')).error);
});

// Only plain text on the clipboard can be put back as it was, so anything
// else there means the test steps aside.
const TEXT_TYPES = ['«class utf8»', '«class ut16»', 'string', 'Unicode text', '«class utxt»'];
function clipboardText() {
  const info = execFileSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).trim();
  const types = info ? info.split(', ').filter((_, i) => i % 2 === 0) : [];
  if (types.some((t) => !TEXT_TYPES.includes(t))) return null;
  return execFileSync('pbpaste', { encoding: 'utf8' });
}

test('files go on the clipboard and come back off it', async (t) => {
  const saved = clipboardText();
  if (saved === null) return t.skip('the clipboard holds more than plain text');
  t.after(() => execFileSync('pbcopy', { input: saved }));
  const dir = folder(['a.txt', 'b.txt']);
  const paths = ['a.txt', 'b.txt'].map((n) => path.join(dir, n));
  const wrote = await helper.request('clipWrite', { paths });
  const read = await helper.request('clipRead');
  assert.deepEqual(read.paths.map((p) => fs.realpathSync(p)), paths.map((p) => fs.realpathSync(p)));
  assert.equal(read.change, wrote.change);
});

test('drag names lists the drag pasteboard, empty outside a drag', async () => {
  const res = await helper.request('dragNames');
  assert.ok(Array.isArray(res.items));
  for (const it of res.items) assert.ok(typeof it.path === 'string' && typeof it.name === 'string');
});

test('the Photos permission reads as allowed, denied or unknown', async () => {
  const res = await helper.request('photosStatus');
  assert.ok(['allowed', 'denied', 'unknown'].includes(res.status), res.status);
});

test('an item goes to the Trash and comes back out', async () => {
  const dir = folder();
  const file = path.join(dir, `filedrawer-test-${process.pid}.txt`);
  fs.writeFileSync(file, 'trash me');
  const { items } = await helper.request('trash', { paths: [file, path.join(dir, 'gone.txt')] });
  assert.equal(items[0].from, file);
  assert.match(items[0].to, /\/\.Trash(es)?\//);
  assert.ok(items[1].error, 'a missing item says why');
  assert.equal(fs.existsSync(file), false);
  assert.equal((await helper.request('move', { from: items[0].to, to: file })).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'trash me');
});
