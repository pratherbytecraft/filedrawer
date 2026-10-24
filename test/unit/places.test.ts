import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { app, tempAppData, tempDir } from '../support/electron';
import { dsStore } from '../support/dsstore';
import places = require('../../src/main/places');

const records = (map: Map<string, unknown>) => Object.fromEntries(map);

test('Put Back reads where Finder trashed things from', () => {
  const buf = dsStore([
    ['Report.pdf', 'ptbL', 'ustr', 'Users/me/Documents/'],
    ['Report.pdf', 'ptbN', 'ustr', 'Report.pdf'],
    ['Report.pdf', 'Iloc', 'blob', Buffer.alloc(16)],
    ['photo 2.jpg', 'ptbL', 'ustr', 'Users/me/Desktop/'],
    ['photo 2.jpg', 'ptbN', 'ustr', 'photo.jpg'],
    ['photo 2.jpg', 'dscl', 'bool', true],
    ['notes.txt', 'lg1S', 'long', 1234]
  ]);
  assert.deepEqual(records(places.putBackRecords(buf)), {
    'Report.pdf': { ptbL: 'Users/me/Documents/', ptbN: 'Report.pdf' },
    'photo 2.jpg': { ptbL: 'Users/me/Desktop/', ptbN: 'photo.jpg' }
  });
});

test('Put Back reads a tree with more than one block, and names with accents', () => {
  const names = ['a.txt', 'Café.txt', 'c.txt', 'd.txt', 'e.txt'];
  const buf = dsStore(names.map((n) => [n, 'ptbL', 'ustr', `Users/me/${n}-dir/`]), { split: true });
  const got = places.putBackRecords(buf);
  assert.deepEqual([...got.keys()], names);
  // Café.txt is one of the names written above.
  assert.equal(got.get('Café.txt')!.ptbL, 'Users/me/Café.txt-dir/');
});

test('a file that is not a .DS_Store, or is cut short, gives what it can', () => {
  assert.equal(places.putBackRecords(Buffer.from('hello world, not a store')).size, 0);
  assert.equal(places.putBackRecords(Buffer.alloc(0)).size, 0);
  const whole = dsStore([['a', 'ptbL', 'ustr', 'Users/me/']]);
  assert.equal(places.putBackRecords(whole.subarray(0, whole.length - 300)).size, 0);
});

test('the trash log keeps where Filedrawer trashed things from, while they are there', () => {
  tempAppData();
  fs.mkdirSync(path.join(app.getPath('appData'), 'Filedrawer'));
  const trash = tempDir();
  fs.writeFileSync(path.join(trash, 'a.txt'), 'a');
  places.logTrashed([{ from: '/Users/me/a.txt', to: path.join(trash, 'a.txt') }, { from: '/Users/me/gone.txt', to: path.join(trash, 'gone.txt') }]);
  const log = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'Filedrawer', 'trash-log.json'), 'utf8'));
  assert.deepEqual(log, { [path.join(trash, 'a.txt')]: '/Users/me/a.txt' });
});

test('moving back and forth for Undo makes missing folders', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const to = path.join(dir, 'new', 'deeper', 'a.txt');
  assert.deepEqual(await places.moveAll([{ from: path.join(dir, 'a.txt'), to }]), {});
  assert.equal(fs.readFileSync(to, 'utf8'), 'a');
  const res = await places.moveAll([{ from: path.join(dir, 'missing.txt'), to }]);
  assert.match(res.error!, /"missing.txt" couldn't be moved/);
});

test('Delete Immediately removes files and folders', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'F'));
  fs.writeFileSync(path.join(dir, 'F', 'x'), 'x');
  fs.writeFileSync(path.join(dir, 'b'), 'b');
  assert.deepEqual(await places.deleteNow([path.join(dir, 'F'), path.join(dir, 'b')]), {});
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match((await places.deleteNow([path.join(dir, 'gone')])).error!, /"gone" couldn't be deleted/);
});

test('inTrash knows the Trash folder', () => {
  assert.equal(places.inTrash(path.join(places.HOME_TRASH, 'x')), true);
  assert.equal(places.inTrash('/Users/nobody/Documents/x'), false);
});
