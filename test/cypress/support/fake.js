// A stand-in for the preload's window.filedrawer, with the same function
// names (read from src/preload.js). Every function the page calls is noted
// in calls as [name, ...args]. Folders come from a made up tree, a map of
// folder path to its entries (a name ending in / is a folder), and renames,
// new folders and the Trash change it and tell the page, like the folder
// watch does. emit(channel, payload) sends what an on... function listens
// for (onCommand is 'command', onJob is 'job').
const TREE = {
  '/Users/test': ['Documents/', 'Pictures/', 'Projects/', 'notes.txt', 'photo.jpg', '.hidden'],
  '/Users/test/Documents': ['Report.pdf', 'Budget.txt'],
  '/Users/test/Pictures': [],
  '/Users/test/Projects': ['Startbar/', 'Filedrawer/'],
  '/Users/test/Projects/Startbar': [],
  '/Users/test/Projects/Filedrawer': []
};

const KINDS = { txt: 'Plain Text Document', jpg: 'JPEG Image', pdf: 'PDF Document' };
const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

function item(dir, entry) {
  const isDir = entry.endsWith('/');
  const name = isDir ? entry.slice(0, -1) : entry;
  const ext = isDir || !name.includes('.') ? '' : name.split('.').pop().toLowerCase();
  return {
    name, display: name, path: `${dir}/${name}`, dir: isDir, package: false, link: false, ext,
    size: isDir ? null : 1024 * (name.length + 1), modified: Date.UTC(2026, 9, 1 + name.length), created: Date.UTC(2026, 0, 1),
    hidden: name.startsWith('.'), kind: isDir ? 'Folder' : KINDS[ext] || 'Document', fixed: false, canAdd: isDir
  };
}

export function fakeFiledrawer(names, state, extra = {}) {
  const tree = JSON.parse(JSON.stringify(extra.tree || TREE));
  const calls = [];
  const listeners = {};
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const emit = (channel, payload) => (listeners[channel] || []).forEach((fn) => fn(payload));
  const changed = (dir) => setTimeout(() => emit('folderChanged', dir));
  const entryOf = (p) => (tree[dirname(p)] || []).find((e) => e.replace(/\/$/, '') === basename(p));
  const add = (dir, entry) => {
    tree[dir].push(entry);
    if (entry.endsWith('/')) tree[`${dir}/${entry.slice(0, -1)}`] = [];
    changed(dir);
    return { path: `${dir}/${entry.replace(/\/$/, '')}` };
  };
  const freeName = (dir, base) => {
    let n = 1;
    const taken = (name) => (tree[dir] || []).some((e) => e.replace(/\/$/, '') === name);
    while (taken(n === 1 ? base : `${base} (${n})`)) n++;
    return n === 1 ? base : `${base} (${n})`;
  };
  const answers = {
    getState: () => copy(state),
    list: (dir, opts = {}) => {
      if (!tree[dir]) return { path: dir, error: 'missing' };
      const items = tree[dir].map((e) => item(dir, e)).filter((it) => opts.hidden || !it.hidden);
      return { path: dir, items, modified: Date.UTC(2026, 9, 1), writable: true };
    },
    resolve: (text, cwd) => {
      let p = text.trim().replace(/^~(?=\/|$)/, state.home);
      if (!p.startsWith('/')) p = `${cwd}/${p}`;
      p = p.replace(/\/+$/, '') || '/';
      if (tree[p]) return { type: 'dir', path: p };
      return { type: entryOf(p) ? 'file' : 'missing', path: p };
    },
    complete: (text) => {
      const parent = text.endsWith('/') ? text.replace(/\/+$/, '') : dirname(text);
      const prefix = text.endsWith('/') ? '' : basename(text).toLowerCase();
      return (tree[parent] || []).filter((e) => e.endsWith('/') && e.toLowerCase().startsWith(prefix))
        .map((e) => ({ path: `${parent}/${e.slice(0, -1)}`, value: `${parent}/${e.slice(0, -1)}` }));
    },
    volume: () => ({ name: 'Macintosh HD', free: 100e9 }),
    count: (dir) => (tree[dir] ? tree[dir].filter((e) => !e.startsWith('.')).length : null),
    icons: () => ({}),
    thumbs: () => ({}),
    placeOf: () => null,
    waitFolder: () => null,
    askExtension: () => false,
    openWithApps: () => [],
    terminals: () => [{ name: 'Terminal', path: '/System/Applications/Utilities/Terminal.app', icon: '' }],
    undo: () => ({}),
    rename: (from, name) => {
      const dir = dirname(from);
      const entry = entryOf(from);
      tree[dir] = tree[dir].map((e) => (e === entry ? name + (entry.endsWith('/') ? '/' : '') : e));
      changed(dir);
      return { path: `${dir}/${name}` };
    },
    newFolder: (dir) => add(dir, freeName(dir, 'New Folder') + '/'),
    newText: (dir) => add(dir, freeName(dir, 'New Text Document') + '.txt'),
    trash: (paths) => {
      for (const p of paths) {
        tree[dirname(p)] = tree[dirname(p)].filter((e) => e !== entryOf(p));
        changed(dirname(p));
      }
      return { items: paths.map((p) => ({ from: p, to: `${state.home}/.Trash/${basename(p)}` })) };
    },
    updateSettings: (patch) => {
      state.settings = merge(state.settings, patch);
      setTimeout(() => emit('state', copy(state)));
      return copy(state.settings);
    }
  };
  const api = { calls, emit, state, tree };
  for (const name of names) {
    if (/^on[A-Z]/.test(name)) {
      const channel = name[2].toLowerCase() + name.slice(3);
      api[name] = (fn) => {
        (listeners[channel] = listeners[channel] || []).push(fn);
        return () => {};
      };
    } else {
      api[name] = (...args) => {
        calls.push([name, ...args]);
        return name in answers ? Promise.resolve(answers[name](...args)) : undefined;
      };
    }
  }
  return api;
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...base };
  for (const key of Object.keys(over)) {
    const b = base ? base[key] : undefined;
    out[key] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, over[key]) : over[key];
  }
  return out;
}
