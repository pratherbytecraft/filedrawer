// Searching a folder on an SSH site. The server does the work: find picks
// names, dates and sizes, grep looks inside files for a word, and the paths
// come back as they're found. A login that can't run commands (SFTP only)
// gets a walk through the folders over SFTP instead, like the walk on the Mac.
import type { WebContents } from 'electron';
import * as remote from './remote';
import * as sites from './sites';
import * as fsx from './fsx';
import * as ipc from './ipc';
import type { Item, SearchQuery, SearchState } from '../shared/types';

const MAX = 2000;
const BATCH = 60;
const WALK_LIMIT = 60 * 1000; // ms a walk may take
const CONTENT_MAX = 2 * 1024 * 1024; // bytes a walk reads from a file when it looks for a word
const DAY = 86400000;

const AGES: Record<string, number> = { week: 7, month: 30, year: 365 };
const SIZES: Record<string, [number, number]> = { small: [0, 100 * 1000], medium: [100 * 1000, 1000 * 1000], large: [1000 * 1000, Infinity] };

// A word for the server's shell, quoted so nothing in it is read as shell.
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// A name for find's -iname, with its own wildcards made plain.
const plainGlob = (s: string) => s.replace(/[*?[\]\\]/g, (c) => '\\' + c);

// The find command for a search: hidden folders left out unless shown,
// then the name, the age, files only for a size or a word, and grep to
// look inside them. Sizes and ages are checked again from each result.
export function findCommand(root: string, q: Pick<SearchQuery, 'name' | 'word' | 'age' | 'size' | 'hidden'>) {
  const parts = ['find', quote(root), '-mindepth', '1'];
  if (!q.hidden) parts.push('-name', quote('.*'), '-prune', '-o');
  const tests: string[] = [];
  if (q.name) tests.push('-iname', quote(`*${plainGlob(q.name)}*`));
  if (AGES[q.age]) tests.push('-mtime', `-${AGES[q.age]}`);
  if (SIZES[q.size] || q.word) tests.push('-type', 'f');
  if (q.word) tests.push('-size', `-${CONTENT_MAX / 1024}k`, '-exec', 'grep', '-lIiF', '--', quote(q.word), '{}', '+');
  else tests.push('-print');
  return `${parts.join(' ')} ${tests.join(' ')} 2>/dev/null`;
}

// Whether a line of find's output is a path under the folder searched. An
// SFTP only server answers a command with a line of its own on the same
// output ("This service allows sftp connections only."), which isn't one.
export function isFound(root: string, line: string) {
  const under = root.endsWith('/') ? root : root + '/';
  return line.startsWith(under);
}

class SiteSearch {
  declare sender: WebContents;
  declare id: number;
  declare q: SearchQuery;
  declare stopped: boolean;
  declare count: number;
  declare seen: Set<string>;
  declare pending: string[];
  declare running: remote.Running | null;
  declare draining?: boolean;
  declare lines: string[];

  constructor(sender: WebContents, id: number, q: SearchQuery) {
    this.sender = sender;
    this.id = id;
    this.q = q;
    this.stopped = false;
    this.count = 0;
    this.seen = new Set();
    this.pending = [];
    this.running = null;
    this.lines = [];
  }

  send(channel: 'search:results', payload: { items: Item[] }): void;
  send(channel: 'search:state', payload: Omit<SearchState, 'id'>): void;
  send(channel: 'search:results' | 'search:state', payload: { items: Item[] } | Omit<SearchState, 'id'>) {
    if (!this.sender.isDestroyed()) ipc.send(this.sender, channel, { id: this.id, ...payload });
  }

  // Whether an item fits the dates and sizes asked for (find's are rough).
  fits(it: Item) {
    if (AGES[this.q.age] && it.modified < Date.now() - AGES[this.q.age] * DAY) return false;
    if (SIZES[this.q.size]) {
      const [lo, hi] = SIZES[this.q.size];
      if (it.size == null || it.size < lo || it.size >= hi) return false;
    }
    return true;
  }

  async flush(kinds: (items: Item[]) => Promise<void>) {
    const paths = this.pending.splice(0);
    if (!paths.length) return;
    const items = (await remote.itemsFor(paths).catch((): Item[] => [])).filter((it) => this.fits(it));
    await kinds(items);
    if (items.length && !this.stopped) this.send('search:results', { items });
  }

