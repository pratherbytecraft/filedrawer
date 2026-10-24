import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ipcMain, BrowserWindow, tempDir } from '../support/electron';
import ops = require('../../src/main/ops');
import * as realCopier from '../../src/main/copier';
import type { JobOptions, Pair } from '../../src/main/copier';
import type { JobChoice, JobQuestion, JobUpdate } from '../../src/shared/types';

// The tests leave target out of a pair that goes into dest, which the job
// reads the same as target null.
type LoosePair = Omit<Pair, 'target'> & { target?: string | null };
const copier = {
  start: (opts: Omit<JobOptions, 'pairs'> & { pairs: LoosePair[] }) => realCopier.start(opts as JobOptions)
};

// A temp folder with these files (name -> its name as text) and folders
// (name ending in /).
function folder(entries: string[] = []) {
  const dir = tempDir();
  for (const e of entries) {
    if (e.endsWith('/')) fs.mkdirSync(path.join(dir, e), { recursive: true });
    else fs.writeFileSync(path.join(dir, e), e);
  }
  return dir;
}

const names = (dir: string) => fs.readdirSync(dir).sort();
const text = (p: string) => fs.readFileSync(p, 'utf8');

// Answers each question the job asks, in order, from its progress window,
// as [choice, forAll]. Resolves with the questions asked.
function answering(answers: [JobChoice, boolean?][]) {
  const asked: JobQuestion[] = [];
  // The progress window is only ever sent job updates.
  const question = (s: { payload: unknown }) => (s.payload as JobUpdate).question;
  const before = BrowserWindow.made.length;
  const timer = setInterval(() => {
    const win = BrowserWindow.made[before];
    if (!win) return;
    const last = win.sent.filter((s) => question(s)).length;
    if (last > asked.length) {
      const q = question(win.sent.filter((s) => question(s))[asked.length]) as JobQuestion;
      asked.push(q);
      const [choice, all] = answers.shift() || ['cancel'];
      // loadFile always sets query, and the job loads its window first.
      ipcMain.handlers['job:answer'](null, win.query!.id, choice, all);
    }
  }, 5);
  return { asked, stop: () => clearInterval(timer) };
}

test('copies a file and a folder tree, links and all', async () => {
  const src = folder(['a.txt', 'Tree/', 'Tree/one.txt', 'Tree/Deep/', 'Tree/Deep/two.txt']);
  fs.symlinkSync('one.txt', path.join(src, 'Tree', 'link'));
  const dest = folder();
  const res = await copier.start({ mode: 'copy', pairs: [{ src: path.join(src, 'a.txt') }, { src: path.join(src, 'Tree') }], dest });
  assert.equal(res.error, null);
  assert.deepEqual(res.done.map((d) => path.basename(d.to)), ['a.txt', 'Tree']);
  assert.equal(text(path.join(dest, 'Tree', 'Deep', 'two.txt')), 'Tree/Deep/two.txt');
  assert.equal(fs.readlinkSync(path.join(dest, 'Tree', 'link')), 'one.txt');
  assert.deepEqual(names(src), ['Tree', 'a.txt'], 'a copy leaves the originals');
});

test('a copy into the same folder is named Copy of', async () => {
  const dir = folder(['a.txt']);
  await copier.start({ mode: 'copy', pairs: [{ src: path.join(dir, 'a.txt') }], dest: dir });
  await copier.start({ mode: 'copy', pairs: [{ src: path.join(dir, 'a.txt') }], dest: dir });
  assert.deepEqual(names(dir), ['Copy (2) of a.txt', 'Copy of a.txt', 'a.txt']);
});

test('a move on the same disk renames, and into its own folder does nothing', async () => {
  const src = folder(['a.txt', 'b.txt']);
  const dest = folder();
  const res = await copier.start({ mode: 'move', pairs: [{ src: path.join(src, 'a.txt') }], dest });
  assert.deepEqual(res.done, [{ from: path.join(src, 'a.txt'), to: path.join(dest, 'a.txt') }]);
  assert.deepEqual(names(src), ['b.txt']);
  const same = await copier.start({ mode: 'move', pairs: [{ src: path.join(src, 'b.txt') }], dest: src });
  assert.deepEqual(same.done, []);
  assert.deepEqual(names(src), ['b.txt']);
});

