import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tempDir } from '../support/electron';
import helper = require('../../src/main/helper');
import places = require('../../src/main/places');
import ops = require('../../src/main/ops');
import type { TrashedItem } from '../../src/shared/types';

// The helper isn't started in the tests, so it answers null like a missing
// one. Tests that need an answer set one here.
const realRequest = helper.request;
type Request = typeof helper.request;
function answer(t: TestContext, fn: (cmd: string, args?: Record<string, unknown>, opts?: Parameters<Request>[2]) => unknown) {
  const asked: Record<string, unknown>[] = [];
  // The stand-in answers whatever the test gives, not the typed reply.
  helper.request = (async (cmd: string, args?: Record<string, unknown>, opts?: Parameters<Request>[2]) => {
    asked.push({ cmd, ...args });
    return fn(cmd, args, opts);
  }) as Request;
  t.after(() => { helper.request = realRequest; });
  return asked;
}

// A temp folder with these files (name -> text) and folders (name ending in /).
function folder(entries: string[] = []) {
  const dir = tempDir();
  for (const e of entries) {
    if (e.endsWith('/')) fs.mkdirSync(path.join(dir, e), { recursive: true });
    else fs.writeFileSync(path.join(dir, e), e);
  }
  return dir;
}

const names = (dir: string) => fs.readdirSync(dir).sort();

// OpResult has path and error both optional. Each test knows which one it
// gets back, hence the ! on them below.

test('freeName numbers a taken name before its extension', async () => {
  const dir = folder(['New Folder/', 'New Text Document.txt', 'New Text Document (2).txt']);
  assert.equal(await ops.freeName(dir, 'Report.pdf'), 'Report.pdf');
  assert.equal(await ops.freeName(dir, 'New Folder'), 'New Folder (2)');
  assert.equal(await ops.freeName(dir, 'New Text Document.txt'), 'New Text Document (3).txt');
});

test('new folders and text files take the next free name', async () => {
  const dir = folder();
  assert.equal(path.basename((await ops.newFolder(dir)).path!), 'New Folder');
  assert.equal(path.basename((await ops.newFolder(dir)).path!), 'New Folder (2)');
  const file = (await ops.newTextFile(dir)).path!;
  assert.equal(path.basename(file), 'New Text Document.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.equal(path.basename((await ops.newTextFile(dir)).path!), 'New Text Document (2).txt');
});

test('making something in a missing folder says so', async () => {
  const res = await ops.newFolder(path.join(tempDir(), 'gone'));
  assert.match(res.error!, /isn't there anymore/);
});

test('rename refuses names macOS cannot take', async () => {
  const dir = folder(['a.txt']);
  const from = path.join(dir, 'a.txt');
  assert.match((await ops.rename(from, '   ')).error!, /can't be empty/);
  assert.match((await ops.rename(from, 'a/b')).error!, /slash/);
  assert.match((await ops.rename(from, '..')).error!, /can't be used/);
  assert.match((await ops.rename(from, 'x'.repeat(256))).error!, /too long/);
  assert.deepEqual(names(dir), ['a.txt']);
});

test('rename moves the item and refuses a name that is taken', async () => {
  const dir = folder(['a.txt', 'b.txt']);
  assert.match((await ops.rename(path.join(dir, 'a.txt'), 'b.txt')).error!, /already an item named "b.txt"/);
  const res = await ops.rename(path.join(dir, 'a.txt'), 'c.txt');
  assert.equal(res.path, path.join(dir, 'c.txt'));
  assert.deepEqual(names(dir), ['b.txt', 'c.txt']);
});

test('a change of capitals only is a rename, not a clash', async () => {
  const dir = folder(['notes.txt']);
  const res = await ops.rename(path.join(dir, 'notes.txt'), 'Notes.txt');
  assert.equal(res.path, path.join(dir, 'Notes.txt'));
  assert.deepEqual(names(dir), ['Notes.txt']);
});

test('the same name is no change, a missing item says so', async () => {
  const dir = folder(['a.txt']);
  assert.deepEqual(await ops.rename(path.join(dir, 'a.txt'), 'a.txt'), { path: path.join(dir, 'a.txt') });
  assert.match((await ops.rename(path.join(dir, 'gone.txt'), 'b.txt')).error!, /isn't there anymore/);
});

test('compress zips one item after its name, and more after the first', async () => {
  const dir = folder(['Report.txt', 'Photos/', 'Photos/one.txt', 'b.txt']);
  const one = await ops.compress([path.join(dir, 'Report.txt')]);
  assert.equal(path.basename(one.path!), 'Report.zip');
  const again = await ops.compress([path.join(dir, 'Report.txt')]);
  assert.equal(path.basename(again.path!), 'Report (2).zip');
  const folderZip = await ops.compress([path.join(dir, 'Photos')]);
  assert.equal(path.basename(folderZip.path!), 'Photos.zip');
  assert.match(execFileSync('unzip', ['-l', folderZip.path!], { encoding: 'utf8' }), /Photos\/one\.txt/);
  const many = await ops.compress([path.join(dir, 'b.txt'), path.join(dir, 'Report.txt')]);
  assert.equal(path.basename(many.path!), 'b.zip');
  const listed = execFileSync('unzip', ['-l', many.path!], { encoding: 'utf8' });
  assert.match(listed, /b\.txt/);
  assert.match(listed, /Report\.txt/);
});

test('trash logs where things came from and names what failed', async (t) => {
  const logged: TrashedItem[] = [];
  const realLog = places.logTrashed;
  places.logTrashed = (items) => logged.push(...items);
  t.after(() => { places.logTrashed = realLog; });
  answer(t, () => ({ items: [
    { from: '/x/a.txt', to: '/t/a.txt' },
    { from: '/x/b.txt', error: 'Locked.' }
  ] }));
  const res = await ops.trash(['/x/a.txt', '/x/b.txt']);
  assert.deepEqual(res.items, [{ from: '/x/a.txt', to: '/t/a.txt' }]);
  assert.equal(res.error, '"b.txt" couldn\'t be moved to the Trash. Locked.');
  assert.deepEqual(logged, [{ from: '/x/a.txt', to: '/t/a.txt' }]);
});

test('trash with no helper says the items stayed', async (t) => {
  answer(t, () => null);
  const res = await ops.trash(['/x/a.txt']);
  assert.match(res.error!, /couldn't be moved to the Trash/);
  assert.deepEqual(res.items, []);
});

test('undoing a trash moves each item back, unless its old spot is taken', async (t) => {
  const dir = folder(['taken.txt']);
  const asked = answer(t, () => ({ ok: true }));
  const items = [{ from: path.join(dir, 'a.txt'), to: '/t/a.txt' }];
  assert.deepEqual(await ops.untrash(items), {});
  assert.deepEqual(asked, [{ cmd: 'move', from: '/t/a.txt', to: path.join(dir, 'a.txt') }]);
  const res = await ops.untrash([{ from: path.join(dir, 'taken.txt'), to: '/t/taken.txt' }]);
  assert.match(res.error!, /already an item named "taken.txt"/);
  assert.equal(asked.length, 1);
});

test('an alias is named "X alias" and reports the helper error', async (t) => {
  const dir = folder(['a.txt', 'a.txt alias']);
  const asked = answer(t, () => ({ error: 'No room.' }));
  const res = await ops.alias('/src/a.txt', dir);
  assert.equal(asked[0].to, path.join(dir, 'a.txt alias (2)'));
  assert.equal(res.error, 'The alias couldn\'t be made. No room.');
});
