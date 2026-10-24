// Files on the Mac and on SSH sites behind one set of calls, so copying
// and moving work the same between any two of them. A path on a site is
// ::site/<id>/... (see sites.ts); anything else is on the Mac.
import fs from 'fs';
import path from 'path';
import * as remote from './remote';
import * as sites from './sites';
import type { Stats } from '../vendor/ssh2';

export interface Stat {
  dir: boolean;
  link: boolean;
  size: number;
  mode: number;
  atime: number; // seconds
  mtime: number; // seconds
  dev: string; // the same for two paths a rename can move between
}

const onSite = sites.isRemote;
const call = <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
// Some ssh2 calls answer with an error alone.
const done = (fn: (cb: (err?: Error | null) => void) => void) =>
  new Promise<void>((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

function fromSite(st: Stats, id: string): Stat {
  return { dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.size, mode: st.mode, atime: st.atime, mtime: st.mtime, dev: `site:${id}` };
}

function fromMac(st: fs.Stats): Stat {
  return {
    dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.size, mode: st.mode,
    atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000, dev: `mac:${st.dev}`
  };
}

export async function lstat(p: string): Promise<Stat> {
  if (!onSite(p)) return fromMac(await fs.promises.lstat(p));
  const a = await remote.at(p);
  return fromSite(await a.run(call<Stats>((cb) => a.sftp.lstat(a.path, cb))), a.id);
}

export async function stat(p: string): Promise<Stat> {
  if (!onSite(p)) return fromMac(await fs.promises.stat(p));
  const a = await remote.at(p);
  return fromSite(await a.run(call<Stats>((cb) => a.sftp.stat(a.path, cb))), a.id);
}

export const exists = (p: string) => lstat(p).then(() => true, () => false);

// The folder a path is in, and a path in a folder, for either kind.
export const dirname = (p: string) => (onSite(p) && /^::site\/[^/]+$/.test(p) ? p : onSite(p) ? p.replace(/\/[^/]*$/, '') : path.dirname(p));
export const join = (dir: string, name: string) => (onSite(dir) ? `${dir.replace(/\/+$/, '')}/${name}` : path.join(dir, name));
export const basename = (p: string) => (onSite(p) ? p.slice(p.lastIndexOf('/') + 1) : path.basename(p));

export async function readdir(p: string): Promise<string[]> {
  if (!onSite(p)) return fs.promises.readdir(p);
  const a = await remote.at(p);
  const list = await a.run(call<{ filename: string }[]>((cb) => a.sftp.readdir(a.path, cb)));
  return list.map((e) => e.filename).filter((n) => n !== '.' && n !== '..');
}

export async function mkdir(p: string) {
  if (!onSite(p)) return fs.promises.mkdir(p);
  const a = await remote.at(p);
  await a.run(done((cb) => a.sftp.mkdir(a.path, cb)));
}

export async function rename(from: string, to: string) {
  if (!onSite(from)) return fs.promises.rename(from, to);
  const a = await remote.at(from);
  const b = sites.split(to);
  if (!b || b.id !== a.id) throw new Error('A rename stays on one site.');
  await a.run(done((cb) => a.sftp.rename(a.path, b.path, cb)));
}

// Takes a file or a whole folder away for good.
export async function rmTree(p: string): Promise<void> {
  if (!onSite(p)) return fs.promises.rm(p, { recursive: true, force: true });
  const st = await lstat(p).catch(() => null);
  if (!st) return;
  const a = await remote.at(p);
  if (st.dir && !st.link) {
    for (const name of await readdir(p)) await rmTree(join(p, name));
    await a.run(done((cb) => a.sftp.rmdir(a.path, cb)));
  } else {
    await a.run(done((cb) => a.sftp.unlink(a.path, cb)));
  }
}

export async function readlink(p: string): Promise<string> {
  if (!onSite(p)) return fs.promises.readlink(p);
  const a = await remote.at(p);
  return a.run(call<string>((cb) => a.sftp.readlink(a.path, cb)));
}

export async function symlink(target: string, p: string) {
  if (!onSite(p)) return fs.promises.symlink(target, p);
  const a = await remote.at(p);
  await a.run(done((cb) => a.sftp.symlink(target, a.path, cb)));
}

// The mode and dates an item had, on its copy. Neither is worth failing a copy over.
export async function keepLook(p: string, st: Stat) {
  if (!onSite(p)) {
    await fs.promises.chmod(p, st.mode & 0o7777).catch(() => {});
    await fs.promises.utimes(p, st.atime, st.mtime).catch(() => {});
    return;
  }
  const a = await remote.at(p).catch(() => null);
  if (!a) return;
  await a.run(done((cb) => a.sftp.chmod(a.path, st.mode & 0o777, cb))).catch(() => {});
  await a.run(done((cb) => a.sftp.utimes(a.path, st.atime, st.mtime, cb))).catch(() => {});
}

// An empty file, failing when the name is taken.
export async function makeEmpty(p: string) {
  if (!onSite(p)) return fs.promises.writeFile(p, '', { flag: 'wx' });
  const a = await remote.at(p);
  const handle = await a.run(call<Buffer>((cb) => a.sftp.open(a.path, 'wx', cb)));
  await a.run(done((cb) => a.sftp.close(handle, cb)));
}

// base, or "base (2)" and so on, whichever isn't taken in dir.
export async function freeName(dir: string, base: string) {
  const ext = /\s/.test(path.extname(base)) ? '' : path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} (${n})${ext}`;
    if (!(await exists(join(dir, name)))) return name;
  }
}

// One file's bytes from src to dst, which isn't there yet. progress hears
// how much of it has gone; stop() says the job was cancelled, which drops
// the site connection to end a transfer that's going on.
export async function copyFile(src: string, dst: string, progress: (bytes: number) => void, stop: () => boolean) {
  if (!onSite(src) && !onSite(dst)) {
    // A clone where the disk can, a full copy with the file's dates and extras otherwise.
    await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    return;
  }
  const watch = (id: string) => (total: number) => {
    if (stop()) remote.drop(id);
    else progress(total);
  };
  if (!onSite(src)) {
    const b = await remote.at(dst);
    await done((cb) => b.sftp.fastPut(src, b.path, { step: watch(b.id) }, cb));
    return;
  }
  const a = await remote.at(src);
  if (!onSite(dst)) {
    await done((cb) => a.sftp.fastGet(a.path, dst, { step: watch(a.id) }, cb));
    return;
  }
  // Site to site, through Filedrawer.
  const b = await remote.at(dst);
  await new Promise<void>((resolve, reject) => {
    const from = a.sftp.createReadStream(a.path);
    const to = b.sftp.createWriteStream(b.path, { flags: 'wx' });
    let sent = 0;
    from.on('data', (chunk: Buffer) => {
      sent += chunk.length;
      if (stop()) {
        from.destroy();
        to.destroy();
        reject(new Error('cancelled'));
      } else {
        progress(sent);
      }
    });
    from.on('error', reject);
    to.on('error', reject);
    to.on('close', () => resolve());
    from.pipe(to);
  });
}