test('a folder can not go into itself', async () => {
  const dir = folder(['F/', 'F/Inner/']);
  const res = await copier.start({ mode: 'copy', pairs: [{ src: path.join(dir, 'F') }], dest: path.join(dir, 'F', 'Inner') });
  assert.equal(res.error, '"F" can\'t be copied into itself.');
  assert.deepEqual(names(path.join(dir, 'F', 'Inner')), []);
});

test('a taken name asks, and Keep Both takes the next free name', async () => {
  const src = folder(['a.txt']);
  const dest = folder(['a.txt']);
  fs.writeFileSync(path.join(dest, 'a.txt'), 'old');
  const answers = answering([['keep']]);
  const res = await copier.start({ mode: 'copy', pairs: [{ src: path.join(src, 'a.txt') }], dest });
  answers.stop();
  assert.equal(answers.asked.length, 1);
  assert.equal(answers.asked[0].name, 'a.txt');
  assert.equal(path.basename(res.done[0].to), 'a (2).txt');
  assert.equal(text(path.join(dest, 'a.txt')), 'old');
});

test('Skip leaves the old one, Cancel stops the rest', async () => {
  const src = folder(['a.txt', 'b.txt', 'c.txt']);
  const dest = folder(['a.txt', 'b.txt']);
  const answers = answering([['skip'], ['cancel']]);
  const res = await copier.start({ mode: 'copy', pairs: ['a.txt', 'b.txt', 'c.txt'].map((n) => ({ src: path.join(src, n) })), dest });
  answers.stop();
  assert.equal(res.cancelled, true);
  assert.deepEqual(res.done, []);
  assert.equal(text(path.join(dest, 'a.txt')), 'a.txt');
  assert.deepEqual(names(dest), ['a.txt', 'b.txt'], 'c.txt never copied');
});

test('Replace sends the old one to the Trash, for all of them when asked', async (t) => {
  const src = folder(['a.txt', 'b.txt']);
  const dest = folder(['a.txt', 'b.txt']);
  fs.writeFileSync(path.join(dest, 'a.txt'), 'old a');
  const bin = folder();
  const realTrash = ops.trash;
  ops.trash = async (paths) => ({
    items: paths.map((p) => {
      const to = path.join(bin, path.basename(p));
      fs.renameSync(p, to);
      return { from: p, to };
    })
  });
  t.after(() => { ops.trash = realTrash; });
  const answers = answering([['replace', true]]);
  const res = await copier.start({ mode: 'copy', pairs: [{ src: path.join(src, 'a.txt') }, { src: path.join(src, 'b.txt') }], dest });
  answers.stop();
  assert.equal(answers.asked.length, 1, 'asked once for both');
  assert.equal(answers.asked[0].more, 1);
  assert.equal(text(path.join(dest, 'a.txt')), 'a.txt');
  assert.equal(text(path.join(bin, 'a.txt')), 'old a');
  assert.deepEqual(res.replaced.map((r) => path.basename(r.to)), ['a.txt', 'b.txt']);
});

test('an Undo copy to a fixed spot that is taken stops with a message', async () => {
  const dir = folder(['a.txt', 'Other/', 'Other/a.txt']);
  const res = await copier.start({ mode: 'move', pairs: [{ src: path.join(dir, 'a.txt'), target: path.join(dir, 'Other', 'a.txt') }] });
  assert.equal(res.error, 'There\'s already an item named "a.txt" in "Other".');
  assert.deepEqual(names(dir), ['Other', 'a.txt']);
});

test('a pair with a name is copied under that name, and a taken name still asks', async () => {
  const src = folder(['59A08A22.jpeg']);
  const dest = folder(['photo.jpeg']);
  const pairs = [{ src: path.join(src, '59A08A22.jpeg'), target: null, name: 'photo.jpeg' }];
  const answers = answering([['keep', false]]);
  const res = await copier.start({ mode: 'copy', pairs, dest });
  answers.stop();
  assert.equal(answers.asked.length, 1);
  assert.deepEqual(names(dest), ['photo (2).jpeg', 'photo.jpeg']);
  assert.equal(text(path.join(dest, 'photo (2).jpeg')), '59A08A22.jpeg');
  assert.deepEqual(res.done.map((d) => path.basename(d.to)), ['photo (2).jpeg']);
});
