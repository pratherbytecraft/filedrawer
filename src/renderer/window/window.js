// One Filedrawer window: a folder's items, the toolbar, the address bar and
// the status bar. Each window keeps its own back and forward history.
const api = window.filedrawer;
const $ = (id) => document.getElementById(id);

let app = null; // state from the main process
let cwd = new URLSearchParams(location.search).get('path') || '/';
let history = [cwd];
let hIndex = 0;
let items = []; // the folder's items, sorted
let listError = null;
let sel = new Set(); // selected paths
let anchor = null; // where a Shift click or Shift arrow starts from
let cursor = null; // the item the arrow keys move from
let listToken = 0;
let volumeName = '';
let view = 'details'; // thumbs | tiles | icons | list | details, this window's own
let pane = 'tasks'; // tasks | folders, this window's own
let COMPUTER = '::computer'; // the place listing the volumes, from the main process
// The places that aren't one folder, from the main process too.
let TRASH = '::trash';
let RECENTS = '::recents';
let ICLOUD = '::icloud';
const isPlace = (p) => p === COMPUTER || p === TRASH || p === RECENTS || p === ICLOUD;
let folderModified = null; // the open folder's own date, for the Details box
let cwdWritable = true; // new items and pastes can go in the open folder
const iconUrls = new Map(); // by icon key and pixel size

const isFolder = (it) => it.dir && !it.package;
const isVolumeRoot = (p) => p === '/' || /^\/Volumes\/[^/]+$/.test(p);

// The folder above p: a volume's top goes up to Computer, and Computer is the top.
function parentOf(p) {
  if (isPlace(p)) return null;
  if (isVolumeRoot(p)) return COMPUTER;
  if (app && p.startsWith(app.home + '/.Trash/') && dirname(p) === app.home + '/.Trash') return TRASH;
  return dirname(p);
}

function placeLabel(p) {
  if (p === COMPUTER) return 'Computer';
  if (p === TRASH) return 'Trash';
  if (p === RECENTS) return 'Recents';
  if (p === ICLOUD) return 'iCloud Drive';
  if (p === '/') return volumeName || 'Macintosh HD';
  if (app && p === app.home) return app.user;
  return basename(p);
}

// Folders with an icon of their own, by path.
function specialIcon(p) {
  if (!app) return null;
  const h = app.home;
  return { [h]: 'p-home', [h + '/Desktop']: 'p-desktop', [h + '/Documents']: 'p-docs', [h + '/Downloads']: 'p-down',
    '/Applications': 'p-apps', [COMPUTER]: 'p-computer', [TRASH]: 'p-trash', [RECENTS]: 'p-recents', [ICLOUD]: 'p-icloud' }[p] || (isVolumeRoot(p) ? 'p-drive' : null);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const basename = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop());
const dirname = (p) => (p === '/' ? '/' : p.replace(/\/[^/]*\/?$/, '') || '/');

// ---------- formatting ----------

function fmtKB(bytes) {
  if (bytes == null) return '';
  return Math.max(bytes ? 1 : 0, Math.ceil(bytes / 1000)).toLocaleString('en-US') + ' KB';
}