  async add(p: string, kinds: (items: Item[]) => Promise<void>) {
    if (this.stopped || this.count >= MAX || this.seen.has(p) || p === this.q.root) return;
    this.seen.add(p);
    this.count++;
    this.pending.push(p);
    if (this.pending.length >= BATCH) await this.flush(kinds);
    if (this.count >= MAX) this.stop();
  }

  async drain(kinds: (items: Item[]) => Promise<void>) {
    if (this.draining) return;
    this.draining = true;
    while (this.lines.length && !this.stopped) await this.add(this.lines.shift() as string, kinds); // lines isn't empty
    this.draining = false;
  }

  // find and grep on the server. False when the server wouldn't run them.
  async onServer(kinds: (items: Item[]) => Promise<void>) {
    const at = sites.split(this.q.root);
    if (!at) return true;
    let said = '';
    try {
      this.running = await remote.run(this.q.root, findCommand(at.path, this.q), (line) => {
        if (!isFound(at.path, line)) {
          said += line + '\n';
          return;
        }
        this.lines.push(sites.join(at.id, line));
        this.drain(kinds);
      });
    } catch {
      return true; // can't connect: the window already says so
    }
    const { code, err } = await this.running.done;
    this.running = null;
    await this.drain(kinds);
    // No shell: the exec was refused, or the server says SFTP only.
    if (code === null || ((code === 127 || /sftp|not allowed|only/i.test(err + said)) && !this.count)) return this.stopped;
    return true;
  }

  // A walk over SFTP, breadth first, for a login without a shell.
  async walk(kinds: (items: Item[]) => Promise<void>) {
    const until = Date.now() + WALK_LIMIT;
    const queue = [this.q.root];
    const name = this.q.name.toLowerCase();
    const word = this.q.word.toLowerCase();
    while (queue.length && !this.stopped && Date.now() < until) {
      const dir = queue.shift() as string; // queue isn't empty
      const names = await fsx.readdir(dir).catch((): string[] => []);
      for (const n of names) {
        if (this.stopped) return;
        if (n.startsWith('.') && !this.q.hidden) continue;
        const p = fsx.join(dir, n);
        const st = await fsx.lstat(p).catch(() => null);
        if (!st) continue;
        if (st.dir && !st.link) queue.push(p);
        if (name && !n.toLowerCase().includes(name)) continue;
        if ((SIZES[this.q.size] || word) && st.dir) continue;
        if (word) {
          if (st.size > CONTENT_MAX) continue;
          const a = await remote.at(p).catch(() => null);
          if (!a) continue;
          const text = await a.run(new Promise<Buffer>((resolve, reject) => a.sftp.readFile(a.path, (err, data) => (err ? reject(err) : resolve(data))))).catch(() => null);
          if (!text || !text.toString('utf8').toLowerCase().includes(word)) continue;
        }
        await this.add(p, kinds);
      }
    }
  }

  async run(kinds: (items: Item[]) => Promise<void>) {
    this.send('search:state', { state: 'searching' });
    const ran = await this.onServer(kinds);
    await this.flush(kinds);
    if (!ran && !this.stopped) {
      this.send('search:state', { state: 'walking' });
      await this.walk(kinds);
      await this.flush(kinds);
    }
    const capped = this.count >= MAX;
    this.send('search:state', { state: this.stopped && !capped ? 'stopped' : 'done', count: this.count, capped });
  }

  stop() {
    this.stopped = true;
    if (this.running) this.running.stop();
  }
}

const running = new Map<number, SiteSearch>(); // webContents id -> search

export function start(sender: WebContents, id: number, q: SearchQuery, kinds: (items: Item[]) => Promise<void>) {
  stop(sender);
  const s = new SiteSearch(sender, id, q);
  running.set(sender.id, s);
  s.run(kinds).finally(() => {
    if (running.get(sender.id) === s) running.delete(sender.id);
  });
}

export function stop(sender: WebContents) {
  const s = running.get(sender.id);
  if (s) s.stop();
  running.delete(sender.id);
}
