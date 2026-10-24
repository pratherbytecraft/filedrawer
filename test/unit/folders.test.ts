import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tempDir } from '../support/electron';
import places = require('../../src/main/places');
import * as folders from '../../src/main/folders';
import type { Item, Listing } from '../../src/shared/types';

type FolderListing = Extract<Listing, { error?: undefined }>;

// The helper isn't started in the tests, so kinds and names come from
// Filedrawer's own fallbacks, as they do when the helper is missing.

// A temp folder with these files (name -> text) and folders (name ending in /).
function folder(entries: string[] = []) {
  const dir = tempDir();
  for (const e of entries) {
    if (e.endsWith('/')) fs.mkdirSync(path.join(dir, e), { recursive: true });
    else fs.writeFileSync(path.join(dir, e), 'x'.repeat(e.length));
  }
  return dir;
}

const byName = (items: Item[]) => Object.fromEntries(items.map((it) => [it.name, it]));

test('a folder lists its items with kinds, sizes and folder flags', async () => {
  const dir = folder(['notes.txt', 'photo.JPG', 'data.xyz', 'README', 'Sub/', 'Tool.app/']);
  // A folder that lists has no error, so it's the listing half of the type.
  const res = (await folders.list(dir)) as FolderListing;
  assert.equal(res.path, dir);
  assert.equal(res.writable, true);
  const it = byName(res.items);
  assert.deepEqual(Object.keys(it).sort(), ['README', 'Sub', 'Tool.app', 'data.xyz', 'notes.txt', 'photo.JPG']);
  assert.equal(it['notes.txt'].kind, 'Plain Text Document');
  assert.equal(it['notes.txt'].size, 'notes.txt'.length);
  assert.equal(it['photo.JPG'].ext, 'jpg');
  assert.equal(it['photo.JPG'].kind, 'JPEG Image');
  assert.equal(it['data.xyz'].kind, 'XYZ File');
  assert.equal(it.README.kind, 'Document');
  assert.equal(it.Sub.dir, true);
  assert.equal(it.Sub.kind, 'Folder');
  assert.equal(it.Sub.size, null);
  assert.equal(it.Sub.canAdd, true);
  assert.equal(it['Tool.app'].package, true);
  assert.equal(it['Tool.app'].kind, 'Application');
  assert.equal(it['notes.txt'].fixed, false);
});

test('hidden items show only when asked', async () => {
  const dir = folder(['.secret', 'shown.txt']);
  // These folders list, so items is there.
  assert.deepEqual((await folders.list(dir)).items!.map((i) => i.name), ['shown.txt']);
  assert.deepEqual((await folders.list(dir, { hidden: true })).items!.map((i) => i.name).sort(), ['.secret', 'shown.txt']);
});

test('a link to a folder lists as a folder', async () => {
  const dir = folder(['Real/']);
  fs.symlinkSync(path.join(dir, 'Real'), path.join(dir, 'Link'));
  const it = byName((await folders.list(dir)).items!); // the folder lists
  assert.equal(it.Link.link, true);
  assert.equal(it.Link.dir, true);
});

test('a missing folder answers missing', async () => {
  const res = await folders.list(path.join(tempDir(), 'gone'));
  assert.equal(res.error, 'missing');
});

test('count leaves out hidden items and skips guarded folders', async () => {
  const dir = folder(['a', 'b', '.c', 'D/']);
  assert.equal(await folders.count(dir, os.tmpdir()), 3);
  // count reads a missing cwd as none; its type asks for one.
  assert.equal(await (folders.count as (dir: string, cwd?: string) => Promise<number | null>)(path.join(dir, 'gone')), null);
  const desktop = path.join(os.homedir(), 'Desktop');
  assert.equal(await folders.count(desktop, os.homedir()), null, 'not counted from outside');
});

test('an address resolves from the open folder, home, quotes and file links', async () => {
  const dir = folder(['Sub/', 'file.txt']);
  assert.deepEqual(await folders.resolve('Sub', dir), { type: 'dir', path: path.join(dir, 'Sub') });
  assert.deepEqual(await folders.resolve('file.txt', dir), { type: 'file', path: path.join(dir, 'file.txt') });
  assert.deepEqual(await folders.resolve(`"${dir}/Sub"`, '/'), { type: 'dir', path: path.join(dir, 'Sub') });
  assert.deepEqual(await folders.resolve('file://' + encodeURI(path.join(dir, 'Sub')), '/'), { type: 'dir', path: path.join(dir, 'Sub') });
  assert.deepEqual(await folders.resolve('~', dir), { type: 'dir', path: os.homedir() });
  assert.deepEqual(await folders.resolve('nope', dir), { type: 'missing', path: path.join(dir, 'nope') });
});

test('the named places resolve by name', async () => {
  assert.equal((await folders.resolve('Trash', '/')).path, places.TRASH);
  assert.equal((await folders.resolve(' computer ', '/')).path, folders.COMPUTER);
  assert.equal((await folders.resolve('iCloud Drive', '/')).path, places.ICLOUD);
  assert.equal((await folders.resolve('~/.Trash', '/')).path, places.TRASH);
});

test('the address bar suggests folders only, matching what was typed', async () => {
  const dir = folder(['Music/', 'movies/', 'Mail.txt', 'Maps.app/', '.mine/', 'Other/']);
  const got = await folders.complete(path.join(dir, 'M'), '/');
  assert.deepEqual(got.map((g) => path.basename(g.path)), ['movies', 'Music']);
  assert.deepEqual((await folders.complete(path.join(dir, '.m'), '/')).map((g) => path.basename(g.path)), ['.mine']);
  assert.deepEqual((await folders.complete(dir + '/', '/')).map((g) => path.basename(g.path)), ['movies', 'Music', 'Other']);
  assert.deepEqual(await folders.complete('   ', dir), []);
});

test('suggestions keep a typed ~ and stop at twelve', async () => {
  const dir = folder(Array.from({ length: 15 }, (_, i) => `F${i + 1}/`));
  const got = await folders.complete(path.join(dir, 'F'), '/');
  assert.equal(got.length, 12);
  assert.deepEqual(got.slice(0, 3).map((g) => path.basename(g.path)), ['F1', 'F2', 'F3'], 'numbers in order');
  const home = await folders.complete('~/', '/');
  for (const g of home) assert.ok(g.value.startsWith('~/'), g.value);
});

test('isPackage knows app and bundle folders', () => {
  assert.equal(folders.isPackage('/Applications/Safari.app'), true);
  assert.equal(folders.isPackage('/x/Thing.bundle'), true);
  assert.equal(folders.isPackage('/x/Folder'), false);
});
