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
const iconUrls = new Map(); // by icon key and pixel size

const isFolder = (it) => it.dir && !it.package;
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
  return it.package || !it.ext ? it.path : '.' + it.ext;
}

function iconHtml(it, cls = 'ic') {
  if (isFolder(it)) return `<svg class="${cls}"><use href="#i-folder"/></svg>`;
  const url = iconUrls.get(`${iconKey(it)}@${iconPx()}`);
  return `<img class="${cls}" alt="" data-key="${esc(iconKey(it))}"${url ? ` src="${url}"` : ''}>`;
}

// Asks for the icons the list is missing, then fills them in.
async function loadIcons() {
  const px = iconPx();
  const want = new Map();
  for (const it of items) {
    if (isFolder(it)) continue;
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
const thumbUrls = new Map(); // by path, null when there's no picture
let thumbWant = new Set();
let thumbTimer = null;
const thumbSeen = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbSeen.unobserve(en.target);
    const it = items[en.target.closest('.item').dataset.i];
    if (it && !thumbUrls.has(it.path)) thumbWant.add(it.path);
  }
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(loadThumbs, 40);
}, { root: document.getElementById('files'), rootMargin: '200px' });

async function loadThumbs() {
  const paths = [...thumbWant];
  thumbWant = new Set();
  if (!paths.length) return;
  const got = await api.thumbs(paths, THUMB_PX);
  for (const [p, url] of Object.entries(got)) thumbUrls.set(p, url);
  if (view !== 'thumbs') return;
  for (const el of rows()) {
    const it = items[el.dataset.i];
    const url = it && thumbUrls.get(it.path);
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
    const url = thumbUrls.get(it.path);
    if (url) showThumb(el, url);
    else if (url === undefined) thumbSeen.observe(el.querySelector('.frame'));
  }
}

// ---------- the list ----------

function sortItems(list) {
  const { key, dir } = app.settings.sort;
  const m = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' });
  return list.slice().sort((a, b) => {
    const fa = isFolder(a);
    const fb = isFolder(b);
    if (fa !== fb) return fa ? -1 : 1; // folders first, like the old windows
    let c = 0;
    if (key === 'size') c = (a.size ?? -1) - (b.size ?? -1);
    else if (key === 'kind') c = a.kind.localeCompare(b.kind);
    else if (key === 'modified') c = a.modified - b.modified;
    return (c || byName(a, b)) * m;
  });
}

const COLUMNS = [
  { key: 'name', label: 'Name', width: '42%' },
  { key: 'size', label: 'Size', width: '12%', cls: 'r' },
  { key: 'kind', label: 'Kind', width: '22%' },
  { key: 'modified', label: 'Date Modified', width: '24%' }
];

function cellFor(col, it) {
  if (col.key === 'name') return `<div class="cell">${iconHtml(it)}<span class="nm">${esc(it.display)}</span></div>`;
  if (col.key === 'size') return fmtKB(it.size);
  if (col.key === 'kind') return esc(it.kind);
  return fmtDate(it.modified);
}

