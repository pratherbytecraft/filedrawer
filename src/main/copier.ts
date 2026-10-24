// Copying and moving files. A job counts its work first, then copies file
// by file so it can show progress, asks what to do when a name is taken,
// and stops on Cancel. Its window only opens when the job takes longer than
// a moment, or when it has a question.
//
// Copies are APFS clones where the disk allows, which take no time or room.
// A move on the same disk is a rename. A move to another disk copies, then
// removes the original once the copy is whole.
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import ops = require('./ops');
import * as ipc from './ipc';
import type { JobChoice, JobQuestion, TrashedItem } from '../shared/types';

// A source and where it goes: target null when the job works the name out
// (into dest), or a fixed path (for Undo). name, when set, is the name it
// takes in dest instead of its own.
export interface Pair {
  src: string;
  target: string | null;
  name?: string;
}

export interface JobOptions {
  mode: 'copy' | 'move';
  pairs: Pair[];
  dest?: string;
  near?: BrowserWindow | null;
}

// A top level item that finished: where it was and where it is now.
export interface Done {
  from: string;
  to: string;
}

export interface JobResult {
  done: Done[];
  replaced: TrashedItem[];
  error: string | null;
  cancelled: boolean;
}

interface Count {
  files: number;
  bytes: number;
}

const SHOW_AFTER = 600; // ms before the progress window opens
const CANCELLED = new Error('cancelled');

const jobs = new Map<number, Job>(); // id -> Job
let nextId = 1;

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/');

// "Copy of X", then "Copy (2) of X" and so on, for a copy into the same folder.
async function copyName(dir: string, name: string) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `Copy of ${name}` : `Copy (${n}) of ${name}`;
    if (!(await ops.exists(path.join(dir, candidate)))) return candidate;
  }
}

async function count(p: string): Promise<Count> {
  const st = await fs.promises.lstat(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const name of await fs.promises.readdir(p)) {
    const c = await count(path.join(p, name));
    files += c.files;
    bytes += c.bytes;
  }
  return { files: files + 1, bytes };
}

function timeLeft(seconds: number) {
  if (!isFinite(seconds)) return '';
  if (seconds < 5) return 'A few seconds left';
  if (seconds < 60) return `About ${Math.round(seconds / 5) * 5} seconds left`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'About a minute left' : `About ${minutes} minutes left`;
}

class Job {
  // Declared only, so the class itself sets nothing; the constructor does.
  declare id: number;
  declare mode: JobOptions['mode'];
  declare pairs: Pair[];
  declare dest: string | undefined;
  declare near: BrowserWindow | null | undefined;
  declare win: BrowserWindow | null;
  declare cancelled: boolean;
  declare total: Count;
  declare doneCount: Count;
  declare current: string;
  declare done: Done[];
  declare replaced: TrashedItem[];
  declare error: string | null;
  declare answer: ((choice: JobChoice, all?: boolean) => void) | null;
  declare forAll: JobChoice | null;
  declare lastSent: number;
  // Set as the job goes.
  declare started?: number;
  declare showTimer?: NodeJS.Timeout;
  declare finished?: boolean;
  declare partial?: number;
  declare question?: JobQuestion | null;

  // mode is copy or move. pairs are { src, target } with target null when
  // the job works the name out (into dest), or a fixed path (for Undo).
  // A pair's name, when set, is the name it takes in dest instead of its own.
  constructor({ mode, pairs, dest, near }: JobOptions) {
    this.id = nextId++;
    this.mode = mode;
    this.pairs = pairs;
    this.dest = dest;
    this.near = near; // the window the job came from, for placing its own
    this.win = null;
    this.cancelled = false;
    this.total = { files: 0, bytes: 0 };
    this.doneCount = { files: 0, bytes: 0 };
    this.current = '';
    this.done = []; // { from, to } for each top level item that finished
    this.replaced = []; // what went to the Trash to make room, as trash items
    this.error = null;
    this.answer = null; // the answer waiting for the user
    this.forAll = null; // an answer given for the rest
    this.lastSent = 0;
  }

