// Changing things on disk: renaming, making new folders and text files, and
// moving to the Trash and back. Each call answers { path } (or { items }) on
// success or { error } with a message for the user, which the caller shows.
const fs = require('fs');
const path = require('path');
const helper = require('./helper');

function message(err, what) {
  if (err.code === 'EACCES' || err.code === 'EPERM') return `Filedrawer doesn't have permission to ${what} here.`;
  if (err.code === 'ENOENT') return 'The item isn\'t there anymore.';
  if (err.code === 'ENOSPC') return 'There isn\'t enough free space on the disk.';
  if (err.code === 'EROFS') return 'This disk can only be read, not changed.';
  return `The item couldn't be ${what === 'rename it' ? 'renamed' : 'made'}. ${err.message}`;
}

const exists = (p) => fs.promises.lstat(p).then(() => true, () => false);

// base, or "base (2)", "base (3)" and so on, whichever isn't taken. The
// number goes before the extension, as in "New Text Document (2).txt".
async function freeName(dir, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} (${n})${ext}`;
    if (!(await exists(path.join(dir, name)))) return name;
  }
}

function badName(name) {
  if (!name.trim()) return 'A name can\'t be empty.';
  if (name.includes('/')) return 'A name can\'t have a slash (/) in it.';
  if (name === '.' || name === '..') return `"${name}" can't be used as a name.`;
  if (Buffer.byteLength(name) > 255) return 'That name is too long.';
  return null;
}

async function rename(from, name) {
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
    if (err.code === 'EPERM') {
      const flags = await helper.request('flags', { path: from });
      if (flags && flags.locked) return { error: `"${path.basename(from)}" is locked. Unlock it in Properties to rename it.` };
    }
    return { error: message(err, 'rename it') };
  }
}

async function newFolder(dir) {
  try {
    const p = path.join(dir, await freeName(dir, 'New Folder'));
    await fs.promises.mkdir(p);
    return { path: p };
  } catch (err) {
    return { error: message(err, 'make a folder') };
  }
}

async function newTextFile(dir) {
  try {
    const p = path.join(dir, await freeName(dir, 'New Text Document.txt'));
    await fs.promises.writeFile(p, '', { flag: 'wx' });
    return { path: p };
  } catch (err) {
    return { error: message(err, 'make a file') };
  }
}

// { items: [{ from, to }] } for what reached the Trash, with an error for
// anything that didn't.
async function trash(paths) {
  const res = await helper.request('trash', { paths });
  if (!res) return { error: 'The items couldn\'t be moved to the Trash.', items: [] };
  const moved = res.items.filter((it) => it.to);
  const failed = res.items.filter((it) => !it.to);
  if (!failed.length) return { items: moved };
  const name = path.basename(failed[0].from);
  const error = failed.length === 1 ? `"${name}" couldn't be moved to the Trash. ${failed[0].error}`
    : `${failed.length} items couldn't be moved to the Trash. ${failed[0].error}`;
  return { error, items: moved };
}

// Puts trashed items back where they were, for Undo.
async function untrash(items) {
  for (const it of items) {
    if (await exists(it.from)) return { error: `There's already an item named "${path.basename(it.from)}" where it came from.` };
  }
  for (const it of items) {
    const res = await helper.request('move', { from: it.to, to: it.from });
    if (!res) return { error: `"${path.basename(it.from)}" couldn't be put back. It may have been taken out of the Trash.` };
  }
  return {};
}

module.exports = { rename, newFolder, newTextFile, trash, untrash, freeName, exists };
