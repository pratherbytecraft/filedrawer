// Renaming, new folders, new text documents and deleting, on an SSH site.
// Each answers { path } on success or { error } with a message for the user.
// A server has no Trash, so a delete is for good (the window asks first).
import * as fsx from './fsx';
import { SiteError } from './remote';
import type { OpResult } from '../shared/types';

// SFTP's status codes: 2 no such file, 3 permission denied, 4 a plain failure.
function message(err: unknown, what: string) {
  if (err instanceof SiteError) return err.message;
  const code = (err as { code?: number }).code;
  if (code === 3) return `The server doesn't let you ${what} here.`;
  if (code === 2) return 'The item isn\'t there anymore.';
  return `The server couldn't ${what}. ${(err as Error).message}`;
}

function badName(name: string) {
  if (!name.trim()) return 'A name can\'t be empty.';
  if (name.includes('/')) return 'A name can\'t have a slash (/) in it.';
  if (name === '.' || name === '..') return `"${name}" can't be used as a name.`;
  if (Buffer.byteLength(name) > 255) return 'That name is too long.';
  return null;
}

export async function rename(from: string, name: string): Promise<OpResult> {
  const bad = badName(name);
  if (bad) return { error: bad };
  const to = fsx.join(fsx.dirname(from), name);
  if (to === from) return { path: from };
  // Servers tell capitals apart, so a change of capitals is a new name.
  if (await fsx.exists(to)) return { error: `There's already an item named "${name}" in this folder.` };
  try {
    await fsx.rename(from, to);
    return { path: to };
  } catch (err) {
    return { error: message(err, 'rename it') };
  }
}

export async function newFolder(dir: string): Promise<OpResult> {
  try {
    const p = fsx.join(dir, await fsx.freeName(dir, 'New Folder'));
    await fsx.mkdir(p);
    return { path: p };
  } catch (err) {
    return { error: message(err, 'make a folder') };
  }
}

export async function newTextFile(dir: string): Promise<OpResult> {
  try {
    const p = fsx.join(dir, await fsx.freeName(dir, 'New Text Document.txt'));
    await fsx.makeEmpty(p);
    return { path: p };
  } catch (err) {
    return { error: message(err, 'make a file') };
  }
}

// Deletes each item, folders with everything in them. Stops at the first
// one that can't go, and says which.
export async function remove(paths: string[]): Promise<{ removed: string[]; error?: string }> {
  const removed: string[] = [];
  for (const p of paths) {
    try {
      await fsx.rmTree(p);
      removed.push(p);
    } catch (err) {
      return { removed, error: `"${fsx.basename(p)}" couldn't be deleted. ${message(err, 'delete it')}` };
    }
  }
  return { removed };
}
