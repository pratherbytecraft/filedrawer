// Reading folders: the items in a folder with their sizes, dates, kinds and
// icons, what a typed address points at, the folder names that fill in the
// address bar, and the free space on a folder's volume.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helper = require('./helper');

const HOME = os.homedir();
const COMPUTER = '::computer'; // the place that lists the volumes

// Folders macOS asks about before an app may look inside. Filedrawer only
// looks inside one when the user opens it, never just to count its items.
const PROTECTED = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'].map((d) => path.join(HOME, d));
const INFO_CHUNK = 500; // paths per helper request

// Finder's Applications folder also shows the apps in /System/Applications.
const MERGED = { '/Applications': ['/System/Applications'] };

// Kinds for when the helper isn't there.
const KINDS = {
  txt: 'Plain Text Document', md: 'Markdown Document', pdf: 'PDF Document', rtf: 'Rich Text Document',
  jpg: 'JPEG Image', jpeg: 'JPEG Image', png: 'PNG Image', gif: 'GIF Image', heic: 'HEIC Image', svg: 'SVG Image',
  zip: 'ZIP Archive', dmg: 'Disk Image', mp3: 'MP3 Audio', m4a: 'Apple MPEG-4 Audio', mov: 'QuickTime Movie', mp4: 'MPEG-4 Movie',
  html: 'HTML Document', js: 'JavaScript Script', json: 'JSON Document', sh: 'Shell Script', app: 'Application'
};

function fallbackKind(item) {
  if (item.dir && !item.package) return 'Folder';
  return KINDS[item.ext] || (item.ext ? `${item.ext.toUpperCase()} File` : 'Document');
}

const PACKAGE_EXTS = new Set(['app', 'bundle', 'framework', 'plugin', 'kext', 'pkg', 'mpkg', 'photoslibrary', 'rtfd', 'xcodeproj', 'playground']);

async function readItem(dir, name) {
  const full = path.join(dir, name);
  let st;
  let link = false;
  try {
    const l = await fs.promises.lstat(full);
    link = l.isSymbolicLink();
    st = link ? await fs.promises.stat(full).catch(() => l) : l;
  } catch {
    return null;
  }
  const isDir = st.isDirectory();
  const ext = path.extname(name).slice(1).toLowerCase();
  return {
    name,
    display: name, // the name Finder shows, from the helper
    path: full,
    dir: isDir,
    package: isDir && PACKAGE_EXTS.has(ext),
    link,
    ext: isDir && !PACKAGE_EXTS.has(ext) ? '' : ext,
    size: isDir ? null : st.size,
    modified: st.mtimeMs,
    created: st.birthtimeMs,
    hidden: name.startsWith('.'),
    kind: ''
  };
}

// Display names, kinds, hidden flags and packages from the helper, in place.
async function addInfo(items) {
  for (let i = 0; i < items.length; i += INFO_CHUNK) {
    const chunk = items.slice(i, i + INFO_CHUNK);
    const res = await helper.request('info', { paths: chunk.map((it) => it.path) });
    chunk.forEach((it, j) => {
      const info = res && res.items && res.items[j];
      if (info) {
        it.display = info.name || it.name;
        if (info.alias) {
          it.alias = info.alias;
          it.aliasDir = info.aliasDir;
        }
        it.hidden = it.hidden || info.hidden;
        it.package = it.dir && info.package;
        if (it.package && !it.ext) it.ext = path.extname(it.name).slice(1).toLowerCase();
        it.kind = info.kind || fallbackKind(it);
      } else {
        it.kind = fallbackKind(it);
      }
    });
  }
}

// The volumes, for Computer: the startup disk and whatever is in /Volumes
// (where the startup disk also has a link to itself, which is skipped).
async function volumes() {
  const names = await fs.promises.readdir('/Volumes').catch(() => []);
  const mounts = ['/'];
  for (const n of names) {
    const m = path.join('/Volumes', n);
    const st = await fs.promises.lstat(m).catch(() => null);
    if (st && st.isDirectory() && !st.isSymbolicLink()) mounts.push(m);
  }
  return Promise.all(mounts.map(async (m) => {
    const res = await helper.request('volume', { path: m });
    const st = await fs.promises.stat(m).catch(() => null);
    const name = (res && res.name) || (m === '/' ? 'Macintosh HD' : path.basename(m));
    return {
      name, display: name, path: m, dir: true, package: false, volume: true, link: false, ext: '',
      size: null, modified: st ? st.mtimeMs : 0, created: st ? st.birthtimeMs : 0, hidden: false,
      kind: 'Volume', free: res ? res.free : null, total: res ? res.total : null
    };
  }));
}

// { path, items, modified } or { path, error } where error is missing, denied or other.
// hidden keeps hidden items in, extensions shows every name whole.
async function list(dir, { hidden = false, extensions = false } = {}) {
  if (dir === COMPUTER) return { path: dir, items: await volumes() };
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    const error = err.code === 'ENOENT' ? 'missing' : err.code === 'EPERM' || err.code === 'EACCES' ? 'denied' : 'other';
    return { path: dir, error };
  }
  let items = (await Promise.all(names.map((n) => readItem(dir, n)))).filter(Boolean);
  for (const extra of MERGED[dir] || []) {
    const have = new Set(items.map((it) => it.name));
    const more = await fs.promises.readdir(extra).catch(() => []);
    const merged = await Promise.all(more.filter((n) => !have.has(n)).map((n) => readItem(extra, n)));
    items = items.concat(merged.filter(Boolean));
  }
  await addInfo(items);
  if (MERGED[dir]) {
    // Safari is a hidden link in /Applications on recent macOS, and Finder shows it.
    items.forEach((it) => {
      if (it.link && it.package && it.ext === 'app') it.hidden = it.name.startsWith('.');
    });
  }
  if (!hidden) items = items.filter((it) => !it.hidden);
  if (extensions) items.forEach((it) => { it.display = it.name; });
  const self = await fs.promises.stat(dir).catch(() => null);
  return { path: dir, items, modified: self ? self.mtimeMs : null };
}

