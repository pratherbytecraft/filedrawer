// The places that aren't one folder on disk: the Trash (every disk's, which
// macOS only lets Filedrawer read with Full Disk Access), Recents (files
// opened in the last 30 days, from Spotlight) and the top of iCloud Drive
// (iCloud's own folder plus a folder for each app that keeps files there).
// Each lists like a folder, with a few columns of its own.
import { app } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import helper = require('./helper');
import type { Item, Listing } from '../shared/types';

const TRASH = '::trash';
const RECENTS = '::recents';
const ICLOUD = '::icloud';
const HOME = os.homedir();
const HOME_TRASH = path.join(HOME, '.Trash');
const MOBILE = path.join(HOME, 'Library', 'Mobile Documents');
const CLOUD_DOCS = path.join(MOBILE, 'com~apple~CloudDocs');
const RECENT_DAYS = 30;
const RECENT_MAX = 300;

// Each place is listed with folders.ts's readItem and addInfo, handed in so
// the two modules don't load each other.
type ReadItem = (dir: string, name: string) => Promise<Item | null>;
type AddInfo = (items: Item[]) => Promise<void>;
type Lister = (readItem: ReadItem, addInfo: AddInfo, opts: { hidden: boolean }) => Promise<Listing>;

// An item moved from one place to another: the Trash and back, Put Back.
interface Moved {
  from: string;
  to: string;
}

// What Finder noted about a trashed item. A field Filedrawer can't read as
// text is null.
interface PutBackRecord {
  ptbL?: string | null;
  ptbN?: string | null;
}

// ---------- the Trash ----------

// Each disk keeps its own Trash: the startup disk's is in Home, the others'
// in .Trashes/<user id> at their top.
function trashDirs() {
  const dirs: [string, string][] = [[HOME_TRASH, '/']];
  let vols: string[] = [];
  try {
    vols = fs.readdirSync('/Volumes');
  } catch {
    vols = [];
  }
  for (const v of vols) {
    const root = path.join('/Volumes', v);
    try {
      if (fs.lstatSync(root).isSymbolicLink()) continue; // the startup disk's link to itself
    } catch {
      continue;
    }
    // getuid is there on macOS, the only system Filedrawer runs on.
    dirs.push([path.join(root, '.Trashes', String(process.getuid!())), root]);
  }
  return dirs;
}

const inTrash = (p: string) => trashDirs().some(([d]) => p === d || p.startsWith(d + '/'));

// Where Finder put things it moved to the Trash: its .DS_Store there keeps
// each item's folder (ptbL, from the top of the disk) and first name (ptbN).
// The file is a small B-tree; only those two fields are read.
function putBackRecords(buf: Buffer) {
  const out = new Map<string, PutBackRecord>();
  try {
    if (buf.readUInt32BE(0) !== 1 || buf.toString('latin1', 4, 8) !== 'Bud1') return out;
    const at = (o: number) => o + 4;
    let p = at(buf.readUInt32BE(8));
    const count = buf.readUInt32BE(p);
    p += 8;
    const addrs: number[] = [];
    for (let i = 0; i < count; i++) addrs.push(buf.readUInt32BE(p + 4 * i));
    p += 4 * Math.ceil(count / 256) * 256;
    const tocCount = buf.readUInt32BE(p);
    p += 4;
    let dsdb = null;
    for (let i = 0; i < tocCount; i++) {
      const len = buf[p];
      const name = buf.toString('latin1', p + 1, p + 1 + len);
      p += 1 + len;
      if (name === 'DSDB') dsdb = buf.readUInt32BE(p);
      p += 4;
    }
    if (dsdb === null) return out;
    const block = (id: number) => at(addrs[id] & ~0x1f);
    const utf16 = (q: number, n: number) => Buffer.from(buf.subarray(q, q + 2 * n)).swap16().toString('utf16le');
    const record = (q: number) => {
      const nlen = buf.readUInt32BE(q);
      const name = utf16(q + 4, nlen);
      q += 4 + 2 * nlen;
      const code = buf.toString('latin1', q, q + 4);
      const type = buf.toString('latin1', q + 4, q + 8);
      q += 8;
      let value: string | null = null;
      if (type === 'bool') q += 1;
      else if (type === 'long' || type === 'shor' || type === 'type') q += 4;
      else if (type === 'comp' || type === 'dutc') q += 8;
      else if (type === 'blob') q += 4 + buf.readUInt32BE(q);
      else if (type === 'ustr') {
        const n = buf.readUInt32BE(q);
        value = utf16(q + 4, n);
        q += 4 + 2 * n;
      } else throw new Error('unknown record type');
      if (code === 'ptbL' || code === 'ptbN') out.set(name, { ...out.get(name), [code]: value });
      return q;
    };
    const walk = (id: number, depth: number): void => {
      if (depth > 32) return;
      let q = block(id);
      const next = buf.readUInt32BE(q);
      const n = buf.readUInt32BE(q + 4);
      q += 8;
      for (let i = 0; i < n; i++) {
        if (next) {
          walk(buf.readUInt32BE(q), depth + 1);
          q += 4;
        }
        q = record(q);
      }
      if (next) walk(next, depth + 1);
    };
    walk(buf.readUInt32BE(block(dsdb)), 0);
  } catch {
    // a file Filedrawer can't read fully still gives what it read
  }
  return out;
}