function renderDetails() {
  const { key, dir } = app.settings.sort;
  const head = COLUMNS.map((c) => `<th data-sort="${c.key}" class="${c.cls || ''}${c.key === key ? ` sorted ${dir}` : ''}">${c.label}</th>`).join('');
  const rows = items.map((it, i) =>
    `<tr class="item${sel.has(it.path) ? ' sel' : ''}" data-i="${i}">` +
    COLUMNS.map((c) => `<td class="${c.cls || ''}">${cellFor(c, it)}</td>`).join('') + '</tr>').join('');
  return `<table class="det"><colgroup>${COLUMNS.map((c) => `<col style="width:${c.width}">`).join('')}</colgroup>` +
    `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

const NOTES = {
  denied: 'Filedrawer can\'t open this folder because macOS hasn\'t given it access.',
  missing: 'This folder isn\'t there anymore.',
  other: 'This folder couldn\'t be opened.'
};

const itemAttrs = (it, i) => `class="item${sel.has(it.path) ? ' sel' : ''}" data-i="${i}"`;
const nameHtml = (it) => `<span class="nm">${esc(it.display)}</span>`;

function renderIcons() {
  return '<div class="g-icons">' + items.map((it, i) => `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}${nameHtml(it)}</div>`).join('') + '</div>';
}

function renderTiles() {
  return '<div class="g-tiles">' + items.map((it, i) =>
    `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}<div class="meta">${nameHtml(it)}` +
    `<div class="sub">${esc(it.kind)}</div>${it.size != null ? `<div class="sub">${fmtKB(it.size)}</div>` : ''}</div></div>`).join('') + '</div>';
}

function renderList() {
  return '<div class="g-list">' + items.map((it, i) => `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}${nameHtml(it)}</div>`).join('') + '</div>';
}

function renderThumbs() {
  return '<div class="g-thumbs">' + items.map((it, i) => {
    const url = thumbUrls.get(it.path);
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
  const f = $('files');
  f.dataset.view = view;
  if (listError) {
    f.innerHTML = `<div class="note">${NOTES[listError]}` +
      (listError === 'denied' ? '<br><button id="b-privacy">Open Privacy Settings</button>' : '') + '</div>';
    const b = $('b-privacy');
    if (b) b.addEventListener('click', () => api.openPrivacy());
  } else {
    f.innerHTML = RENDER[view]();
    fitList();
  }
  renderStatus();
  loadIcons();
  watchThumbs();
}

function setView(v) {
  if (!RENDER[v] || v === view) return;
  view = v;
  api.setView(v);
  api.updateSettings({ view: v });
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
  renderStatus();
}

function renderStatus() {
  const picked = items.filter((it) => sel.has(it.path));
  const n = picked.length;
  $('st1').textContent = listError ? '' : n ? `${n} item${n === 1 ? '' : 's'} selected` : `${items.length} item${items.length === 1 ? '' : 's'}`;
  const files = (n ? picked : items).filter((it) => it.size != null);
  const total = files.reduce((sum, it) => sum + it.size, 0);
  $('st2').textContent = files.length ? fmtBytes(total) : '';
}

async function loadVolume() {
  const dir = cwd;
  const v = await api.volume(dir);
  if (dir !== cwd) return;
  volumeName = v && v.name ? v.name : '';
  $('st3').textContent = v ? `${fmtBytes(v.free)} free${volumeName ? ' on ' + volumeName : ''}` : '';
  updateTitle();
}

// ---------- going places ----------

function updateTitle() {
  const name = cwd === '/' ? volumeName || '/' : basename(cwd);
  $('title').textContent = name;
  document.title = name;
  api.setTitle(name, cwd);
}

function updateChrome() {
  if (document.activeElement !== $('path')) $('path').value = cwd;
  $('b-back').classList.toggle('off', hIndex === 0);
  $('b-forward').classList.toggle('off', hIndex >= history.length - 1);
  $('b-up').classList.toggle('off', cwd === '/');
  updateTitle();
}

// Opens dir in this window. select picks an item once it's listed, keep
// holds on to the selection (a refresh).
async function navigate(dir, { push = true, select = null, keep = false } = {}) {
  const token = ++listToken;
  const res = await api.list(dir, { hidden: false });
  if (token !== listToken) return;
  if (push && dir !== cwd) {
    history = history.slice(0, hIndex + 1);
    history.push(dir);
    hIndex = history.length - 1;
  }
  const same = dir === cwd;
  cwd = dir;
  listError = res.error || null;
  items = res.error ? [] : sortItems(res.items);
  const paths = new Set(items.map((it) => it.path));
  if (keep && same) {
    sel = new Set([...sel].filter((p) => paths.has(p)));
  } else {
    sel = new Set(select && paths.has(select) ? [select] : []);
    anchor = cursor = select && paths.has(select) ? select : null;
  }
  render();
  updateChrome();
  if (!same || !volumeName) loadVolume();
  if (!keep && cursor) scrollToItem(cursor);
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
  if (cwd === '/') return;
  navigate(dirname(cwd), { select: cwd });
}

function openItem(it, { newWindow = false } = {}) {
  if (isFolder(it)) {
    if (newWindow) api.openWindow(it.path);
    else navigate(it.path);
  } else {
    api.open(it.path);
  }
}

// Return opens the selection. One folder opens here, more than one each
// open in their own window.
function openSelected({ newWindow = false } = {}) {
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

$('files').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.item');
  if (el) openItem(items[el.dataset.i]);
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
  if (e.target === $('path')) return;
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
    (en.icon ? `<svg class="mic"><use href="#${en.icon}"/></svg>` : '') +
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

$('files').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const el = e.target.closest('.item');
  if (!el) {
    sel.clear();
    showSelection();
    openMenu([
      { label: 'View', sub: viewEntries() },
      { label: 'Arrange Icons By', sub: sortEntries() },
      { label: 'Refresh', click: () => navigate(cwd, { push: false, keep: true }) }
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
  const entries = [{ label: 'Open', bold: true, click: () => openSelected() }];
  if (picked.every(isFolder)) entries.push({ label: 'Open in New Window', click: () => openSelected({ newWindow: true }) });
  openMenu(entries, e.clientX, e.clientY);
});

// Back and Forward each have a list of where they go, under their arrow.
function historyMenu(which, anchorEl) {
  const entries = [];
  if (which === 'back') for (let i = hIndex - 1; i >= 0 && entries.length < 12; i--) entries.push(i);
  else for (let i = hIndex + 1; i < history.length && entries.length < 12; i++) entries.push(i);
  const r = anchorEl.getBoundingClientRect();
  anchorEl.closest('.tb').classList.add('down');
  openMenu(entries.map((i) => ({ label: basename(history[i]), icon: 'i-folder', click: () => goHistory(i) })), r.left, r.bottom + 2);
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
  for (let p = cwd; ; p = dirname(p)) {
    list.push(p);
    if (p === '/') break;
  }
  const r = $('b-places').closest('.addr').getBoundingClientRect();
  $('b-places').classList.add('down');
  openMenu(list.map((p) => ({ label: p === '/' ? volumeName || '/' : basename(p), icon: 'i-folder', checked: p === cwd, click: () => navigate(p) })), r.left, r.bottom + 2);
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
      path.value = cwd;
      $('files').focus();
    }
  }
});

path.addEventListener('blur', () => {
  hideSuggest();
  if (!$('addr-error').classList.contains('open')) path.value = cwd;
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
    path.value = cwd;
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
    path.value = cwd;
    $('files').focus();
  } else {
    const box = $('addr-error');
    box.textContent = `Can't find "${text}". Check the spelling and try again.`;
    box.classList.add('open');
  }
}

// ---------- commands from the menu bar ----------

api.onCommand(({ command, arg }) => {
  const typing = document.activeElement === path;
  switch (command) {
    case 'newWindow': api.openWindow(cwd); break;
    case 'open': if (!typing) openSelected(); break;
    case 'selectAll':
      if (typing) path.select();
      else {
        sel = new Set(items.map((it) => it.path));
        showSelection();
      }
      break;
    case 'refresh': navigate(cwd, { push: false, keep: true }); break;
    case 'view': setView(arg); break;
    case 'sort': sortBy(arg); break;
    case 'back': back(); break;
    case 'forward': forward(); break;
    case 'up': up(); break;
    case 'home': navigate(app.home); break;
    case 'address': path.focus(); break;
    default:
  }
});

// ---------- start ----------

function applyState(state) {
  const old = app;
  app = state;
  window.applyTheme(state);
  if (old && JSON.stringify(old.settings.sort) !== JSON.stringify(state.settings.sort)) {
    items = sortItems(items);
    render();
  }
}

api.onState(applyState);
api.getState().then((state) => {
  applyState(state);
  view = state.settings.view;
  api.setView(view);
  navigate(cwd, { push: false });
  $('files').focus();
});
