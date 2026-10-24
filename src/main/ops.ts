// Changing things on disk: renaming, making new folders and text files, and
// moving to the Trash and back. Each call answers { path } (or { items }) on
// success or { error } with a message for the user, which the caller shows.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import helper = require('./helper');
import places = require('./places');
import type { OpResult, TrashedItem, TrashResult } from '../shared/types';

function message(err: NodeJS.ErrnoException, what: string) {
  if (err.code === 'EACCES' || err.code === 'EPERM') return `Filedrawer doesn't have permission to ${what} here.`;
  if (err.code === 'ENOENT') return 'The item isn\'t there anymore.';
  if (err.code === 'ENOSPC') return 'There isn\'t enough free space on the disk.';
  if (err.code === 'EROFS') return 'This disk can only be read, not changed.';
  return `The item couldn't be ${what === 'rename it' ? 'renamed' : 'made'}. ${err.message}`;
}

const exists = (p: string) => fs.promises.lstat(p).then(() => true, () => false);

// base, or "base (2)", "base (3)" and so on, whichever isn't taken. The
// number goes before the extension, as in "New Text Document (2).txt". An
// extension with a space isn't one ("a.txt alias" gets "a.txt alias (2)").
async function freeName(dir: string, base: string) {
  const ext = /\s/.test(path.extname(base)) ? '' : path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} (${n})${ext}`;
    if (!(await exists(path.join(dir, name)))) return name;
  }
}

function badName(name: string) {
  if (!name.trim()) return 'A name can\'t be empty.';
  if (name.includes('/')) return 'A name can\'t have a slash (/) in it.';
  if (name === '.' || name === '..') return `"${name}" can't be used as a name.`;
  if (Buffer.byteLength(name) > 255) return 'That name is too long.';
  return null;
}

async function rename(from: string, name: string): Promise<OpResult> {
  const bad = badName(name);
  if (bad) return { error: bad };
  const to = path.join(path.dirname(from), name);
  if (to === from) return { path: from };
  // A change of capitals only is the same file on the Mac's disks, so it's not a clash.
  if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) {
    return { error: `There's already an item named "${name}" in this folder.` };
  }
  try {
    await fs.promises.rename(from, to);
    return { path: to };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      const flags = await helper.request('flags', { path: from });
      if (flags && flags.locked) return { error: `"${path.basename(from)}" is locked. Unlock it in Properties to rename it.` };
    }
    return { error: message(err as NodeJS.ErrnoException, 'rename it') };
  }
}

async function newFolder(dir: string): Promise<OpResult> {
  try {
    const p = path.join(dir, await freeName(dir, 'New Folder'));
    await fs.promises.mkdir(p);
    return { path: p };
  } catch (err) {
    return { error: message(err as NodeJS.ErrnoException, 'make a folder') };
  }
}

async function newTextFile(dir: string): Promise<OpResult> {
  try {
    const p = path.join(dir, await freeName(dir, 'New Text Document.txt'));
    await fs.promises.writeFile(p, '', { flag: 'wx' });
    return { path: p };
  } catch (err) {
    return { error: message(err as NodeJS.ErrnoException, 'make a file') };
  }
}

// { items: [{ from, to }] } for what reached the Trash, with an error for
// anything that didn't.
async function trash(paths: string[]): Promise<TrashResult> {
  const res = await helper.request('trash', { paths });
  if (!res) return { error: 'The items couldn\'t be moved to the Trash.', items: [] };
  const moved = res.items.filter((it): it is TrashedItem => !!it.to);
  // Only an item with an error failed. One macOS moved without saying where
  // it went is in the Trash all the same, it just can't be put back from here.
  const failed = res.items.filter((it) => !!it.error);
  places.logTrashed(moved); // so Put Back knows where they came from
  if (!failed.length) return { items: moved };
  const name = path.basename(failed[0].from);
  const error = failed.length === 1 ? `"${name}" couldn't be moved to the Trash. ${failed[0].error}`
    : `${failed.length} items couldn't be moved to the Trash. ${failed[0].error}`;
  return { error, items: moved };
}

// Puts trashed items back where they were, for Undo.
async function untrash(items: TrashedItem[]): Promise<{ error?: string }> {
  for (const it of items) {
    if (await exists(it.from)) return { error: `There's already an item named "${path.basename(it.from)}" where it came from.` };
  }
  for (const it of items) {
    const res = await helper.request('move', { from: it.to, to: it.from });
    if (!res) return { error: `"${path.basename(it.from)}" couldn't be put back. It may have been taken out of the Trash.` };
  }
  return {};
}

// A zip of the items next to them, named after the first one ("Report.zip").
// One item goes through ditto, which keeps Mac extras the way Finder does;
// more than one through zip.
async function compress(paths: string[]): Promise<OpResult> {
  const dir = path.dirname(paths[0]);
  const first = path.basename(paths[0]);
  const stem = (await fs.promises.stat(paths[0])).isDirectory() ? first : path.basename(first, path.extname(first)) || first;
  const out = path.join(dir, await freeName(dir, `${stem}.zip`));
  const args: [string, string[]] = paths.length === 1 ? ['ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', paths[0], out]]
    : ['zip', ['-r', '-y', '-q', out, ...paths.map((p) => path.basename(p))]];
  return new Promise((resolve) => {
    execFile(args[0], args[1], { cwd: dir }, (err) => {
      if (err) {
        fs.promises.rm(out, { force: true }).catch(() => {});
        resolve({ error: 'The compressed folder couldn\'t be made.' });
      } else {
        resolve({ path: out });
      }
    });
  });
}

// A Finder alias of an item in another folder, named "X alias".
async function alias(src: string, destDir: string): Promise<OpResult> {
  const out = path.join(destDir, await freeName(destDir, `${path.basename(src)} alias`));
  const res = await helper.request('alias', { path: src, to: out }, { withError: true });
  if (!res || res.error) return { error: `The alias couldn't be made. ${res ? res.error : ''}`.trim() };
  return { path: out };
}

// Through diskutil, which says which app is holding a disk that's in use.
function eject(volume: string) {
  return new Promise<OpResult>((resolve) => {
    execFile('diskutil', ['eject', volume], (err, _out, stderr) => {
      if (!err) return resolve({});
      const why = /dissented by PID (\d+)(?: \(([^)]+)\))?/.exec(stderr || '');
      const name = path.basename(volume);
      if (why) resolve({ error: `"${name}" couldn't be ejected because ${why[2] ? path.basename(why[2]) : 'another app'} is using it.` });
      else resolve({ error: `"${name}" couldn't be ejected. ${(stderr || '').trim()}`.trim() });
    });
  });
}

// A plain exports object, the way CommonJS has it, so a unit test can put a
// stand-in in place of one of these functions and the other modules use it.
export = { rename, newFolder, newTextFile, trash, untrash, compress, alias, eject, freeName, exists };
