// Undo and Redo for what Filedrawer did to files, for the whole app like
// Finder's. Each step has a label for the Edit menu ("Undo Rename") and two
// functions that do and undo it, each answering { error } when it can't.
const MAX = 50;

// What a step's function answers. Copy and move jobs answer error null when
// they went fine.
export type StepResult = { error?: string | null } | null | undefined;

export interface Step {
  label: string;
  undo: () => StepResult | Promise<StepResult>;
  redo: () => StepResult | Promise<StepResult>;
}

const done: Step[] = []; // steps that can be undone, newest last
const undone: Step[] = []; // steps that can be done again, newest last
const listeners = new Set<() => void>();

function changed() {
  for (const fn of listeners) fn();
}

export function push(step: Step) {
  done.push(step);
  if (done.length > MAX) done.shift();
  undone.length = 0;
  changed();
}

export async function undo() {
  const step = done.pop();
  if (!step) return null;
  const res = await step.undo();
  if (!res || !res.error) undone.push(step);
  changed();
  return res;
}

export async function redo() {
  const step = undone.pop();
  if (!step) return null;
  const res = await step.redo();
  if (!res || !res.error) done.push(step);
  changed();
  return res;
}

export function labels() {
  return {
    undo: done.length ? `Undo ${done[done.length - 1].label}` : null,
    redo: undone.length ? `Redo ${undone[undone.length - 1].label}` : null
  };
}

export function onChange(fn: () => void) {
  listeners.add(fn);
}

