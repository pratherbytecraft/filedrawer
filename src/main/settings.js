// Settings live in ~/Library/Application Support/Filedrawer/settings.json.
// Missing keys fall back to the defaults, so a settings file from an older
// version keeps working after an update.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  theme: 'system', // system
  appearance: 'auto', // auto | light | dark
  accent: 'auto', // auto | blue | purple | pink | red | orange | yellow | green | graphite
  view: 'details', // the view a new window opens in, the one picked last
  pane: 'tasks', // tasks | folders: the left pane a new window opens with, the one picked last
  pins: [], // pinned folders, as paths, in the order shown
  terminal: 'Terminal', // the app Open Terminal Here opens, by name or path
  sort: {
    key: 'name', // name | size | kind | modified
    dir: 'asc' // asc | desc
  },
  window: {
    width: 960,
    height: 620
  }
});

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
    if (Array.isArray(b)) {
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
  current = merge(current, clean(patch, DEFAULTS));
  return save();
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { DEFAULTS, init, get, update, onChange };