function fmtBytes(bytes) {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = -1;
  do {
    n /= 1000;
    i++;
  } while (n >= 1000 && i < units.length - 1);
  return `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Yesterday at ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + time;
}

// ---------- icons ----------

// Each view's icon size in points comes from the theme (--icon-<view>).
// Icons are drawn at twice that for Retina screens.
function iconPx() {
  const pt = parseInt(getComputedStyle(document.documentElement).getPropertyValue(`--icon-${view}`), 10) || 18;
  return pt * 2;
}

function iconKey(it) {
  return it.package || it.volume || !it.ext ? it.path : '.' + it.ext;
}

const drawn = (it) => isFolder(it) && !it.volume;

function iconHtml(it, cls = 'ic') {
  if (drawn(it)) return `<svg class="${cls}"><use href="#${specialIcon(it.path) || 'i-folder'}"/></svg>`;
  const url = iconUrls.get(`${iconKey(it)}@${iconPx()}`);
  return `<img class="${cls}" alt="" data-key="${esc(iconKey(it))}"${url ? ` src="${url}"` : ''}>`;
}

// Asks for the icons the list is missing, then fills them in.
async function loadIcons() {
  const px = iconPx();
  const want = new Map();
  for (const it of items) {
    if (drawn(it)) continue;
    const key = iconKey(it);
    if (!iconUrls.has(`${key}@${px}`) && !want.has(key)) want.set(key, { key, path: it.path, ext: it.ext, package: it.package });
  }
  if (!want.size) return;
  const token = listToken;
  const got = await api.icons([...want.values()], px);
  for (const [key, url] of Object.entries(got)) if (url) iconUrls.set(`${key}@${px}`, url);
  if (token !== listToken || px !== iconPx()) return;
  for (const img of document.querySelectorAll('img[data-key]')) {
    const url = iconUrls.get(`${img.dataset.key}@${px}`);
    if (url && !img.src) img.src = url;
  }
}

// Thumbnails: Quick Look pictures of the files in sight, asked for as they
// scroll into view. A file Quick Look can't draw keeps its icon.
const THUMB_PX = 192;
const thumbUrls = new Map(); // by path and date, null when there's no picture
const thumbKey = (it) => `${it.path}:${it.modified}`;
let thumbWant = new Set();
let thumbTimer = null;
const thumbSeen = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbSeen.unobserve(en.target);
    const it = items[en.target.closest('.item').dataset.i];
    if (it && !thumbUrls.has(thumbKey(it))) thumbWant.add(it);
  }
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(loadThumbs, 40);
}, { root: document.getElementById('files'), rootMargin: '200px' });

async function loadThumbs() {
  const want = [...thumbWant];
  thumbWant = new Set();
  if (!want.length) return;
  const got = await api.thumbs(want.map((it) => it.path), THUMB_PX);
  for (const it of want) thumbUrls.set(thumbKey(it), got[it.path] || null);
  if (view !== 'thumbs') return;
  for (const el of rows()) {
    const it = items[el.dataset.i];
    const url = it && thumbUrls.get(thumbKey(it));
    if (url) showThumb(el, url);
  }
}

function showThumb(el, url) {
  const frame = el.querySelector('.frame');
  if (frame && !frame.querySelector('.pic')) frame.innerHTML = `<img class="pic" alt="" src="${url}">`;
}

function watchThumbs() {
  thumbSeen.disconnect();
  if (view !== 'thumbs') return;
  for (const el of rows()) {
    const it = items[el.dataset.i];
    if (isFolder(it)) continue;
    const url = thumbUrls.get(thumbKey(it));
    if (url) showThumb(el, url);
    else if (url === undefined) thumbSeen.observe(el.querySelector('.frame'));
  }
}

// ---------- the list ----------

function sortItems(list) {
  // Computer is always by name and Recents newest first, whatever the folders' sort.
  const fixedSort = searchOn() ? null : cwd === COMPUTER ? { key: 'name', dir: 'asc' } : cwd === RECENTS ? { key: 'used', dir: 'desc' } : null;
  const { key, dir } = fixedSort || app.settings.sort;
  const m = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' });
  return list.slice().sort((a, b) => {
    const fa = isFolder(a);
    const fb = isFolder(b);
    if (fa !== fb && app.settings.foldersFirst && cwd !== RECENTS) return fa ? -1 : 1; // folders first, like the old windows
    let c = 0;
    if (key === 'size') c = (a.size ?? -1) - (b.size ?? -1);
    else if (key === 'kind') c = a.kind.localeCompare(b.kind);
    else if (key === 'modified') c = a.modified - b.modified;
    else if (key === 'deleted') c = (a.deleted || 0) - (b.deleted || 0);
    else if (key === 'used') c = (a.used || 0) - (b.used || 0);
    else if (key === 'from') c = (a.from || '').localeCompare(b.from || '');
    return (c || byName(a, b)) * m;
  });
}

const COLUMNS = [
  { key: 'name', label: 'Name', width: '40%' },
  { key: 'size', label: 'Size', width: '15%', cls: 'r' },
  { key: 'kind', label: 'Kind', width: '21%' },
  { key: 'modified', label: 'Date Modified', width: '24%' }
];

// Computer lists volumes, with their sizes instead of dates.
const COMPUTER_COLUMNS = [
  { key: 'name', label: 'Name', width: '40%' },
  { key: 'kind', label: 'Kind', width: '20%' },
  { key: 'total', label: 'Total Size', width: '20%', cls: 'r' },
  { key: 'free', label: 'Free Space', width: '20%', cls: 'r' }
];

// The Trash says where each item came from and when it was deleted, like
// the old Recycle Bin. Recents says where each file is and when it was opened.
const TRASH_COLUMNS = [
  { key: 'name', label: 'Name', width: '30%' },
  { key: 'from', label: 'Original Location', width: '26%' },
  { key: 'deleted', label: 'Date Deleted', width: '20%' },
  { key: 'size', label: 'Size', width: '10%', cls: 'r' },
  { key: 'kind', label: 'Kind', width: '14%' }
];
const RECENTS_COLUMNS = [
  { key: 'name', label: 'Name', width: '30%' },
  { key: 'folder', label: 'Where', width: '26%' },
  { key: 'used', label: 'Date Last Opened', width: '20%' },
  { key: 'size', label: 'Size', width: '10%', cls: 'r' },
  { key: 'kind', label: 'Kind', width: '14%' }
];

function cellFor(col, it) {
  if (col.key === 'name') return `<div class="cell">${iconHtml(it)}<span class="nm">${esc(it.display)}</span></div>`;
  if (col.key === 'size') return fmtKB(it.size);
  if (col.key === 'kind') return esc(it.kind);
  if (col.key === 'folder') return `<span title="${esc(dirname(it.path))}">${esc(shortFolder(it.path))}</span>`;
  if (col.key === 'total' || col.key === 'free') return it[col.key] != null ? fmtBytes(it[col.key]) : '';
  if (col.key === 'from') return it.from ? `<span title="${esc(dirname(it.from))}">${esc(shortFolder(it.from))}</span>` : '';
  if (col.key === 'deleted') return it.deleted ? fmtDate(it.deleted) : '';
  if (col.key === 'used') return it.used ? fmtDate(it.used) : '';
  return fmtDate(it.modified);
}

// Search results add the folder each item is in.
const SEARCH_COLUMNS = [
  { key: 'name', label: 'Name', width: '30%' },
  { key: 'folder', label: 'In Folder', width: '26%' },
  { key: 'size', label: 'Size', width: '12%', cls: 'r' },
  { key: 'kind', label: 'Kind', width: '14%' },
  { key: 'modified', label: 'Date Modified', width: '18%' }
];

function renderDetails() {
  const fixedHead = (cwd === COMPUTER || cwd === RECENTS) && !searchOn(); // headers that don't sort
  const cols = searchOn() ? SEARCH_COLUMNS : cwd === COMPUTER ? COMPUTER_COLUMNS : cwd === TRASH ? TRASH_COLUMNS : cwd === RECENTS ? RECENTS_COLUMNS : COLUMNS;
  const { key, dir } = app.settings.sort;
  const head = cols.map((c) => fixedHead || c.key === 'folder' ? `<th class="${c.cls || ''}">${c.label}</th>` :
    `<th data-sort="${c.key}" class="${c.cls || ''}${c.key === key ? ` sorted ${dir}` : ''}">${c.label}</th>`).join('');
  const rows = items.map((it, i) =>
    `<tr ${itemAttrs(it, i)}>` +
    cols.map((c) => `<td class="${c.cls || ''}">${cellFor(c, it)}</td>`).join('') + '</tr>').join('');
  return `<table class="det"><colgroup>${cols.map((c) => `<col style="width:${c.width}">`).join('')}</colgroup>` +
    `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

const NOTES = {
  denied: 'Filedrawer can\'t open this folder because macOS hasn\'t given it access.',
  missing: 'This folder isn\'t there anymore.',
  fda: '<b>Filedrawer needs Full Disk Access to show the Trash</b><br>macOS keeps the Trash private from other apps. Turn on Filedrawer under Full Disk Access in Privacy and Security, then pick Quit &amp; Reopen when macOS asks.',
  icloud: 'iCloud Drive isn\'t turned on for this Mac.',
  other: 'This folder couldn\'t be opened.'
};

const itemAttrs = (it, i) => `class="item${sel.has(it.path) ? ' sel' : ''}${it.hidden ? ' hid' : ''}${(app.cut || []).includes(it.path) ? ' cut' : ''}" data-i="${i}"${it.volume ? '' : ' draggable="true"'}`;
const nameHtml = (it) => `<span class="nm">${esc(it.display)}</span>`;

function renderIcons() {
  return '<div class="g-icons">' + items.map((it, i) => `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}${nameHtml(it)}</div>`).join('') + '</div>';
}

function tileLine(it) {
  if (it.volume && it.free != null) return `<div class="sub">${fmtBytes(it.free)} free of ${fmtBytes(it.total)}</div>`;
  return it.size != null ? `<div class="sub">${fmtKB(it.size)}</div>` : '';
}

function renderTiles() {
  return '<div class="g-tiles">' + items.map((it, i) =>
    `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}<div class="meta">${nameHtml(it)}` +
    `<div class="sub">${esc(it.kind)}</div>${tileLine(it)}</div></div>`).join('') + '</div>';
}

function renderList() {
  return '<div class="g-list">' + items.map((it, i) => `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}${nameHtml(it)}</div>`).join('') + '</div>';
}

function renderThumbs() {
  return '<div class="g-thumbs">' + items.map((it, i) => {
    const url = thumbUrls.get(thumbKey(it));
    const inside = url ? `<img class="pic" alt="" src="${url}">` : iconHtml(it, 'big');
    return `<div ${itemAttrs(it, i)}><div class="frame">${inside}</div>${nameHtml(it)}</div>`;
  }).join('') + '</div>';
}

const RENDER = { details: renderDetails, icons: renderIcons, tiles: renderTiles, list: renderList, thumbs: renderThumbs };

// List fills columns top to bottom, as many rows as fit the window.
function fitList() {
  const grid = $('files').querySelector('.g-list');
  if (!grid) return;
  const row = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--list-row'), 10) || 20;
  grid.style.setProperty('--rows', Math.max(1, Math.floor(($('files').clientHeight - 8) / row)));
}

function render() {
  if (renaming) endRename(true);
  const f = $('files');
  f.dataset.view = view;
  if (listError) {
    f.innerHTML = `<div class="note">${NOTES[listError]}` +
      (listError === 'denied' ? '<br><button id="b-privacy">Open Privacy Settings</button>' : '') +
      (listError === 'fda' ? '<br><button id="b-fda">Open Privacy Settings</button> <button id="b-finder-trash">Open in Finder</button>' : '') + '</div>';
    const b = $('b-privacy');
    if (b) b.addEventListener('click', () => api.openPrivacy());
    if ($('b-fda')) {
      $('b-fda').addEventListener('click', () => api.openFullDiskAccess());
      $('b-finder-trash').addEventListener('click', () => api.openTrash());
    }
  } else {
    f.innerHTML = RENDER[view]();
    fitList();
  }
  renderStatus();
  renderPane();
  loadIcons();
  watchThumbs();
}

function setView(v) {
  if (!RENDER[v] || v === view) return;
  view = v;
  api.setView({ view, pane, cwd });
  const patch = { view: v };
  if (app.settings.perFolderView && cwd !== COMPUTER) patch.folderViews = { ...app.settings.folderViews, [cwd]: v };
  api.updateSettings(patch);
  const keep = $('files').scrollTop;
  render();
  if (cursor) scrollToItem(cursor);
  else $('files').scrollTop = keep;
}

let fitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitList, 50);
});

