const { test } = require('node:test');
const assert = require('node:assert/strict');

// undo keeps one list for the whole app, so each test loads it fresh.
function fresh() {
  delete require.cache[require.resolve('../../src/main/undo')];
  return require('../../src/main/undo');
}

// A step that notes what ran, failing when told to.
function step(label, log, { failUndo = false } = {}) {
  return {
    label,
    undo: async () => (failUndo ? { error: `can't undo ${label}` } : (log.push(`undo ${label}`), {})),
    redo: async () => (log.push(`redo ${label}`), {})
  };
}

test('nothing to undo or redo at first', async () => {
  const undo = fresh();
  assert.deepEqual(undo.labels(), { undo: null, redo: null });
  assert.equal(await undo.undo(), null);
  assert.equal(await undo.redo(), null);
});

test('undo and redo go back and forth, newest first', async () => {
  const undo = fresh();
  const log = [];
  undo.push(step('Rename', log));
  undo.push(step('New Folder', log));
  assert.deepEqual(undo.labels(), { undo: 'Undo New Folder', redo: null });
  await undo.undo();
  assert.deepEqual(undo.labels(), { undo: 'Undo Rename', redo: 'Redo New Folder' });
  await undo.undo();
  await undo.redo();
  assert.deepEqual(log, ['undo New Folder', 'undo Rename', 'redo Rename']);
  assert.deepEqual(undo.labels(), { undo: 'Undo Rename', redo: 'Redo New Folder' });
});

test('a new step clears what could be redone', async () => {
  const undo = fresh();
  const log = [];
  undo.push(step('A', log));
  await undo.undo();
  undo.push(step('B', log));
  assert.deepEqual(undo.labels(), { undo: 'Undo B', redo: null });
});

test('a step that fails to undo can be tried again', async () => {
  const undo = fresh();
  undo.push(step('Move', [], { failUndo: true }));
  assert.deepEqual(await undo.undo(), { error: "can't undo Move" });
  assert.deepEqual(undo.labels(), { undo: null, redo: null });
});

test('only the last fifty steps are kept, and listeners hear each change', async () => {
  const undo = fresh();
  let heard = 0;
  undo.onChange(() => heard++);
  for (let i = 1; i <= 55; i++) undo.push(step(`S${i}`, []));
  let count = 0;
  while (await undo.undo()) count++;
  assert.equal(count, 50);
  assert.equal(heard, 55 + 50);
});
