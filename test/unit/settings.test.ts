import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempAppData } from '../support/electron';
import * as settings from '../../src/main/settings';
import type { SettingsPatch } from '../../src/shared/types';

// A fresh settings folder, with settings.json holding saved when given.
function start(saved?: unknown) {
  const dir = path.join(tempAppData(), 'Filedrawer');
  if (saved !== undefined) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), typeof saved === 'string' ? saved : JSON.stringify(saved));
  }
  settings.init();
  return path.join(dir, 'settings.json');
}

test('a first run, or a broken file, gets the defaults', () => {
  start();
  assert.deepEqual(settings.get(), settings.DEFAULTS);
  assert.equal(settings.get().previews, true);
  start('{ broken');
  assert.deepEqual(settings.get(), settings.DEFAULTS);
});

test('values of the wrong kind and unknown keys are dropped', () => {
  start({ showPane: 'no', view: 3, madeUp: 1, updates: { auto: 'no' }, pins: ['/a', 2], window: 'big' });
  const s = settings.get();
  assert.equal(s.showPane, true);
  assert.equal(s.view, 'details');
  assert.equal('madeUp' in s, false);
  assert.deepEqual(s.updates, { auto: true });
  assert.deepEqual(s.pins, ['/a']);
  assert.deepEqual(s.window, settings.DEFAULTS.window);
});

test('folder views and open with lists take any folder or extension', () => {
  start({ folderViews: { '/Users/me/Pictures': 'thumbs', '/x': 5 }, openWith: { txt: ['/A.app', 3], md: 'nope' } });
  const s = settings.get();
  assert.deepEqual(s.folderViews, { '/Users/me/Pictures': 'thumbs' });
  assert.deepEqual(s.openWith, { txt: ['/A.app'] });
});

test('an update is cleaned, merged and saved', () => {
  const file = start();
  // showHidden of the wrong kind on purpose, to see it dropped.
  settings.update({ window: { height: 700 }, showHidden: 'yes' } as unknown as SettingsPatch);
  assert.deepEqual(settings.get().window, { width: 960, height: 700 });
  assert.equal(settings.get().showHidden, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).window.height, 700);
});

test('folder views are replaced whole, so one can be taken out', () => {
  start({ folderViews: { '/a': 'icons', '/b': 'list' } });
  settings.update({ folderViews: { '/b': 'list' } });
  assert.deepEqual(settings.get().folderViews, { '/b': 'list' });
});

test('folder sorts keep only known keys and directions, and are replaced whole', () => {
  start({ folderSorts: { '/a': { key: 'modified', dir: 'desc' }, '/b': { key: 'colour', dir: 'asc' }, '/c': { key: 'name', dir: 'up' }, '/d': 'name' } });
  assert.deepEqual(settings.get().folderSorts, { '/a': { key: 'modified', dir: 'desc' } });
  settings.update({ folderSorts: { '/e': { key: 'size', dir: 'asc' } } });
  assert.deepEqual(settings.get().folderSorts, { '/e': { key: 'size', dir: 'asc' } });
});

test('folder columns keep only known columns, in their own order, and are replaced whole', () => {
  start({ folderColumns: { '/a': ['added', 'size', 'name', 'colour'], '/b': 'size', '/c': [] } });
  assert.deepEqual(settings.get().folderColumns, { '/a': ['size', 'added'], '/c': [] });
  settings.update({ folderColumns: { '/d': ['kind', 'created'] } });
  assert.deepEqual(settings.get().folderColumns, { '/d': ['kind', 'created'] });
});

test('column widths keep whole points above zero for each kind of list', () => {
  start({ columnWidths: { files: { name: 250.4, size: -3, kind: 'wide' }, trash: { name: 0 }, recents: 5 } });
  assert.deepEqual(settings.get().columnWidths, { files: { name: 250 } });
  settings.update({ columnWidths: { trash: { name: 200, from: 120 } } });
  assert.deepEqual(settings.get().columnWidths, { trash: { name: 200, from: 120 } });
});

test('import and reset start from the defaults', () => {
  start({ theme: 'classic-1995', confirmTrash: true });
  settings.replace({ confirmTrash: true });
  assert.equal(settings.get().theme, 'system');
  assert.equal(settings.get().confirmTrash, true);
  settings.reset();
  assert.deepEqual(settings.get(), settings.DEFAULTS);
});