function rows() {
  return [...$('files').querySelectorAll('.item')];
}

function showSelection() {
  for (const el of rows()) el.classList.toggle('sel', sel.has(items[el.dataset.i].path));
  $('b-term').classList.toggle('off', !targetFolder());
  renderStatus();
  renderPane();
}

function renderStatus() {
  const picked = items.filter((it) => sel.has(it.path));
  const n = picked.length;
  $('st1').textContent = listError ? '' : n ? `${n} item${n === 1 ? '' : 's'} selected` : `${items.length} item${items.length === 1 ? '' : 's'}`;
  const files = (n ? picked : items).filter((it) => it.size != null);
  const total = files.reduce((sum, it) => sum + it.size, 0);
  $('st2').textContent = files.length ? fmtBytes(total) : '';
  if (searchOn() && !n) drawSearchState();
}

async function loadVolume() {
  const dir = cwd;
  if (isPlace(dir) && dir !== TRASH) {
    $('st3').textContent = '';
    updateTitle();
    return;
  }
  const v = await api.volume(dir);
  if (dir !== cwd) return;
  volumeName = v && v.name ? v.name : '';
  $('st3').textContent = v ? `${fmtBytes(v.free)} free${volumeName ? ' on ' + volumeName : ''}` : '';
  updateTitle();
}

// ---------- going places ----------

function updateTitle() {
  const short = isPlace(cwd) || cwd === '/' ? placeLabel(cwd) : basename(cwd);
  const name = searchOn() ? 'Search Results' : app.settings.fullPathTitle && !isPlace(cwd) ? cwd : short;
  $('title').textContent = name;
  document.title = name;
  api.setTitle(name, cwd);
}

const shownPath = (p) => (isPlace(p) ? placeLabel(p) : p);

function updateChrome() {
  if (document.activeElement !== $('path')) $('path').value = shownPath(cwd);
  $('b-back').classList.toggle('off', hIndex === 0);
  $('b-forward').classList.toggle('off', hIndex >= history.length - 1);
  $('b-up').classList.toggle('off', !parentOf(cwd));
  $('b-term').classList.toggle('off', !targetFolder());
  const icon = `<use href="#${specialIcon(cwd) || 'i-folder'}"/>`;
  $('addr-icon').innerHTML = icon;
  $('title-icon').innerHTML = icon;
  api.setView({ view, pane, cwd });
  updateTitle();
  renderTree();
}

// Opens dir in this window. select picks an item once it's listed, keep
// holds on to the selection (a refresh).
async function navigate(dir, { push = true, select = null, selectMany = null, keep = false, changed = false } = {}) {
  if (searchOn()) {
    leaveSearch();
    $('b-search').classList.remove('down');
    if (document.body.dataset.pane === 'search') setPane(paneBefore, { save: false, quiet: true });
  }
  const token = ++listToken;
  const res = await api.list(dir, { hidden: app.settings.showHidden, extensions: app.settings.showExtensions });
  if (token !== listToken) return;
  // The open folder was deleted or moved away: go to the nearest folder above it that's still there.
  if (changed && res.error === 'missing') {
    for (let p = parentOf(dir); p; p = parentOf(p)) {
      if (p === COMPUTER || (await api.resolve(p, '/')).type === 'dir') {
        treeKids.delete(p);
        treeShownFor = null;
        navigate(p, { push: false });
        return;
      }
    }
    return;
  }
  if (!res.error) api.watch(dir);
  if (push && dir !== cwd) {
    history = history.slice(0, hIndex + 1);
    history.push(dir);
    hIndex = history.length - 1;
  }
  const same = dir === cwd;
  cwd = dir;
  // A folder with a view of its own opens in it, the rest in the view picked last.
  if (!same && app.settings.perFolderView) {
    const own = app.settings.folderViews[dir];
    const want = RENDER[own] ? own : app.settings.view;
    if (want !== view) {
      view = want;
      api.setView({ view, pane, cwd });
    }
  }
  listError = res.error || null;
  folderModified = res.modified || null;
  cwdWritable = res.writable !== false;
  items = res.error ? [] : sortItems(res.items);
  const paths = new Set(items.map((it) => it.path));
  if (selectMany) {
    sel = new Set(selectMany.filter((p) => paths.has(p)));
    anchor = cursor = [...sel].pop() || null;
  } else if (keep && same) {
    sel = new Set([...sel].filter((p) => paths.has(p)));
  } else {
    sel = new Set(select && paths.has(select) ? [select] : []);
    anchor = cursor = select && paths.has(select) ? select : null;
  }
  render();
  updateChrome();
  if (!same || !volumeName) loadVolume();
  if ((!keep || selectMany) && cursor) scrollToItem(cursor);
  else if (!keep) $('files').scrollTop = 0;
}

function goHistory(i) {
  if (i < 0 || i >= history.length) return;
  const from = cwd;
  hIndex = i;
  navigate(history[i], { push: false, select: from });
}

const back = () => goHistory(hIndex - 1);
const forward = () => goHistory(hIndex + 1);

function up() {
  const parent = parentOf(cwd);
  if (parent) navigate(parent, { select: cwd });
}

// Folders open here or in a new window, per Folder Options.
function openItem(it, { newWindow = app.settings.openFolders === 'new' } = {}) {
  if (it.alias && it.aliasDir) {
    if (newWindow) api.openWindow(it.alias);
    else navigate(it.alias);
  } else if (isFolder(it)) {
    if (newWindow) api.openWindow(it.path);
    else navigate(it.path);
  } else {
    api.open(it.path);
  }
}

// Return opens the selection. One folder opens here, more than one each
// open in their own window.
function openSelected({ newWindow = app.settings.openFolders === 'new' } = {}) {
  const picked = items.filter((it) => sel.has(it.path));
  if (!picked.length) return;
  const many = picked.filter(isFolder).length > 1;
  for (const it of picked) openItem(it, { newWindow: newWindow || many });
}

// ---------- selection with the mouse and keys ----------

