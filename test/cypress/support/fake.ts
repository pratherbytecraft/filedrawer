// A stand-in for the preload's window.filedrawer, with the same function
// names (read from src/preload.ts). Every function the page calls is noted
// in calls as [name, ...args]. Folders come from a made up tree, a map of
// folder path to its entries (a name ending in / is a folder), and renames,
// new folders and the Trash change it and tell the page, like the folder
// watch does. emit(channel, payload) sends what an on... function listens
// for (onCommand is 'command', onJob is 'job').
import type { FiledrawerApi, Item, ListOptions, Settings, SettingsPatch, State } from '../../../src/shared/types';

// Folder path to its entries, a name ending in / for a folder.
export type Tree = Record<string, string[]>;

export interface Extra {
  tree?: Tree;
}

export type Fake = FiledrawerApi & {
  calls: unknown[][];
  emit: (channel: string, payload?: unknown) => void;
  state: State;
  tree: Tree;
};

type Listener = (payload: unknown) => void;

const TREE: Tree = {
  '/Users/test': ['Documents/', 'Pictures/', 'Projects/', 'notes.txt', 'photo.jpg', '.hidden'],
  '/Users/test/Documents': ['Report.pdf', 'Budget.txt'],
  '/Users/test/Pictures': [],
  '/Users/test/Projects': ['Startbar/', 'Filedrawer/'],
  '/Users/test/Projects/Startbar': [],
  '/Users/test/Projects/Filedrawer': []
};

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const KINDS: Record<string, string> = { txt: 'Plain Text Document', jpg: 'JPEG Image', pdf: 'PDF Document' };
const dirname = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function item(dir: string, entry: string): Item {
  const isDir = entry.endsWith('/');
  const name = isDir ? entry.slice(0, -1) : entry;
  const ext = isDir || !name.includes('.') ? '' : (name.split('.').pop() as string).toLowerCase();
  return {
    name, display: name, path: `${dir}/${name}`, dir: isDir, package: false, link: false, ext,
    size: isDir ? null : 1024 * (name.length + 1), modified: Date.UTC(2026, 9, 1 + name.length), created: Date.UTC(2026, 0, 1),
    added: Date.UTC(2026, 9, 25 - name.length),
    hidden: name.startsWith('.'), kind: isDir ? 'Folder' : KINDS[ext] || 'Document', fixed: false, canAdd: isDir
  };
}

export function fakeFiledrawer(names: string[], state: State, extra: Extra = {}): Fake {
  const tree: Tree = JSON.parse(JSON.stringify(extra.tree || TREE));
  const calls: unknown[][] = [];
  const listeners: Record<string, Listener[]> = {};
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const emit = (channel: string, payload?: unknown) => (listeners[channel] || []).forEach((fn) => fn(payload));
  const changed = (dir: string) => setTimeout(() => emit('folderChanged', dir));
  const entryOf = (p: string) => (tree[dirname(p)] || []).find((e) => e.replace(/\/$/, '') === basename(p));
  const add = (dir: string, entry: string) => {
    tree[dir].push(entry);
    if (entry.endsWith('/')) tree[`${dir}/${entry.slice(0, -1)}`] = [];
    changed(dir);
    return { path: `${dir}/${entry.replace(/\/$/, '')}` };
  };
  const freeName = (dir: string, base: string) => {
    let n = 1;
    const taken = (name: string) => (tree[dir] || []).some((e) => e.replace(/\/$/, '') === name);
    while (taken(n === 1 ? base : `${base} (${n})`)) n++;
    return n === 1 ? base : `${base} (${n})`;
  };
  const answers: Record<string, (...args: any[]) => unknown> = {
    getState: () => copy(state),
    list: (dir: string, opts: ListOptions = {}) => {
      if (!tree[dir]) return { path: dir, error: 'missing' };
      const items = tree[dir].map((e) => item(dir, e)).filter((it) => opts.hidden || !it.hidden);
      return { path: dir, items, modified: Date.UTC(2026, 9, 1), writable: true };
    },
    resolve: (text: string, cwd: string) => {
      let p = text.trim().replace(/^~(?=\/|$)/, state.home);
      if (!p.startsWith('/')) p = `${cwd}/${p}`;
      p = p.replace(/\/+$/, '') || '/';
      if (tree[p]) return { type: 'dir', path: p };
      return { type: entryOf(p) ? 'file' : 'missing', path: p };
    },
    complete: (text: string) => {
      const parent = text.endsWith('/') ? text.replace(/\/+$/, '') : dirname(text);
      const prefix = text.endsWith('/') ? '' : basename(text).toLowerCase();
      return (tree[parent] || []).filter((e) => e.endsWith('/') && e.toLowerCase().startsWith(prefix))
        .map((e) => ({ path: `${parent}/${e.slice(0, -1)}`, value: `${parent}/${e.slice(0, -1)}` }));
    },
    volume: () => ({ name: 'Macintosh HD', free: 100e9 }),
    count: (dir: string) => (tree[dir] ? tree[dir].filter((e) => !e.startsWith('.')).length : null),
    icons: () => ({}),
    // Pictures and PDFs get a one pixel picture, like Quick Look would draw.
    thumbs: (paths: string[]) => Object.fromEntries(paths.filter((p) => /\.(jpe?g|png|pdf)$/i.test(p)).map((p) => [p, PIXEL])),
    placeOf: () => null,
    waitFolder: () => null,
    askExtension: () => false,
    openWithApps: () => [],
    terminals: () => [{ name: 'Terminal', path: '/System/Applications/Utilities/Terminal.app', icon: '' }],
    undo: () => ({}),
    rename: (from: string, name: string) => {
      const dir = dirname(from);
      const entry = entryOf(from);
      // The page renames an item it listed, so its entry is there.
      tree[dir] = tree[dir].map((e) => (e === entry ? name + (entry!.endsWith('/') ? '/' : '') : e));
      changed(dir);
      return { path: `${dir}/${name}` };
    },
    newFolder: (dir: string) => add(dir, freeName(dir, 'New Folder') + '/'),
    newText: (dir: string) => add(dir, freeName(dir, 'New Text Document') + '.txt'),
    trash: (paths: string[]) => {
      for (const p of paths) {
        tree[dirname(p)] = tree[dirname(p)].filter((e) => e !== entryOf(p));
        changed(dirname(p));
      }
      return { items: paths.map((p) => ({ from: p, to: `${state.home}/.Trash/${basename(p)}` })) };
    },
    updateSettings: (patch: SettingsPatch) => {
      state.settings = merge(state.settings, patch) as Settings;
      setTimeout(() => emit('state', copy(state)));
      return copy(state.settings);
    }
  };
  const api: Record<string, unknown> = { calls, emit, state, tree };
  for (const name of names) {
    if (/^on[A-Z]/.test(name)) {
      const channel = name[2].toLowerCase() + name.slice(3);
      api[name] = (fn: Listener) => {
        (listeners[channel] = listeners[channel] || []).push(fn);
        return () => {};
      };
    } else {
      api[name] = (...args: unknown[]) => {
        calls.push([name, ...args]);
        return name in answers ? Promise.resolve(answers[name](...args)) : undefined;
      };
    }
  }
  return api as unknown as Fake;
}

type Obj = Record<string, unknown>;

function merge(base: unknown, over: unknown): unknown {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over;
  const out: Obj = { ...(base as Obj) };
  for (const key of Object.keys(over)) {
    const b = base ? (base as Obj)[key] : undefined;
    out[key] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, (over as Obj)[key]) : (over as Obj)[key];
  }
  return out;
}