// What Filedrawer moved to the Trash itself: macOS doesn't note where those
// came from, so Filedrawer does, by where each landed.
const logFile = () => path.join(app.getPath('appData'), 'Filedrawer', 'trash-log.json');

function readLog(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(logFile(), 'utf8'));
  } catch {
    return {};
  }
}

function logTrashed(items: Moved[]) {
  const log = readLog();
  for (const it of items) if (it.to) log[it.to] = it.from;
  for (const k of Object.keys(log)) if (!fs.existsSync(k)) delete log[k];
  try {
    fs.writeFileSync(logFile(), JSON.stringify(log, null, 2) + '\n');
  } catch {
    // the log is a help for Put Back, not needed for the Trash itself
  }
}

// { trashed path -> where it came from } for one Trash folder.
async function origins(dir: string, root: string) {
  const out = new Map<string, string>();
  const buf = await fs.promises.readFile(path.join(dir, '.DS_Store')).catch(() => null);
  if (buf) {
    for (const [name, r] of putBackRecords(buf)) {
      // Finder writes the startup disk's folders from its data volume's top
      // (System/Volumes/Data/Users/...), the same place as /Users/...
      // Finder writes ptbL as text; one that isn't comes out null (see
      // putBackRecords) and is skipped, rather than failing the whole Trash.
      if (typeof r.ptbL === 'string') out.set(path.join(dir, name), path.join(root, r.ptbL, r.ptbN || name).replace(/^\/System\/Volumes\/Data(?=\/)/, ''));
    }
  }
  const log = readLog();
  for (const [to, from] of Object.entries(log)) if (path.dirname(to) === dir) out.set(to, from);
  return out;
}

async function listTrash(readItem: ReadItem, addInfo: AddInfo, { hidden }: { hidden: boolean }): Promise<Listing> {
  try {
    await fs.promises.readdir(HOME_TRASH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { path: TRASH, error: code === 'EPERM' || code === 'EACCES' ? 'fda' : 'other' };
  }
  let items: Item[] = [];
  for (const [dir, root] of trashDirs()) {
    const names = await fs.promises.readdir(dir).catch(() => []);
    const from = await origins(dir, root);
    const got = await Promise.all(names.filter((n) => n !== '.DS_Store').map((n) => readItem(dir, n)));
    for (const it of got.filter((x) => x !== null)) {
      it.from = from.get(it.path) || null;
      items.push(it);
    }
  }
  await addInfo(items);
  items.forEach((it) => {
    it.deleted = it.added || it.modified;
    it.fixed = true; // Put Back and Delete Immediately instead of rename and move
    it.trashed = true;
  });
  if (!hidden) items = items.filter((it) => !it.hidden);
  return { path: TRASH, items, writable: false };
}

// Puts each item back where it came from, making its folder again if it's
// gone. { done: [{ from, to }], error } where from is the Trash.
async function putBack(paths: string[]): Promise<{ done: Moved[]; error?: string }> {
  const done: Moved[] = [];
  const known = new Map<string, string>();
  for (const [dir, root] of trashDirs()) for (const [k, v] of await origins(dir, root)) known.set(k, v);
  for (const p of paths) {
    const to = known.get(p);
    const name = path.basename(p);
    if (!to) return { done, error: `Filedrawer doesn't know where "${name}" came from. Drag it to where you'd like it.` };
    if (await fs.promises.lstat(to).then(() => true, () => false)) {
      return { done, error: `"${name}" can't be put back, there's already an item named "${path.basename(to)}" where it came from.` };
    }
    try {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.rename(p, to);
      done.push({ from: p, to });
    } catch (err) {
      return { done, error: `"${name}" couldn't be put back. ${(err as Error).message}` };
    }
  }
  return { done };
}

// For Undo of Put Back, and Redo.
async function moveAll(pairs: Moved[]): Promise<{ error?: string }> {
  for (const { from, to } of pairs) {
    try {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.rename(from, to);
    } catch (err) {
      return { error: `"${path.basename(from)}" couldn't be moved. ${(err as Error).message}` };
    }
  }
  return {};
}

async function deleteNow(paths: string[]): Promise<{ error?: string }> {
  for (const p of paths) {
    try {
      await fs.promises.rm(p, { recursive: true });
    } catch (err) {
      const { code, message } = err as NodeJS.ErrnoException;
      const why = code === 'EPERM' || code === 'EACCES' ? 'It may be locked, or Filedrawer isn\'t allowed to change it.' : message;
      return { error: `"${path.basename(p)}" couldn't be deleted. ${why}` };
    }
  }
  return {};
}

// ---------- Recents ----------

function mdfind(query: string) {
  return new Promise<string[]>((resolve) => {
    execFile('mdfind', ['-onlyin', HOME, query], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? [] : out.split('\n').filter(Boolean)));
  });
}