function scrollToItem(p) {
  const i = items.findIndex((it) => it.path === p);
  const el = i >= 0 && $('files').querySelector(`.item[data-i="${i}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  // The sticky header covers the top row.
  const head = $('files').querySelector('thead');
  if (head) {
    const top = el.offsetTop - head.offsetHeight;
    if (top < $('files').scrollTop) $('files').scrollTop = top;
  }
}

function selectRange(from, to) {
  const a = items.findIndex((it) => it.path === from);
  const b = items.findIndex((it) => it.path === to);
  if (a < 0 || b < 0) return new Set([to]);
  return new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((it) => it.path));
}

$('files').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const th = e.target.closest('th[data-sort]');
  if (th) {
    sortBy(th.dataset.sort);
    return;
  }
  const el = e.target.closest('.item');
  if (!el) {
    if (!e.metaKey && !e.shiftKey) sel.clear();
    anchor = cursor = null;
    showSelection();
    return;
  }
  const p = items[el.dataset.i].path;
  if (e.metaKey) {
    if (sel.has(p)) sel.delete(p);
    else sel.add(p);
    anchor = p;
  } else if (e.shiftKey && anchor) {
    sel = selectRange(anchor, p);
  } else {
    sel = new Set([p]);
    anchor = p;
  }
  cursor = p;
  showSelection();
});

// Command double click always opens a folder in a new window.
$('files').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.item');
  if (!el || app.settings.clickToOpen === 'single') return;
  openItem(items[el.dataset.i], e.metaKey ? { newWindow: true } : undefined);
});

// With single click, a plain click on an item opens it once the button comes
// up where it went down, so a drag still moves it.
$('files').addEventListener('click', (e) => {
  if (app.settings.clickToOpen !== 'single' || e.shiftKey || e.altKey || e.button !== 0) return;
  if (e.metaKey && !e.target.closest('.item')) return;
  const el = e.target.closest('.item');
  if (!el || e.target.closest('input')) return;
  if (e.metaKey) return; // Command click adds to the selection
  openItem(items[el.dataset.i]);
});

// How far the arrow keys move in the current view: Up and Down go a whole
// row in the grids, Left and Right a whole column in List.
function stepFor(key) {
  const els = rows();
  if (view === 'details') return { ArrowDown: 1, ArrowUp: -1 }[key] || 0;
  if (view === 'list') {
    const perCol = els.filter((el) => el.offsetLeft === (els[0] && els[0].offsetLeft)).length || 1;
    return { ArrowDown: 1, ArrowUp: -1, ArrowRight: perCol, ArrowLeft: -perCol }[key] || 0;
  }
  const perRow = els.filter((el) => el.offsetTop === (els[0] && els[0].offsetTop)).length || 1;
  return { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[key] || 0;
}

function moveCursor(delta, extend) {
  if (!items.length) return;
  let i = items.findIndex((it) => it.path === cursor);
  if (i < 0) i = delta > 0 ? -1 : items.length;
  i = Math.max(0, Math.min(items.length - 1, i + delta));
  cursor = items[i].path;
  if (extend && anchor) {
    sel = selectRange(anchor, cursor);
  } else {
    sel = new Set([cursor]);
    anchor = cursor;
  }
  showSelection();
  scrollToItem(cursor);
}

function pageRows() {
  const row = $('files').querySelector('.item');
  if (!row) return 10;
  const down = Math.max(1, stepFor('ArrowDown'));
  return Math.max(1, Math.floor($('files').clientHeight / row.offsetHeight) - 1) * (view === 'list' ? 1 : down);
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if ($('menu').classList.contains('open')) {
    if (e.key === 'Escape') closeMenu();
    return;
  }
  const extend = e.shiftKey;
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (e.metaKey) return; // Open and Up One Folder, from the menu
      const step = stepFor(e.key);
      if (!step) return;
      e.preventDefault();
      moveCursor(step, extend);
      break;
    }
    case 'PageDown':
      e.preventDefault();
      moveCursor(pageRows(), extend);
      break;
    case 'PageUp':
      e.preventDefault();
      moveCursor(-pageRows(), extend);
      break;
    case 'Home':
      e.preventDefault();
      moveCursor(-items.length, extend);
      break;
    case 'End':
      e.preventDefault();
      moveCursor(items.length, extend);
      break;
    case 'Enter':
      e.preventDefault();
      openSelected();
      break;
    case 'Backspace':
      if (e.metaKey) return; // Move to Trash, from the menu
      e.preventDefault();
      back();
      break;
    default:
  }
});

// The selection turns grey while the window isn't the one in front, like the Mac's lists.
window.addEventListener('blur', () => document.body.classList.add('idle'));
window.addEventListener('focus', () => document.body.classList.remove('idle'));

// ---------- menus drawn in the window ----------

// entries: { label, bold, icon (a symbol id), click, disabled, checked, sub } or 'sep'.
// sub is a list of entries opened beside the row on hover.
function fillMenu(m, entries) {
  m.innerHTML = entries.map((en, i) => en === 'sep' ? '<div class="sep"></div>' :
    `<div class="mi${en.disabled ? ' disabled' : ''}${en.checked ? ' chk' : ''}${en.sub ? ' sub' : ''}" data-i="${i}">` +
    `<svg class="mic">${en.icon ? `<use href="#${en.icon}"/>` : ''}</svg>` +
    (en.bold ? `<b>${esc(en.label)}</b>` : esc(en.label)) + '</div>').join('');
  m.onclick = (e) => {
    const el = e.target.closest('.mi');
    if (!el || entries[el.dataset.i].sub) return;
    closeMenu();
    entries[el.dataset.i].click();
  };
  m.onmouseover = (e) => {
    const el = e.target.closest('.mi');
    if (!el || m.id !== 'menu') return;
    const en = entries[el.dataset.i];
    m.querySelectorAll('.mi.on').forEach((x) => x !== el && x.classList.remove('on'));
    if (!en.sub) {
      $('submenu').classList.remove('open');
      return;
    }
    el.classList.add('on');
    const r = el.getBoundingClientRect();
    placeMenu($('submenu'), en.sub, r.right - 2, r.top - 5, r.left + 2);
  };
}

// Opens m at x, y, kept inside the window. A submenu that doesn't fit on
// the right opens to the left of its row, which ends at flipX.
function placeMenu(m, entries, x, y, flipX) {
  fillMenu(m, entries);
  m.classList.add('open');
  const r = m.getBoundingClientRect();
  const left = x + r.width > innerWidth - 4 && flipX !== undefined ? flipX - r.width : Math.min(x, innerWidth - r.width - 4);
  m.style.left = Math.max(4, left) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

function openMenu(entries, x, y) {
  $('submenu').classList.remove('open');
  placeMenu($('menu'), entries, x, y);
}

function closeMenu() {
  $('menu').classList.remove('open');
  $('submenu').classList.remove('open');
  document.querySelectorAll('.tb.down, .dd.down').forEach((el) => el.classList.remove('down'));
}

const VIEWS = [['thumbs', 'Thumbnails'], ['tiles', 'Tiles'], ['icons', 'Icons'], ['list', 'List'], ['details', 'Details']];
const SORTS = [['name', 'Name'], ['size', 'Size'], ['kind', 'Kind'], ['modified', 'Date Modified']];

const viewEntries = () => VIEWS.map(([v, label]) => ({ label, checked: v === view, click: () => setView(v) }));
const sortEntries = () => SORTS.map(([k, label]) => ({ label, checked: k === app.settings.sort.key, click: () => sortBy(k) }));

// Sorting by the same thing again turns it around.
function sortBy(key) {
  const s = app.settings.sort;
  api.updateSettings({ sort: { key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' } });
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('[data-drop]') && !e.target.closest('#b-places') && !e.target.closest('#b-views')) closeMenu();
  if (!e.target.closest('.addrrow')) hideSuggest();
}, true);
window.addEventListener('blur', closeMenu);

$('files').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const el = e.target.closest('.item');
  if (!el) {
    sel.clear();
    showSelection();
    if (cwd === TRASH) {
      openMenu([
        { label: 'Empty Trash...', icon: 'p-trash', click: () => api.emptyTrash() },
        'sep',
        { label: 'View', sub: viewEntries() },
        { label: 'Arrange Icons By', sub: sortEntries() },
        { label: 'Refresh', click: () => navigate(cwd, { push: false, keep: true }) }
      ], e.clientX, e.clientY);
      return;
    }
    const here = isPlace(cwd) ? [] : ['sep',
      { label: 'Open Terminal Here', icon: 'p-term', click: () => openTerminal(cwd) },
      isPinned(cwd) ? { label: 'Unpin This Folder', icon: 'p-pin', click: () => unpin(cwd) }
        : { label: 'Pin This Folder', icon: 'p-pin', click: () => pin(cwd) }];
    openMenu([
      { label: 'View', sub: viewEntries() },
      { label: 'Arrange Icons By', sub: sortEntries() },
      { label: 'Refresh', click: () => navigate(cwd, { push: false, keep: true }) },
      ...here,
      ...(isPlace(cwd) || listError ? [] : [
        ...(cwdWritable ? ['sep', { label: 'Paste', click: () => pasteInto(cwd) }, 'sep', { label: 'New', sub: [
          { label: 'Folder', icon: 'p-newfolder', click: () => makeNew('folder') },
          { label: 'Text Document', icon: 'p-text', click: () => makeNew('text') }
        ] }] : []),
        'sep', { label: 'Properties', icon: 'p-props', click: () => showProps() }])
    ], e.clientX, e.clientY);
    return;
  }
  const it = items[el.dataset.i];
  if (!sel.has(it.path)) {
    sel = new Set([it.path]);
    anchor = cursor = it.path;
    showSelection();
  }
  const picked = items.filter((x) => sel.has(x.path));
  if (cwd === TRASH) {
    const paths = picked.map((x) => x.path);
    openMenu([
      { label: 'Put Back', bold: true, click: () => putBackSelected() },
      { label: 'Delete Immediately...', click: () => api.deleteNow(paths) },
      'sep',
      { label: 'Open', click: () => openSelected() },
      ...(picked.some(isFolder) ? [] : [{ label: 'Quick Look', click: () => api.quickLook(it.path) }]),
      { label: 'Copy', icon: 'p-copy', click: () => clipCommand('copy') },
      { label: 'Copy Path', click: () => copyPaths() },
      'sep',
      { label: 'Properties', icon: 'p-props', click: () => showProps() }
    ], e.clientX, e.clientY);
    return;
  }
  // In groups like the old windows: opening, pinning, then changing.
  const groups = [[{ label: 'Open', bold: true, click: () => openSelected() }], [], []];
  if (picked.every(isFolder)) groups[0].push({ label: 'Open in New Window', click: () => openSelected({ newWindow: true }) });
  // Apps and other bundles open like files, and can be looked inside too.
  if (picked.length === 1 && it.package && !it.volume) groups[0].push({ label: 'Show Package Contents', click: () => navigate(it.path) });
  if (!picked.some(isFolder)) {
    groups[0].push({ label: 'Open With', sub: await openWithEntries(picked.map((x) => x.path)) });
    groups[0].push({ label: 'Quick Look', click: () => api.quickLook(it.path) });
  }
  if (picked.length === 1 && isFolder(it)) {
    groups[0].push({ label: 'Open Terminal Here', icon: 'p-term', click: () => openTerminal(it.path) });
    if (!it.volume) {
      groups[1].push(isPinned(it.path) ? { label: 'Unpin', icon: 'p-pin', click: () => unpin(it.path) }
        : { label: 'Pin to Pinned', icon: 'p-pin', click: () => pin(it.path) });
    }
  }
  if (picked.length === 1 && it.volume && ejectable(it.path)) groups[1].push({ label: 'Eject', icon: 'p-eject', click: () => eject(it.path) });
  if (cwd !== COMPUTER && !it.volume) {
    // Items in a folder that can't be changed can still be copied, not moved or renamed.
    const fixed = picked.some((x) => x.fixed);
    groups[1].push({ label: 'Send To', sub: sendToEntries(picked.map((x) => x.path)) });
    groups.splice(2, 0, [
      ...(fixed ? [] : [{ label: 'Cut', click: () => clipCommand('cut') }]),
      { label: 'Copy', icon: 'p-copy', click: () => clipCommand('copy') },
      ...(picked.length === 1 && isFolder(it) && it.canAdd !== false ? [{ label: 'Paste', click: () => pasteInto(it.path) }] : []),
      { label: 'Copy Path', click: () => copyPaths() },
      ...(fixed ? [] : [{ label: 'Duplicate', click: () => duplicateSelected() }])
    ]);
    if (!fixed) {
      groups[3].push({ label: 'Make Alias', click: () => aliasSelected() });
      if (picked.length === 1) groups[3].push({ label: 'Rename', icon: 'p-rename', click: () => startRename(it.path) });
      groups[3].push({ label: 'Move to Trash', icon: 'p-trash', click: () => trashSelected() });
    }
  }
  groups.push([{ label: 'Properties', icon: 'p-props', click: () => showProps() }]);
  const entries = groups.filter((g) => g.length).flatMap((g, i) => (i ? ['sep', ...g] : g));
  openMenu(entries, e.clientX, e.clientY);
});

// Back and Forward each have a list of where they go, under their arrow.
function historyMenu(which, anchorEl) {
  const entries = [];
  if (which === 'back') for (let i = hIndex - 1; i >= 0 && entries.length < 12; i--) entries.push(i);
  else for (let i = hIndex + 1; i < history.length && entries.length < 12; i++) entries.push(i);
  const r = anchorEl.getBoundingClientRect();
  anchorEl.closest('.tb').classList.add('down');
  openMenu(entries.map((i) => ({ label: placeLabel(history[i]), icon: specialIcon(history[i]) || 'i-folder', click: () => goHistory(i) })), r.left, r.bottom + 2);
}

$('b-back').addEventListener('click', (e) => {
  const drop = e.target.closest('[data-drop]');
  if (drop) historyMenu('back', drop);
  else back();
});
$('b-forward').addEventListener('click', (e) => {
  const drop = e.target.closest('[data-drop]');
  if (drop) historyMenu('forward', drop);
  else forward();
});
$('b-up').addEventListener('click', up);

$('b-views').addEventListener('mousedown', (e) => {
  e.preventDefault();
  if ($('menu').classList.contains('open') && $('b-views').classList.contains('down')) {
    closeMenu();
    return;
  }
  const r = $('b-views').getBoundingClientRect();
  openMenu(viewEntries(), r.left, r.bottom + 2);
  $('b-views').classList.add('down');
});

// The folders above this one, from the arrow at the end of the address bar.
$('b-places').addEventListener('mousedown', (e) => {
  e.preventDefault();
  if ($('menu').classList.contains('open')) {
    closeMenu();
    return;
  }
  const list = [];
  for (let p = cwd; p; p = parentOf(p)) list.push(p);
  const r = $('b-places').closest('.addr').getBoundingClientRect();
  $('b-places').classList.add('down');
  const entry = (p) => ({ label: placeLabel(p), icon: specialIcon(p) || 'i-folder', checked: p === cwd, click: () => navigate(p) });
  const pinned = pins().filter((p) => !list.includes(p));
  openMenu([...list.map(entry), ...(pinned.length ? ['sep', ...pinned.map(entry)] : [])], r.left, r.bottom + 2);
});

// ---------- address bar ----------

const path = $('path');
let suggestions = [];
let suggestOn = -1; // the row picked with the arrow keys, -1 for none
let completeTimer = null;

function hideSuggest() {
  $('suggest').classList.remove('open');
  suggestions = [];
  suggestOn = -1;
}

function hideAddrError() {
  $('addr-error').classList.remove('open');
}

function drawSuggest() {
  const box = $('suggest');
  if (!suggestions.length) {
    hideSuggest();
    return;
  }
  box.innerHTML = suggestions.map((s, i) =>
    `<div class="row${i === suggestOn ? ' on' : ''}" data-i="${i}"><svg><use href="#i-folder"/></svg>${esc(s.value)}</div>`).join('');
  box.classList.add('open');
}

path.addEventListener('focus', () => setTimeout(() => path.select(), 0));
path.addEventListener('input', () => {
  hideAddrError();
  clearTimeout(completeTimer);
  completeTimer = setTimeout(async () => {
    const text = path.value;
    const got = await api.complete(text, cwd);
    if (path.value !== text || document.activeElement !== path) return;
    suggestions = got;
    suggestOn = -1;
    drawSuggest();
  }, 80);
});

path.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return;
    e.preventDefault();
    const n = suggestions.length;
    suggestOn = e.key === 'ArrowDown' ? (suggestOn + 1) % n : (suggestOn - 1 + n) % n;
    path.value = suggestions[suggestOn].value;
    drawSuggest();
  } else if (e.key === 'Tab') {
    if (!suggestions.length) return;
    e.preventDefault();
    path.value = suggestions[Math.max(0, suggestOn)].value + '/';
    path.dispatchEvent(new Event('input'));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if ($('suggest').classList.contains('open') || $('addr-error').classList.contains('open')) {
      hideSuggest();
      hideAddrError();
    } else {
      path.value = shownPath(cwd);
      $('files').focus();
    }
  }
});

path.addEventListener('blur', () => {
  hideSuggest();
  if (!$('addr-error').classList.contains('open')) path.value = shownPath(cwd);
});

$('suggest').addEventListener('mousedown', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  path.value = suggestions[row.dataset.i].value;
  go();
});

$('b-go').addEventListener('mousedown', (e) => e.preventDefault());
$('b-go').addEventListener('click', go);

// A folder opens here, a file opens in its app, anything else gets a note.
async function go() {
  clearTimeout(completeTimer);
  hideSuggest();
  const text = path.value.trim();
  if (!text) {
    path.value = shownPath(cwd);
    return;
  }
  const res = await api.resolve(text, cwd);
  if (res.type === 'dir') {
    hideAddrError();
    $('files').focus();
    navigate(res.path);
  } else if (res.type === 'file') {
    hideAddrError();
    api.open(res.path);
    path.value = shownPath(cwd);
    $('files').focus();
  } else {
    const box = $('addr-error');
    box.textContent = `Can't find "${text}". Check the spelling and try again.`;
    box.classList.add('open');
  }
}