  show() {
    if (this.win || this.finished) return;
    const opts: BrowserWindowConstructorOptions & { width: number } = {
      width: 440,
      height: 190,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: this.mode === 'copy' ? 'Copying' : 'Moving',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    };
    if (this.near && !this.near.isDestroyed()) {
      const b = this.near.getBounds();
      opts.x = Math.round(b.x + (b.width - opts.width) / 2);
      opts.y = Math.round(b.y + 80);
    }
    this.win = new BrowserWindow(opts);
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'progress', 'index.html'), { query: { id: String(this.id) } });
    this.win.once('ready-to-show', () => {
      if (this.win && !this.win.isDestroyed()) this.win.show();
      this.send(true);
    });
    // Closing the window is the same as Cancel.
    this.win.on('close', () => this.cancel());
  }

  cancel() {
    this.cancelled = true;
    if (this.answer) this.answer('cancel');
  }

  send(force?: boolean) {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isLoading()) return;
    const now = Date.now();
    if (!force && now - this.lastSent < 100) return;
    this.lastSent = now;
    const bytes = this.doneCount.bytes + (this.partial || 0);
    const fraction = this.total.bytes ? bytes / this.total.bytes : this.total.files ? this.doneCount.files / this.total.files : 0;
    const elapsed = (now - (this.started as number)) / 1000; // set when the job starts, before anything is sent
    const verb = this.mode === 'copy' ? 'Copying' : 'Moving';
    const n = this.pairs.length;
    ipc.send(this.win.webContents, 'job:update', {
      title: `${verb} ${n === 1 ? `"${path.basename(this.pairs[0].src)}"` : `${n} items`}`,
      line: this.dest ? `to "${path.basename(this.dest) || this.dest}"` : '',
      current: this.current ? path.basename(this.current) : '',
      fraction,
      left: elapsed > 1 && fraction > 0.02 ? timeLeft((elapsed / fraction) * (1 - fraction)) : '',
      question: this.question || null
    });
  }

  tick(files: number, bytes: number) {
    this.doneCount.files += files;
    this.doneCount.bytes += bytes;
    this.send();
  }

  // replace | keep | skip | cancel, asked in the job's window.
  ask(name: string, folder: string, more: number): Promise<JobChoice> {
    if (this.forAll) return Promise.resolve(this.forAll);
    clearTimeout(this.showTimer);
    this.show();
    this.question = { name, folder, more };
    this.send(true);
    return new Promise((resolve) => {
      this.answer = (choice, all) => {
        this.answer = null;
        this.question = null;
        if (all && choice !== 'cancel') this.forAll = choice;
        this.send(true);
        resolve(choice);
      };
    });
  }

  async copyTree(src: string, dst: string): Promise<void> {
    if (this.cancelled) throw CANCELLED;
    const st = await fs.promises.lstat(src);
    if (st.isSymbolicLink()) {
      await fs.promises.symlink(await fs.promises.readlink(src), dst);
      this.tick(1, 0);
      return;
    }
    if (st.isDirectory()) {
      await fs.promises.mkdir(dst);
      this.tick(1, 0);
      for (const name of await fs.promises.readdir(src)) await this.copyTree(path.join(src, name), path.join(dst, name));
      await fs.promises.chmod(dst, st.mode & 0o7777).catch(() => {});
      await fs.promises.utimes(dst, st.atime, st.mtime).catch(() => {});
      return;
    }
    this.current = src;
    this.send();
    // How far into a big file the copy is, from its size on the other side.
    const watch = st.size > 8 * 1024 * 1024 ? setInterval(() => {
      fs.stat(dst, (err, d) => {
        if (err || this.current !== src) return;
        this.partial = Math.min(d.size, st.size);
        this.send();
      });
    }, 250) : undefined;
    try {
      // A clone where the disk can, a full copy with the file's dates and extras otherwise.
      await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    } finally {
      clearInterval(watch);
      this.partial = 0;
    }
    this.tick(1, st.size);
  }

  async run(): Promise<JobResult> {
    this.started = Date.now();
    this.showTimer = setTimeout(() => this.show(), SHOW_AFTER);
    try {
      await this.work();
    } catch (err) {
      if (err !== CANCELLED) this.error = this.error || (err as Error).message;
    }
    this.finished = true;
    clearTimeout(this.showTimer);
    if (this.win && !this.win.isDestroyed()) {
      this.win.removeAllListeners('close');
      this.win.close();
    }
    jobs.delete(this.id);
    return { done: this.done, replaced: this.replaced, error: this.error, cancelled: this.cancelled };
  }

  async work() {
    const destDev = this.dest ? (await fs.promises.stat(this.dest)).dev : null;
    const plan: (Pair & { rename: boolean; size: Count })[] = [];
    for (const pair of this.pairs) {
      const st = await fs.promises.lstat(pair.src);
      const toDir = pair.target ? path.dirname(pair.target) : this.dest;
      const sameDisk = (pair.target ? (await fs.promises.stat(toDir as string)).dev : destDev) === st.dev; // toDir is the target's folder here
      const rename = this.mode === 'move' && sameDisk;
      const c = rename ? { files: 1, bytes: 0 } : await count(pair.src);
      this.total.files += c.files;
      this.total.bytes += c.bytes;
      plan.push({ ...pair, rename, size: c });
    }
    this.send(true);

    for (let i = 0; i < plan.length; i++) {
      if (this.cancelled) return;
      const { src, rename } = plan[i];
      const name = plan[i].name || path.basename(src);
      let target = plan[i].target;
      let replacedHere = null; // what this item pushed into the Trash
      if (!target) {
        const dest = this.dest as string; // a pair without a target goes into dest
        if (this.mode === 'move' && path.dirname(src) === dest) {
          this.tick(plan[i].size.files, plan[i].size.bytes);
          continue; // already here
        }
        if (isInside(dest, src)) {
          this.error = `"${name}" can't be ${this.mode === 'copy' ? 'copied' : 'moved'} into itself.`;
          continue;
        }
        target = path.join(dest, name);
        if (this.mode === 'copy' && path.dirname(src) === dest) {
          target = path.join(dest, await copyName(dest, name));
        } else if (await ops.exists(target)) {
          const choice = await this.ask(name, path.basename(dest), plan.length - i - 1);
          if (choice === 'cancel') {
            this.cancelled = true;
            return;
          }
          if (choice === 'skip') {
            this.tick(plan[i].size.files, plan[i].size.bytes);
            continue;
          }
          if (choice === 'keep') {
            target = path.join(dest, await ops.freeName(dest, name));
          } else {
            // Replaced items go to the Trash, so Undo can bring them back.
            const res = await ops.trash([target]);
            if (res.error) {
              this.error = res.error;
              continue;
            }
            replacedHere = res.items;
          }
        }
      } else if (await ops.exists(target)) {
        this.error = `There's already an item named "${path.basename(target)}" in "${path.basename(path.dirname(target))}".`;
        continue;
      }

      if (rename) {
        await fs.promises.rename(src, target);
        this.tick(1, 0);
      } else {
        try {
          await this.copyTree(src, target);
        } catch (err) {
          // A half made copy is taken away again, and what it was replacing comes back.
          await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
          if (replacedHere) await ops.untrash(replacedHere);
          throw err;
        }
        if (this.mode === 'move') await fs.promises.rm(src, { recursive: true, force: true });
      }
      if (replacedHere) this.replaced.push(...replacedHere);
      this.done.push({ from: src, to: target });
    }
  }
}

export function start(opts: JobOptions) {
  const job = new Job(opts);
  jobs.set(job.id, job);
  return job.run();
}

ipc.on('job:answer', (_e, id, choice, all) => {
  const job = jobs.get(Number(id));
  if (job && job.answer) job.answer(choice, all);
});
ipc.on('job:cancel', (_e, id) => {
  const job = jobs.get(Number(id));
  if (job) job.cancel();
});

