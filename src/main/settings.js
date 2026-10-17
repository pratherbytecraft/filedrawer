// Settings live in ~/Library/Application Support/Filedrawer/settings.json.
// Missing keys fall back to the defaults, so a settings file from an older
// version keeps working after an update.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  theme: 'system', // system | classic-2009 | classic-2001 | classic-1995
  // Each classic theme's color scheme, kept apart so switching themes back keeps it.
  schemes: {
    'classic-2009': 'sky',
    'classic-2001': 'blue',
    'classic-1995': 'standard'
  },
  appearance: 'auto', // auto | light | dark
  accent: 'auto', // auto | blue | purple | pink | red | orange | yellow | green | graphite
  view: 'details', // the view picked last
  newWindowView: 'last', // last (the view picked last) | thumbs | tiles | icons | list | details
  startFolder: 'home', // home | documents | desktop | computer | custom (startPath)
  startPath: '',
  openFolders: 'same', // same | new | tab: opening a folder replaces this window's, opens a new window or a new tab
  clickToOpen: 'double', // double | single
  showPane: true, // the left pane; off, the Folders button still shows the tree
  perFolderView: false, // each folder keeps its own view (folderViews)
  folderViews: {}, // folder path -> view, while perFolderView is on
  previews: true, // pictures, PDFs and the like show what's in them in place of their icon in every view (Thumbnails always does)
  showExtensions: false, // every extension, not only the ones the Mac shows
  fullPathTitle: false, // the whole path in the title bar
  foldersFirst: true, // folders above files whatever the sort
  confirmTrash: false, // ask before moving items to the Trash
  terminalButton: true, // Open Terminal Here on the toolbar
  hiddenButton: true, // Hidden Files on the toolbar
  takeOverFinder: true, // Finder's new folder windows open in Filedrawer, in the same spot
  welcomed: false, // the first launch note has been shown
  updates: {
    auto: true // check npm for a newer version now and then, never installs
  },
  pane: 'tasks', // tasks | folders: the left pane a new window opens with, the one picked last
  showHidden: false, // files the Mac keeps out of sight, shown dimmed
  pins: [], // pinned folders, as paths, in the order shown
  // Which places Other Places shows (Recents and iCloud Drive in the tree too).
  places: {
    recents: true, home: true, desktop: true, documents: true, downloads: true,
    applications: true, icloud: true, computer: true, trash: true
  },
  terminal: 'Terminal', // the app Open Terminal Here opens, by name or path
  openWith: {}, // extension -> the apps picked for it in the app list, last picked first
  folderSorts: {}, // folder path -> { key, dir }, picked from its headers or Arrange Icons By; other folders sort by name
  // Details column widths in points, one set per kind of list (files, trash,
  // recents, computer, search), once a column was resized; until then the
  // columns share the window.
  columnWidths: {},
  window: {
    width: 960,
    height: 620
  }
});

const SORT_KEYS = ['name', 'size', 'kind', 'modified', 'deleted', 'from', 'used'];

let dir;
let file;
let current;
const listeners = new Set();

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const key of Object.keys(over)) {
    const b = base[key];
    out[key] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, over[key]) : over[key];
  }
  return out;
}

// Only the keys Filedrawer knows, each with the same kind of value as its
// default. A value of the wrong kind, from a hand-edited file say, falls
// back to the default instead of being taken as it is.
function clean(saved, base) {
  const out = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const key of Object.keys(base)) {
    const b = base[key];
    const v = saved[key];
    if (v === undefined) continue;
    if (base === DEFAULTS && key === 'folderViews') {
      // Any folder can be in here, so only the values are checked.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.folderViews = {};
        for (const [k, view] of Object.entries(v)) if (typeof view === 'string') out.folderViews[k] = view;
      }
    } else if (base === DEFAULTS && key === 'folderSorts') {
      // Any folder can be in here, each with a known key and a direction.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.folderSorts = {};
        for (const [k, sort] of Object.entries(v)) {
          if (sort && SORT_KEYS.includes(sort.key) && (sort.dir === 'asc' || sort.dir === 'desc')) out.folderSorts[k] = { key: sort.key, dir: sort.dir };
        }
      }
    } else if (base === DEFAULTS && key === 'columnWidths') {
      // Each kind of list with its columns' widths, whole points above zero.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.columnWidths = {};
        for (const [set, cols] of Object.entries(v)) {
          if (!cols || typeof cols !== 'object' || Array.isArray(cols)) continue;
          const kept = Object.entries(cols).filter(([, w]) => Number.isFinite(w) && w > 0);
          if (kept.length) out.columnWidths[set] = Object.fromEntries(kept.map(([c, w]) => [c, Math.round(w)]));
        }
      }
    } else if (base === DEFAULTS && key === 'openWith') {
      // Any extension can be in here, each with a list of app paths.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.openWith = {};
        for (const [k, apps] of Object.entries(v)) if (Array.isArray(apps)) out.openWith[k] = apps.filter((x) => typeof x === 'string');
      }
    } else if (Array.isArray(b)) {
      if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string');
    } else if (b && typeof b === 'object') {
      out[key] = clean(v, b);
    } else if (typeof v === typeof b) {
      out[key] = v;
    }
  }
  return out;
}

function init() {
  dir = path.join(app.getPath('appData'), 'Filedrawer');
  file = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    saved = {};
  }
  current = merge(DEFAULTS, clean(saved, DEFAULTS));
  return current;
}

function get() {
  return current;
}

function save() {
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  for (const fn of listeners) fn(current);
  return current;
}

function update(patch) {
  const next = clean(patch, DEFAULTS);
  current = merge(current, next);
  // A folder's view or sort, and the column widths, are replaced, not
  // merged, so one can be taken out.
  for (const key of ['folderViews', 'folderSorts', 'columnWidths']) if (next[key]) current = { ...current, [key]: next[key] };
  return save();
}

// Everything from saved, the rest from the defaults, for an import or a reset.
function replace(saved) {
  current = merge(DEFAULTS, clean(saved, DEFAULTS));
  return save();
}

function reset() {
  return replace({});
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { DEFAULTS, init, get, update, replace, reset, onChange };