// ---------- commands from the menu bar ----------

api.onCommand(({ command, arg }) => {
  // Any field being typed in: the address bar, a name, the search boxes.
  const field = document.activeElement && document.activeElement.matches('input, textarea') ? document.activeElement : null;
  const typing = !!field;
  switch (command) {
    case 'newWindow': api.openWindow(cwd); break;
    // The Finder window's name, shown until its folder comes.
    case 'waitTitle': $('title').textContent = arg; break;
    case 'open': if (!typing) openSelected(); break;
    case 'selectAll':
      if (field) field.select();
      else {
        sel = new Set(items.map((it) => it.path));
        showSelection();
      }
      break;
    case 'refresh':
      treeKids.delete(cwd);
      treeShownFor = null;
      navigate(cwd, { push: false, keep: true });
      break;
    case 'view': setView(arg); break;
    case 'sort': sortBy(arg); break;
    case 'back': back(); break;
    case 'forward': forward(); break;
    case 'up': up(); break;
    case 'home': navigate(app.home); break;
    case 'computer': navigate(COMPUTER); break;
    case 'navigate': navigate(arg); break;
    case 'find': openSearch(); break;
    case 'newFolder': makeNew('folder'); break;
    case 'newText': makeNew('text'); break;
    case 'rename': if (!typing) renameSelected(); break;
    case 'duplicate': if (!typing) duplicateSelected(); break;
    case 'alias': if (!typing) aliasSelected(); break;
    case 'copyPath':
      if (field) api.editText('copy');
      else copyPaths();
      break;
    case 'trash': {
      const field = document.activeElement;
      if (field && field.matches('input')) deleteToStart(field);
      else trashSelected();
      break;
    }
    case 'undo':
    case 'redo': undoOrRedo(command); break;
    case 'props': if (!typing) showProps(); break;
    case 'cut':
    case 'copy':
    case 'paste': clipCommand(command); break;
    case 'terminal': openTerminal(); break;
    case 'pinHere': if (!isPlace(cwd)) (isPinned(cwd) ? unpin(cwd) : pin(cwd)); break;
    case 'pane': setPane(pane === 'folders' ? 'tasks' : 'folders'); break;
    case 'address': path.focus(); break;
    default:
  }
});