// The number of items in a folder, for the Details box, or null when
// counting would mean looking inside a folder macOS guards (see PROTECTED)
// or a volume other than the one being looked at.
async function count(dir, cwd) {
  const inside = (root) => cwd === root || (cwd || '').startsWith(root + '/');
  if (PROTECTED.includes(dir) && !inside(dir)) return null;
  const vol = dir.match(/^\/Volumes\/[^/]+/);
  if (vol && !inside(vol[0])) return null;
  const names = await fs.promises.readdir(dir).catch(() => null);
  return names ? names.filter((n) => !n.startsWith('.')).length : null;
}

function expand(text, cwd) {
  let t = text.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (t.startsWith('file://')) {
    try {
      t = decodeURIComponent(new URL(t).pathname);
    } catch {
      // not a file address after all
    }
  }
  if (t === '~' || t.startsWith('~/')) t = HOME + t.slice(1);
  return path.resolve(cwd && cwd !== COMPUTER ? cwd : HOME, t);
}

// What an address typed into the address bar points at.
// { type: 'dir' | 'file' | 'missing', path }
async function resolve(text, cwd) {
  if (text.trim().toLowerCase() === 'computer') return { type: 'dir', path: COMPUTER };
  const full = expand(text, cwd);
  try {
    const st = await fs.promises.stat(full);
    return { type: st.isDirectory() ? 'dir' : 'file', path: full };
  } catch {
    return { type: 'missing', path: full };
  }
}

// Folders that start with what's been typed, for the list under the
// address bar. Each one comes back the way it was typed (with ~ if the
// text had it) and as a full path.
async function complete(text, cwd) {
  if (!text.trim()) return [];
  const tilde = text.trim().startsWith('~');
  const full = expand(text, cwd);
  const parent = text.endsWith('/') ? full : path.dirname(full);
  const prefix = text.endsWith('/') ? '' : path.basename(full).toLowerCase();
  let entries;
  try {
    entries = await fs.promises.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().startsWith(prefix)) continue;
    if (e.name.startsWith('.') && !prefix.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = await fs.promises.stat(path.join(parent, e.name)).then((s) => s.isDirectory(), () => false);
    if (!isDir || PACKAGE_EXTS.has(path.extname(e.name).slice(1).toLowerCase())) continue;
    const p = path.join(parent, e.name);
    if (p === full) continue;
    out.push({ path: p, value: tilde && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p });
  }
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  return out.slice(0, 12);
}

// { name, free } for the volume a folder is on.
async function volume(dir) {
  const res = await helper.request('volume', { path: dir });
  if (res && res.name) return { name: res.name, free: res.free };
  try {
    const s = fs.statfsSync(dir);
    return { name: '', free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

// Icons as data URLs, by key. A file's icon is its type's, worked out once
// per extension; apps, other packages and files with no extension get their
// own. Plain folders are drawn by the window and never asked for.
const iconCache = new Map();

async function icon(req, px) {
  const own = req.package || !req.ext;
  const key = `${own ? req.path : '.' + req.ext}@${px}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let url = null;
  const res = own ? await helper.request('icon', { path: req.path, size: px }) : await helper.request('typeIcon', { ext: req.ext, size: px });
  if (res && res.png) {
    url = 'data:image/png;base64,' + res.png;
  } else {
    try {
      const img = await app.getFileIcon(req.path, { size: px <= 16 ? 'small' : 'normal' });
      url = img.toDataURL();
    } catch {
      url = null;
    }
  }
  if (url) iconCache.set(key, url);
  return url;
}

async function icons(reqs, px) {
  const out = {};
  await Promise.all(reqs.map(async (r) => {
    out[r.key] = await icon(r, px);
  }));
  return out;
}

// Pictures of files for the Thumbnails view, from Quick Look, as data URLs
// by path. A file Quick Look can't draw gets null and keeps its icon. Kept
// for the last few hundred files, by path, size and date.
const thumbCache = new Map();
const THUMB_KEEP = 400;

async function thumb(p, px) {
  let st;
  try {
    st = await fs.promises.stat(p);
  } catch {
    return null;
  }
  const key = `${p}@${px}:${st.size}:${st.mtimeMs}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = null;
  try {
    const img = await nativeImage.createThumbnailFromPath(p, { width: px, height: px });
    if (!img.isEmpty()) url = img.toDataURL();
  } catch {
    url = null;
  }
  thumbCache.set(key, url);
  if (thumbCache.size > THUMB_KEEP) thumbCache.delete(thumbCache.keys().next().value);
  return url;
}

async function thumbs(paths, px) {
  const out = {};
  // A few at a time, so a folder of photos doesn't hold up everything else.
  for (let i = 0; i < paths.length; i += 4) {
    await Promise.all(paths.slice(i, i + 4).map(async (p) => {
      out[p] = await thumb(p, px);
    }));
  }
  return out;
}

module.exports = { HOME, COMPUTER, list, count, resolve, complete, volume, icons, thumbs, readItem, addInfo };
