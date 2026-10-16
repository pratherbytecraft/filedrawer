// Undo and Redo for what Filedrawer did to files, for the whole app like
// Finder's. Each step has a label for the Edit menu ("Undo Rename") and two
// functions that do and undo it, each answering { error } when it can't.
const MAX = 50;

const done = []; // steps that can be undone, newest last
const undone = []; // steps that can be done again, newest last
const listeners = new Set();

function changed() {
  for (const fn of listeners) fn();
}

function push(step) {
  done.push(step);
  if (done.length > MAX) done.shift();
  undone.length = 0;
  changed();
}

async function undo() {
  const step = done.pop();
  if (!step) return null;
  const res = await step.undo();
  if (!res || !res.error) undone.push(step);
  changed();
  return res;
}

async function redo() {
  const step = undone.pop();
  if (!step) return null;
  const res = await step.redo();
  if (!res || !res.error) done.push(step);
  changed();
  return res;
}

function labels() {
  return {
    undo: done.length ? `Undo ${done[done.length - 1].label}` : null,
    redo: undone.length ? `Redo ${undone[undone.length - 1].label}` : null
  };
}

function onChange(fn) {
  listeners.add(fn);
}

module.exports = { push, undo, redo, labels, onChange };