// ---------- start ----------

// Settings that only change how things are drawn.
const LOOK_KEYS = ['showExtensions', 'foldersFirst', 'fullPathTitle', 'showPane', 'terminalButton'];

function applyChrome() {
  const s = app.settings;
  document.body.classList.toggle('no-pane', !s.showPane);
  $('b-term').hidden = !s.terminalButton;
  $('b-term').previousElementSibling.hidden = !s.terminalButton;
}

function applyState(state) {
  const old = app;
  app = state;
  window.applyTheme(state);
  applyChrome();
  if (old && LOOK_KEYS.some((k) => old.settings[k] !== state.settings[k])) {
    treeKids.clear();
    treeShownFor = null;
    navigate(cwd, { push: false, keep: true });
    updateTitle();
    return;
  }
  if (old && (old.settings.showHidden !== state.settings.showHidden)) {
    treeShownFor = null;
    navigate(cwd, { push: false, keep: true });
  } else if (old && old.settings.theme !== state.settings.theme) {
    // Icon sizes come from the theme, so everything is drawn again once its stylesheet is in.
    $('theme-css').addEventListener('load', () => render(), { once: true });
  } else if (old && JSON.stringify(old.settings.sort) !== JSON.stringify(state.settings.sort)) {
    items = sortItems(items);
    render();
  } else if (old && JSON.stringify(old.cut) !== JSON.stringify(state.cut)) {
    showCut();
  } else if (old && (JSON.stringify(old.settings.pins) !== JSON.stringify(state.settings.pins) ||
    JSON.stringify(old.settings.places) !== JSON.stringify(state.settings.places))) {
    renderPane();
    renderTree();
  }
}

api.onState(applyState);
// Full Disk Access is turned on in System Settings, so the Trash looks
// again when the window comes back to the front.
window.addEventListener('focus', () => {
  if (cwd === TRASH && listError === 'fda') navigate(cwd, { push: false });
});
api.onFolderChanged((dir) => {
  if (dir !== cwd || searchOn()) return;
  if (renaming) {
    changedWhileRenaming = true; // redrawing now would throw away the name being typed
    return;
  }
  treeKids.delete(cwd);
  navigate(cwd, { push: false, keep: true, changed: true });
});
// Starts once every script on the page is in (edit.js and search.js come after this one).
window.addEventListener('DOMContentLoaded', () => {
  api.getState().then((state) => {
    applyState(state);
    const s = state.settings;
    view = s.newWindowView !== 'last' ? s.newWindowView : s.view;
    COMPUTER = state.computer;
    TRASH = state.trash;
    RECENTS = state.recents;
    ICLOUD = state.icloud;
    setPane(state.settings.pane, { save: false });
    const params = new URLSearchParams(location.search);
    if (params.get('wait')) {
      // Two frames after the theme's stylesheet is in, its colors are on screen.
      const drawn = () => requestAnimationFrame(() => requestAnimationFrame(() => api.drawn()));
      if ($('theme-css').sheet) drawn();
      else $('theme-css').addEventListener('load', drawn, { once: true });
      // Opened in the spot of a Finder window, before its folder was known.
      api.waitFolder().then((dir) => {
        if (!dir) return;
        cwd = dir;
        history = [dir];
        navigate(dir, { push: false });
      });
    } else {
      navigate(cwd, { push: false, select: params.get('select') });
    }
    $('files').focus();
  });
});

// ---------- pinned folders and the terminal ----------

const pins = () => (app ? app.settings.pins : []);
const isPinned = (p) => pins().includes(p);

function pin(p) {
  if (!p || isPlace(p) || isPinned(p)) return;
  api.updateSettings({ pins: [...pins(), p] });
}

function unpin(p) {
  api.updateSettings({ pins: pins().filter((x) => x !== p) });
}

// The folder a task works on: the selected folder, or the open one.
function targetFolder() {
  const picked = selectedItems();
  if (picked.length === 1 && isFolder(picked[0]) && !picked[0].volume) return picked[0].path;
  if (picked.length === 1 && picked[0].volume) return picked[0].path;
  return isPlace(cwd) ? null : cwd;
}

function openTerminal(p = targetFolder()) {
  if (p) api.openTerminal(p);
}

// The toolbar button and the File menu open the folder that's open, the
// task and the right click open the folder they're about.
// The selected folder, when one is, or the open one.
$('b-term').addEventListener('click', () => openTerminal());

// ---------- the left pane: Tasks ----------

const collapsed = new Set(); // boxes folded shut in this window

// Other Places, less the ones switched off on the Folder Options page.
const PLACES = () => [
  [RECENTS, 'Recents', 'recents'], [app.home, 'Home', 'home'], [app.home + '/Desktop', 'Desktop', 'desktop'],
  [app.home + '/Documents', 'Documents', 'documents'], [app.home + '/Downloads', 'Downloads', 'downloads'],
  ['/Applications', 'Applications', 'applications'], [ICLOUD, 'iCloud Drive', 'icloud'], [COMPUTER, 'Computer', 'computer'],
  [TRASH, 'Trash', 'trash']
].filter(([p, , key]) => app.settings.places[key] !== false && (p !== ICLOUD || app.icloudOn));