async function listRecents(readItem: ReadItem, addInfo: AddInfo, { hidden }: { hidden: boolean }): Promise<Listing> {
  const found = await mdfind(`kMDItemLastUsedDate >= $time.today(-${RECENT_DAYS})`);
  // Files people open, not folders, apps or what's inside Library and hidden folders.
  const paths = found.filter((p) => !p.includes('/.') && !p.startsWith(path.join(HOME, 'Library') + '/') && !p.endsWith('.app'));
  const res = await helper.request('lastUsed', { paths }, { timeout: 15000 });
  const used = res && res.dates ? res.dates : [];
  const newest = paths.map((p, i): [string, number] => [p, used[i] || 0]).sort((a, b) => b[1] - a[1]).slice(0, RECENT_MAX);
  let items = (await Promise.all(newest.map(async ([p, when]) => {
    const it = await readItem(path.dirname(p), path.basename(p));
    if (it) it.used = when;
    return it;
  }))).filter((it): it is Item => !!it && (!it.dir || it.package));
  await addInfo(items);
  if (!hidden) items = items.filter((it) => !it.hidden);
  return { path: RECENTS, items, writable: false };
}

// ---------- iCloud Drive ----------

const icloudOn = () => fs.existsSync(CLOUD_DOCS);

// iCloud Drive's own files, and a folder for each app that keeps its
// documents in iCloud (com~apple~Pages/Documents shows as Pages).
async function listICloud(readItem: ReadItem, addInfo: AddInfo, { hidden }: { hidden: boolean }): Promise<Listing> {
  if (!icloudOn()) return { path: ICLOUD, error: 'icloud' };
  const names = await fs.promises.readdir(CLOUD_DOCS).catch((): string[] => []);
  let items = (await Promise.all(names.map((n) => readItem(CLOUD_DOCS, n)))).filter((it) => it !== null);
  await addInfo(items);
  const containers = (await fs.promises.readdir(MOBILE).catch((): string[] => [])).filter((c) => c !== 'com~apple~CloudDocs' && !c.startsWith('.'));
  const apps: (Item & { bundle: string })[] = [];
  for (const c of containers) {
    const docs = path.join(MOBILE, c, 'Documents');
    const inside = await fs.promises.readdir(docs).catch((): string[] => []);
    if (!inside.filter((n) => !n.startsWith('.')).length) continue;
    const it = await readItem(path.join(MOBILE, c), 'Documents');
    if (!it) continue;
    apps.push(Object.assign(it, { bundle: c.replace(/^iCloud~/, '').replace(/~/g, '.') }));
  }
  const res = apps.length ? await helper.request('appNames', { ids: apps.map((a) => a.bundle) }) : null;
  apps.forEach((a, i) => {
    // split gives at least one part, so pop always has one.
    a.display = (res && res.names[i]) || (a.bundle.split('.').pop() as string);
    a.kind = 'Folder';
  });
  items = items.concat(apps);
  if (!hidden) items = items.filter((it) => !it.hidden);
  return { path: ICLOUD, items, writable: false };
}

// The place a real folder belongs to, for Up: the Trash's folder is the
// Trash, iCloud's own folder and the apps' Documents folders are iCloud Drive.
function placeOf(dir: string) {
  if (trashDirs().some(([d]) => d === dir)) return TRASH;
  if (dir === CLOUD_DOCS || (path.dirname(path.dirname(dir)) === MOBILE && path.basename(dir) === 'Documents')) return ICLOUD;
  return null;
}

// A plain exports object, the way CommonJS has it, so a unit test can put a
// stand-in in place of one of these functions and the other modules use it.
export = {
  TRASH, RECENTS, ICLOUD, HOME_TRASH, CLOUD_DOCS, trashDirs, inTrash, putBack, moveAll, deleteNow, logTrashed,
  listTrash, listRecents, listICloud, icloudOn, placeOf, putBackRecords
};
