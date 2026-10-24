// Searching: Spotlight (mdfind) first, and a walk through the folders when
// Spotlight has nothing, as it does for places it doesn't index (/tmp, some
// external disks). Results go to the window in batches as they're found,
// up to MAX, and a search can be stopped at any time.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { WebContents } from 'electron';
import fs from 'fs';
import path from 'path';
import * as folders from './folders';
import * as ipc from './ipc';
import type { Item, SearchQuery, SearchState } from '../shared/types';

const MAX = 2000;
const WALK_LIMIT = 60 * 1000; // ms a walk may take
const CONTENT_MAX = 2 * 1024 * 1024; // bytes read from each file when a walk looks for words
const BATCH = 60;

const running = new Map<number, Search>(); // window id -> search

const AGES: Record<string, number> = { week: 7, month: 30, year: 365 };
const SIZES: Record<string, [number, number]> = { small: [0, 100 * 1000], medium: [100 * 1000, 1000 * 1000], large: [1000 * 1000, Infinity] };

// Spotlight's query language: names and words match anywhere, ignoring case and accents.
function quote(text: string) {
  return text.replace(/["\\*]/g, (c) => '\\' + c);
}

export function spotlightQuery(q: Pick<SearchQuery, 'name' | 'word' | 'age' | 'size'>) {
  const parts = [];
  if (q.name) parts.push(`kMDItemFSName == "*${quote(q.name)}*"cd`);
  if (q.word) parts.push(`kMDItemTextContent == "*${quote(q.word)}*"cd`);
  if (AGES[q.age]) parts.push(`kMDItemFSContentChangeDate >= $time.today(-${AGES[q.age]})`);
  if (SIZES[q.size]) {
    const [lo, hi] = SIZES[q.size];
    parts.push(`kMDItemFSSize >= ${lo}`);
    if (isFinite(hi)) parts.push(`kMDItemFSSize < ${hi}`);
  }
  return parts.join(' && ') || 'kMDItemFSName == "*"';
}

class Search {
  // Declared only, so the class itself sets nothing; the constructor does.
  declare sender: WebContents;
  declare id: number;
  declare q: SearchQuery;
  declare stopped: boolean;
  declare count: number;
  declare seen: Set<string>;
  declare pending: string[];
  declare child: ChildProcessWithoutNullStreams | null;
  declare draining?: boolean;

  constructor(sender: WebContents, id: number, q: SearchQuery) {
    this.sender = sender;
    this.id = id;
    this.q = q;
    this.stopped = false;
    this.count = 0;
    this.seen = new Set();
    this.pending = [];
    this.child = null;
  }

  send(channel: 'search:results', payload: { items: Item[] }): void;
  send(channel: 'search:state', payload: Omit<SearchState, 'id'>): void;
  send(channel: 'search:results' | 'search:state', payload: { items: Item[] } | Omit<SearchState, 'id'>) {
    if (!this.sender.isDestroyed()) ipc.send(this.sender, channel, { id: this.id, ...payload });
  }

  // Items are read and described in batches, like a folder's.
  async flush() {
    const paths = this.pending.splice(0);
    if (!paths.length) return;
    const items = (await Promise.all(paths.map((p) => folders.readItem(path.dirname(p), path.basename(p))))).filter((it) => it !== null);
    await folders.addInfo(items);
    const shown = this.q.hidden ? items : items.filter((it) => !it.hidden);
    if (this.q.extensions) shown.forEach((it) => { it.display = it.name; });
    if (shown.length && !this.stopped) this.send('search:results', { items: shown });
  }

  async add(p: string) {
    if (this.stopped || this.count >= MAX || this.seen.has(p) || p === this.q.root) return;
    this.seen.add(p);
    this.count++;
    this.pending.push(p);
    if (this.pending.length >= BATCH) await this.flush();
    if (this.count >= MAX) this.stop();
  }

  spotlight() {
    return new Promise<void>((resolve) => {
      const roots = this.q.root === folders.COMPUTER ? ['/'] : [this.q.root];
      const args = [...roots.flatMap((r) => ['-onlyin', r]), spotlightQuery(this.q)];
      this.child = spawn('mdfind', args);
      let buf = '';
      const lines: string[] = [];
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop() as string; // split gives at least one part
        for (const line of parts) if (line) lines.push(line);
        this.drain(lines);
      });
      this.child.on('close', async () => {
        if (buf) lines.push(buf);
        await this.drain(lines);
        this.child = null;
        resolve();
      });
      this.child.on('error', () => resolve());
    });
  }

  async drain(lines: string[]) {
    if (this.draining) return;
    this.draining = true;
    while (lines.length && !this.stopped) await this.add(lines.shift() as string); // lines isn't empty
    this.draining = false;
  }

  async matches(p: string, st: fs.Stats) {
    const name = path.basename(p).toLowerCase();
    if (this.q.name && !name.includes(this.q.name.toLowerCase())) return false;
    if (AGES[this.q.age] && st.mtimeMs < Date.now() - AGES[this.q.age] * 86400000) return false;
    if (SIZES[this.q.size]) {
      if (st.isDirectory()) return false;
      const [lo, hi] = SIZES[this.q.size];
      if (st.size < lo || st.size >= hi) return false;
    }
    if (this.q.word) {
      if (!st.isFile() || st.size > CONTENT_MAX) return false;
      try {
        const text = await fs.promises.readFile(p, 'utf8');
        if (!text.toLowerCase().includes(this.q.word.toLowerCase())) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  // A plain walk, breadth first, skipping hidden folders unless hidden files are shown.
  async walk() {
    const until = Date.now() + WALK_LIMIT;
    const queue = [this.q.root === folders.COMPUTER ? '/' : this.q.root];
    while (queue.length && !this.stopped && Date.now() < until) {
      const dir = queue.shift() as string; // queue isn't empty
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (this.stopped) return;
        if (e.name.startsWith('.') && !this.q.hidden) continue;
        const p = path.join(dir, e.name);
        const st = await fs.promises.lstat(p).catch(() => null);
        if (!st) continue;
        if (await this.matches(p, st)) await this.add(p);
        if (st.isDirectory() && !st.isSymbolicLink() && !/\.(app|bundle|framework|photoslibrary)$/i.test(e.name)) queue.push(p);
      }
    }
  }

  async run() {
    this.send('search:state', { state: 'searching' });
    await this.spotlight();
    await this.flush();
    if (!this.count && !this.stopped) {
      this.send('search:state', { state: 'walking' });
      await this.walk();
      await this.flush();
    }
    const capped = this.count >= MAX;
    this.send('search:state', { state: this.stopped && !capped ? 'stopped' : 'done', count: this.count, capped });
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
  }
}

export function start(sender: WebContents, id: number, q: SearchQuery) {
  stop(sender);
  const s = new Search(sender, id, q);
  running.set(sender.id, s);
  s.run().finally(() => {
    if (running.get(sender.id) === s) running.delete(sender.id);
  });
}

export function stop(sender: WebContents) {
  const s = running.get(sender.id);
  if (s) s.stop();
  running.delete(sender.id);
}