function box(id, title, body, first = false) {
  if (!body) return '';
  return `<div class="box${first ? ' first' : ''}${collapsed.has(id) ? ' shut' : ''}" data-box="${id}">` +
    `<h3><span>${esc(title)}</span><span class="chev"><svg><use href="#t-chev-up"/></svg></span></h3>` +
    `<div class="bd">${body}</div></div>`;
}

const taskRow = (act, icon, label) => `<div class="row" data-act="${act}"><svg><use href="#${icon}"/></svg>${esc(label)}</div>`;

function selectedItems() {
  return items.filter((it) => sel.has(it.path));
}

function tasksBox() {
  const picked = selectedItems();
  const one = picked.length === 1 ? picked[0] : null;
  const pinRow = (p) => isPinned(p) ? taskRow('unpin', 'p-pin', 'Unpin this folder') : taskRow('pin', 'p-pin', 'Pin this folder');
  if (cwd === TRASH) {
    if (listError === 'fda') return box('tasks', 'Trash Tasks', taskRow('fda', 'p-props', 'Open Privacy Settings') + taskRow('finderTrash', 'p-open', 'Open the Trash in Finder'), true);
    if (listError) return '';
    if (!picked.length) return box('tasks', 'Trash Tasks', taskRow('emptyTrash', 'p-trash', 'Empty the Trash') + (items.length ? taskRow('putBackAll', 'p-putback', 'Put back all items') : ''), true);
    return box('tasks', 'Trash Tasks', taskRow('putBack', 'p-putback', one ? 'Put back this item' : 'Put back the selected items') +
      taskRow('deleteNow', 'p-trash', one ? 'Delete this item immediately' : 'Delete the selected items immediately'), true);
  }
  if (!picked.length) {
    if (isPlace(cwd)) return '';
    return box('tasks', 'Folder Tasks', (cwdWritable ? taskRow('newFolder', 'p-newfolder', 'Make a new folder') : '') +
      taskRow('terminal', 'p-term', 'Open Terminal Here') + pinRow(cwd) +
      taskRow('newWindowHere', 'p-open', 'Open this folder in a new window') +
      taskRow('hidden', 'p-hidden', app.settings.showHidden ? 'Hide hidden files' : 'Show hidden files'), true);
  }
  if (one && isFolder(one)) {
    return box('tasks', 'Folder Tasks', taskRow('open', 'p-open', one.volume ? 'Open this volume' : 'Open this folder') +
      (one.volume && ejectable(one.path) ? taskRow('eject', 'p-eject', 'Eject this volume') : '') +
      (one.volume || one.fixed ? '' : taskRow('rename', 'p-rename', 'Rename this folder')) +
      taskRow('openNew', 'p-open', 'Open in a new window') + taskRow('terminal', 'p-term', 'Open Terminal Here') + (one.volume ? '' : pinRow(one.path)) +
      (one.volume || one.fixed ? '' : taskRow('trash', 'p-trash', 'Move this folder to the Trash')), true);
  }
  if (one) {
    return box('tasks', 'File Tasks', taskRow('open', 'p-open', 'Open this file') +
      (one.fixed ? '' : taskRow('rename', 'p-rename', 'Rename this file') + taskRow('trash', 'p-trash', 'Move this file to the Trash')), true);
  }
  return box('tasks', 'File and Folder Tasks', taskRow('open', 'p-open', 'Open the selected items') +
    ((cwd === COMPUTER || cwd === TRASH) || picked.some((it) => it.fixed) ? '' : taskRow('trash', 'p-trash', 'Move the selected items to the Trash')), true);
}

function pinnedBox() {
  const rows = pins().map((p, i) =>
    `<div class="row" draggable="true" data-pin="${i}" data-place="${esc(p)}"><svg><use href="#${specialIcon(p) || 'i-folder'}"/></svg>` +
    `<span class="lb">${esc(placeLabel(p))}</span><span class="x" data-unpin="${i}" title="Unpin">&times;</span></div>`).join('');
  return box('pinned', 'Pinned', rows + '<div class="hint">Drop a folder here to pin it.</div>');
}

// The same places in the same order wherever the window is, with the one
// it's in shown in bold.
function placesBox() {
  return box('places', 'Other Places', PLACES().map(([p, label]) =>
    `<div class="row${p === cwd ? ' here' : ''}" data-place="${esc(p)}"><svg><use href="#${specialIcon(p) || 'i-folder'}"/></svg>${esc(label)}</div>`).join(''));
}

let countFor = null; // the folder whose count the Details box is waiting on

function detailsBox() {
  const picked = selectedItems();
  const one = picked.length === 1 ? picked[0] : null;
  const line = (t) => `<span class="d">${t}</span><br>`;
  let html;
  countFor = null;
  if (!picked.length) {
    html = `<b>${esc(placeLabel(cwd))}</b>` + line(isPlace(cwd) ? `${items.length} item${items.length === 1 ? '' : 's'}` : isVolumeRoot(cwd) ? 'Volume' : 'Folder') +
      (folderModified ? line(`Modified: ${fmtDate(folderModified)}`) : '');
  } else if (one) {
    html = `<b>${esc(one.display)}</b>` + line(esc(one.kind));
    if (one.volume && one.free != null) html += line(`Free space: ${fmtBytes(one.free)}`) + line(`Total size: ${fmtBytes(one.total)}`);
    else if (isFolder(one)) {
      html += '<span class="d" id="det-count"></span>';
      countFor = one.path;
    } else if (one.size != null) html += line(`Size: ${fmtBytes(one.size)}`);
    if (!one.volume) html += line(`Modified: ${fmtDate(one.modified)}`);
  } else {
    const files = picked.filter((it) => it.size != null);
    html = `<b>${picked.length} items selected.</b>` + (files.length ? '<br>' + line(`Total size: ${fmtBytes(files.reduce((n, it) => n + it.size, 0))}`) : '');
  }
  return box('details', 'Details', `<div class="det">${html}</div>`);
}

async function loadCount() {
  const p = countFor;
  if (!p) return;
  const n = await api.count(p, cwd);
  const el = $('det-count');
  if (countFor !== p || !el || n == null) return;
  el.innerHTML = `${n} item${n === 1 ? '' : 's'}<br>`;
}

function renderPane() {
  if (pane !== 'tasks' || !app) return;
  $('pane').innerHTML = tasksBox() + pinnedBox() + placesBox() + detailsBox();
  loadCount();
}

$('pane').addEventListener('click', (e) => {
  const h = e.target.closest('h3');
  if (h) {
    const b = h.closest('.box');
    if (collapsed.has(b.dataset.box)) collapsed.delete(b.dataset.box);
    else collapsed.add(b.dataset.box);
    b.classList.toggle('shut');
    return;
  }
  const x = e.target.closest('[data-unpin]');
  if (x) {
    unpin(pins()[x.dataset.unpin]);
    return;
  }
  const place = e.target.closest('[data-place]');
  if (place) {
    navigate(place.dataset.place);
    return;
  }
  const task = e.target.closest('[data-act]');
  if (!task) return;
  const act = task.dataset.act;
  if (act === 'open') openSelected();
  else if (act === 'openNew') openSelected({ newWindow: true });
  else if (act === 'newWindowHere') api.openWindow(cwd);
  else if (act === 'terminal') openTerminal();
  else if (act === 'pin') pin(targetFolder());
  else if (act === 'unpin') unpin(targetFolder());
  else if (act === 'hidden') api.updateSettings({ showHidden: !app.settings.showHidden });
  else if (act === 'newFolder') makeNew('folder');
  else if (act === 'rename') renameSelected();
  else if (act === 'trash') trashSelected();
  else if (act === 'eject') eject(targetFolder());
  else if (act === 'fda') api.openFullDiskAccess();
  else if (act === 'finderTrash') api.openTrash();
  else if (act === 'emptyTrash') api.emptyTrash();
  else if (act === 'putBack') putBackSelected();
  else if (act === 'putBackAll') putBackSelected(items.map((it) => it.path));
  else if (act === 'deleteNow') api.deleteNow(selectedItems().map((it) => it.path));
});

// Pinning by dropping a folder on the Pinned box (not on a pin, which moves
// it into that folder, see edit.js), and putting the pins in order by
// dragging them.
const PIN_TYPE = 'application/x-filedrawer-pin';
let dragPin = null; // the pin being moved

$('pane').addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-pin]');
  if (!row) return;
  dragPin = Number(row.dataset.pin);
  e.dataTransfer.setData(PIN_TYPE, String(dragPin));
  e.dataTransfer.effectAllowed = 'move';
});
$('pane').addEventListener('dragend', () => {
  dragPin = null;
  clearDropMarks();
});

function clearDropMarks() {
  document.querySelectorAll('.drop-on, .drop-before').forEach((el) => el.classList.remove('drop-on', 'drop-before'));
}

// The Pinned box itself, for a pin being moved or a folder dropped off a pin.
function pinnedTarget(e) {
  const b = e.target.closest('[data-box="pinned"]');
  if (!b) return null;
  const row = e.target.closest('[data-pin]');
  if (dragPin === null && row) return null;
  return { box: b, row };
}

$('pane').addEventListener('dragover', (e) => {
  const t = pinnedTarget(e);
  if (!t) return;
  if (dragPin === null && ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  clearDropMarks();
  if (dragPin !== null && t.row) t.row.classList.add('drop-before');
  else t.box.classList.add('drop-on');
});

$('pane').addEventListener('drop', async (e) => {
  const t = pinnedTarget(e);
  if (!t) return;
  e.preventDefault();
  clearDropMarks();
  if (dragPin !== null) {
    const list = pins().slice();
    const [moved] = list.splice(dragPin, 1);
    let at = t.row ? Number(t.row.dataset.pin) : list.length;
    if (t.row && Number(t.row.dataset.pin) > dragPin) at -= 1;
    list.splice(at, 0, moved);
    dragPin = null;
    api.updateSettings({ pins: list });
    return;
  }
  // The dropped files' paths, read now: the list is empty once the event is over.
  const dropped = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  const paths = [];
  for (const p of dropped) {
    const res = await api.resolve(p, cwd);
    if (res.type === 'dir') paths.push(res.path);
  }
  const fresh = paths.filter((p) => !isPinned(p));
  if (fresh.length) api.updateSettings({ pins: [...pins(), ...fresh] });
});

// ---------- the left pane: the Folders tree ----------

const treeKids = new Map(); // path -> child folders, once listed
const treeOpen = new Set(); // paths shown open
let treeShownFor = null; // the folder the tree last opened its way down to

function treeRoots() {
  const pinned = pins().map((p) => ({ path: p, label: placeLabel(p), icon: specialIcon(p) || 'i-folder', leaf: true }));
  return [
    ...(pinned.length ? [{ group: 'Pinned' }, ...pinned, { group: '' }] : []),
    { path: app.home, label: app.user, icon: 'p-home' },
    { path: COMPUTER, label: 'Computer', icon: 'p-computer' },
    { path: '/Applications', label: 'Applications', icon: 'p-apps' },
    ...(app.settings.places.recents !== false ? [{ path: RECENTS, label: 'Recents', icon: 'p-recents', leaf: true }] : []),
    ...(app.icloudOn && app.settings.places.icloud !== false ? [{ path: ICLOUD, label: 'iCloud Drive', icon: 'p-icloud', leaf: true }] : []),
    { path: TRASH, label: 'Trash', icon: 'p-trash', leaf: true }
  ];
}

async function loadKids(p) {
  if (treeKids.has(p)) return;
  treeKids.set(p, null); // asked for
  // Hidden folders are kept, so the way down to an open hidden folder can show.
  const res = await api.list(p, { hidden: true, extensions: app.settings.showExtensions });
  const dirs = (res.items || []).filter(isFolder)
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' }))
    .map((it) => ({ path: it.path, label: it.display, hidden: it.hidden, icon: it.volume ? 'p-drive' : specialIcon(it.path) || 'i-folder' }));
  treeKids.set(p, dirs);
}

// The folders from the tree's top down to p, which the tree opens.
function chainTo(p) {
  const chain = [];
  if (p === app.home || p.startsWith(app.home + '/')) {
    for (let q = p; ; q = dirname(q)) {
      chain.unshift(q);
      if (q === app.home) break;
    }
  } else {
    for (let q = p; q; q = parentOf(q)) chain.unshift(q);
  }
  return chain;
}

// A hidden folder shows when hidden files are on, or when it's on the way to the open folder.
function shownKids(p) {
  const kids = treeKids.get(p);
  if (!kids || app.settings.showHidden) return kids;
  const chain = chainTo(cwd);
  return kids.filter((k) => !k.hidden || chain.includes(k.path));
}

function nodeHtml(n, depth) {
  if (n.group !== undefined) return `<li class="grp">${esc(n.group)}</li>`;
  const kids = shownKids(n.path);
  const open = treeOpen.has(n.path);
  const tw = n.leaf || (kids && !kids.length) ? '<span class="tw none"></span>' : `<span class="tw">${open ? '&minus;' : '+'}</span>`;
  let html = `<li><div class="n${n.path === cwd ? ' sel' : ''}${n.hidden ? ' hid' : ''}" data-path="${esc(n.path)}" style="padding-left:${4 + depth * 16}px">` +
    `${tw}<svg><use href="#${n.icon}"/></svg><span class="lb">${esc(n.label)}</span></div>`;
  if (!n.leaf && open && kids && kids.length) html += '<ul>' + kids.map((k) => nodeHtml(k, depth + 1)).join('') + '</ul>';
  return html + '</li>';
}

function drawTree() {
  const keep = $('tree-list').scrollTop;
  $('tree-list').innerHTML = '<ul>' + treeRoots().map((n) => nodeHtml(n, 0)).join('') + '</ul>';
  $('tree-list').scrollTop = keep;
}

async function renderTree() {
  if (pane !== 'folders' || !app) return;
  if (treeShownFor !== cwd) {
    treeShownFor = cwd;
    const chain = chainTo(cwd);
    chain.forEach((p) => treeOpen.add(p));
    drawTree();
    for (const p of chain) {
      await loadKids(p);
      if (treeShownFor !== cwd) return;
      drawTree();
    }
    const selEl = $('tree-list').querySelector('.n.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  } else {
    drawTree();
  }
}

$('tree-list').addEventListener('click', async (e) => {
  const n = e.target.closest('.n');
  if (!n) return;
  const p = n.dataset.path;
  if (e.target.closest('.tw')) {
    if (treeOpen.has(p)) treeOpen.delete(p);
    else {
      treeOpen.add(p);
      drawTree();
      await loadKids(p);
    }
    drawTree();
    return;
  }
  navigate(p);
});

$('tree-close').addEventListener('click', () => setPane('tasks'));
$('b-folders').addEventListener('click', () => setPane(pane === 'folders' ? 'tasks' : 'folders'));

function setPane(p, { save = true, quiet = false } = {}) {
  // Leaving the Search pane for another one closes the search.
  if (!quiet && document.body.dataset.pane === 'search') {
    $('b-search').classList.remove('down');
    if (searchOn()) {
      leaveSearch();
      navigate(cwd, { push: false, keep: true });
    }
  }
  pane = p === 'folders' ? 'folders' : 'tasks';
  document.body.dataset.pane = pane;
  $('b-folders').classList.toggle('down', pane === 'folders');
  api.setView({ view, pane, cwd });
  if (save) api.updateSettings({ pane });
  treeShownFor = null;
  renderPane();
  renderTree();
  fitList();
}
