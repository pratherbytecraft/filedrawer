// One Filedrawer window: a folder's items, the toolbar, the address bar and
// the status bar. Each window keeps its own back and forward history.
const api = window.filedrawer;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// An element whose data-<K> attribute is always set, read from its dataset.
type Data<K extends string, V extends string = string> = HTMLElement & { dataset: Record<K, V> };
// A row drawn from a list, data-i being its index in that list.
type Row = Data<'i', `${number}`>;
// A row of a menu drawn in the window, or 'sep' for a line.
interface MenuEntry {
  label: string;
  bold?: boolean;
  icon?: string;
  key?: string;
  click?: () => unknown;
  disabled?: boolean;
  checked?: boolean;
  sub?: MenuItem[];
}
type MenuItem = MenuEntry | 'sep';
// A column of Details.
interface Column {
  key: string;
  label: string;
  width?: string;
  cls?: string;
}
interface NavOptions {
  push?: boolean;
  select?: string | null;
  selectMany?: string[] | null;
  keep?: boolean;
  changed?: boolean;
}
interface OpenOptions {
  newWindow?: boolean;
  inTab?: boolean;
}
// A folder in the Folders tree, or a group's heading.
interface TreeNode {
  path: string;
  label: string;
  icon: string;
  hidden?: boolean;
  leaf?: boolean;
  group?: undefined;
}
type TreeRow = TreeNode | { group: string };
// A folder's listing that worked.
type FolderListing = Extract<Listing, { error?: undefined }>;

// Most of the window runs once getState has answered. The checks on app
// that are left are for the few calls that can come before it.
let app = null as unknown as State; // state from the main process
let cwd = new URLSearchParams(location.search).get('path') || '/';
// Back and forward. Not called history, the name of the page's own.
let hist = [cwd];
let hIndex = 0;
let items: Item[] = []; // the folder's items, sorted
let listError: ListError | null = null;
let sel = new Set<string>(); // selected paths
let anchor: string | null = null; // where a Shift click or Shift arrow starts from
let cursor: string | null = null; // the item the arrow keys move from
let listToken = 0;
let volumeName = '';
let view = 'details'; // thumbs | tiles | icons | list | details, this window's own
let pane = 'tasks'; // tasks | folders, this window's own
let COMPUTER = '::computer'; // the place listing the volumes, from the main process
// The places that aren't one folder, from the main process too.
let TRASH = '::trash';
let RECENTS = '::recents';
let ICLOUD = '::icloud';
const isPlace = (p: string) => p === COMPUTER || p === TRASH || p === RECENTS || p === ICLOUD;
let folderModified: number | null = null; // the open folder's own date, for the Details box
let cwdWritable = true; // new items and pastes can go in the open folder
let split: Split | null = null; // { other } while this tab shows two panes, see split.ts
const iconUrls = new Map<string, string>(); // by icon key and pixel size

const isFolder = (it: Item) => it.dir && !it.package;
const isVolumeRoot = (p: string) => p === '/' || /^\/Volumes\/[^/]+$/.test(p);

// The folder above p: a volume's top goes up to Computer, and Computer is the top.
function parentOf(p: string) {
  if (isPlace(p)) return null;
  if (isVolumeRoot(p)) return COMPUTER;
  if (app && p.startsWith(app.home + '/.Trash/') && dirname(p) === app.home + '/.Trash') return TRASH;
  return dirname(p);
}

function placeLabel(p: string) {
  if (p === COMPUTER) return 'Computer';
  if (p === TRASH) return 'Trash';
  if (p === RECENTS) return 'Recents';
  if (p === ICLOUD) return 'iCloud Drive';
  if (p === '/') return volumeName || 'Macintosh HD';
  if (app && p === app.home) return app.user;
  return basename(p);
}

// Folders with an icon of their own, by path.
function specialIcon(p: string) {
  if (!app) return null;
  const h = app.home;
  return { [h]: 'p-home', [h + '/Desktop']: 'p-desktop', [h + '/Documents']: 'p-docs', [h + '/Downloads']: 'p-down',
    '/Applications': 'p-apps', [COMPUTER]: 'p-computer', [TRASH]: 'p-trash', [RECENTS]: 'p-recents', [ICLOUD]: 'p-icloud' }[p] || (isVolumeRoot(p) ? 'p-drive' : null);
}
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
// split always gives at least one part.
const basename = (p: string) => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop() as string);
const dirname = (p: string) => (p === '/' ? '/' : p.replace(/\/[^/]*\/?$/, '') || '/');

// ---------- formatting ----------

function fmtKB(bytes: number | null | undefined) {
  if (bytes == null) return '';
  return Math.max(bytes ? 1 : 0, Math.ceil(bytes / 1000)).toLocaleString('en-US') + ' KB';
}

function fmtBytes(bytes: number) {
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

function fmtDate(ms: number) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Dates subtract as their times in ms.
  const diff = Math.round(((today as unknown as number) - (day as unknown as number)) / 86400000);
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

function iconKey(it: Item) {
  return it.package || it.volume || !it.ext ? it.path : '.' + it.ext;
}

const drawn = (it: Item) => isFolder(it) && !it.volume;

function iconHtml(it: Item, cls = 'ic') {
  if (drawn(it)) return `<svg class="${cls}"><use href="#${specialIcon(it.path) || 'i-folder'}"/></svg>`;
  const pic = previewsOn() && canPreview(it) ? thumbUrls.get(thumbKey(it)) : null;
  if (pic) return previewHtml(pic, cls);
  const url = iconUrls.get(`${iconKey(it)}@${iconPx()}`);
  return `<img class="${cls}" alt="" data-key="${esc(iconKey(it))}"${url ? ` src="${url}"` : ''}>`;
}

// Asks for the icons the list is missing, then fills them in.
async function loadIcons() {
  const px = iconPx();
  const want = new Map<string, IconRequest>();
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
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-key]')) {
    const url = iconUrls.get(`${img.dataset.key}@${px}`);
    if (url && !img.src) img.src = url;
  }
}

// Quick Look pictures of the files in sight, asked for as they scroll into
// view: always in Thumbnails, and in place of the icon in the other views
// while previews are on. A file Quick Look can't draw keeps its icon.
// Folders, apps and other packages, disks and aliases always do.
const THUMB_PX = 192;
const thumbUrls = new Map<string, string | null>(); // by path, date and size, null when there's no picture
const previewsOn = () => view !== 'thumbs' && !!(app && app.settings.previews);
const previewPx = () => (view === 'thumbs' ? THUMB_PX : iconPx());
const thumbKey = (it: Item, px = previewPx()) => `${it.path}:${it.modified}@${px}`;
const canPreview = (it: Item) => !isFolder(it) && !it.package && !it.volume && !it.alias;
// The picture keeps its shape inside the icon's square.
const previewHtml = (url: string, cls: string) => `<span class="${cls} pv"><img alt="" src="${url}"></span>`;
let thumbWant = new Set<Item>();
let thumbTimer: number | null = null;
const thumbSeen = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbSeen.unobserve(en.target);
    // Only the list's rows are watched.
    const it = items[(en.target.closest('.item') as Row).dataset.i];
    if (it && !thumbUrls.has(thumbKey(it))) thumbWant.add(it);
  }
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(loadThumbs, 40);
}, { root: document.getElementById('files'), rootMargin: '200px' });

async function loadThumbs() {
  const want = [...thumbWant];
  thumbWant = new Set();
  if (!want.length) return;
  const px = previewPx();
  const got = await api.thumbs(want.map((it) => it.path), px);
  for (const it of want) thumbUrls.set(thumbKey(it, px), got[it.path] || null);
  if (px !== previewPx() || (view !== 'thumbs' && !previewsOn())) return;
  for (const el of rows()) {
    const it = items[el.dataset.i];
    const url = it && thumbUrls.get(thumbKey(it));
    if (url) showThumb(el, url);
  }
}

function showThumb(el: Element, url: string) {
  const frame = el.querySelector('.frame');
  if (frame) {
    if (!frame.querySelector('.pic')) frame.innerHTML = `<img class="pic" alt="" src="${url}">`;
    return;
  }
  const icon = el.querySelector('img.ic, img.big');
  if (icon) icon.outerHTML = previewHtml(url, icon.classList.contains('big') ? 'big' : 'ic');
}

function watchThumbs() {
  thumbSeen.disconnect();
  if (view !== 'thumbs' && !previewsOn()) return;
  for (const el of rows()) {
    const it = items[el.dataset.i];
    if (!it || !canPreview(it)) continue;
    const url = thumbUrls.get(thumbKey(it));
    if (url) showThumb(el, url);
    else if (url === undefined) thumbSeen.observe(el);
  }
}

// ---------- the list ----------

// Each folder keeps the sort and the Details columns picked for it. One never
// changed goes by name and shows Date Modified, except Downloads, which goes
// newest added first and shows Date Added, like Finder.
const BY_NAME: FolderSort = { key: 'name', dir: 'asc' };
const NEWEST_ADDED: FolderSort = { key: 'added', dir: 'desc' };
const isDownloads = (dir: string) => !!app && dir === app.home + '/Downloads';
const folderColumns = (): ColumnKey[] => (app && app.settings.folderColumns[cwd]) || (isDownloads(cwd) ? ['size', 'kind', 'added'] : ['size', 'kind', 'modified']);

// A sort on a column the list doesn't show goes back to the folder's first sort.
function folderSort() {
  const s = app && app.settings.folderSorts[cwd];
  const set = columnSet();
  const shown = set === 'files' ? ['name', ...folderColumns()] : set === 'search' ? SEARCH_COLUMNS.map((c) => c.key) : null;
  if (s && (!shown || shown.includes(s.key))) return s;
  return set === 'files' && isDownloads(cwd) ? NEWEST_ADDED : BY_NAME;
}

// What the menus show for this window.
const look = (): WindowLook => ({ view, pane, cwd, split: !!split, sort: folderSort() });

function sortItems(list: Item[]) {
  // Computer is always by name and Recents newest first, whatever the folders' sort.
  const fixedSort: FolderSort | null = searchOn() ? null : cwd === COMPUTER ? BY_NAME : cwd === RECENTS ? { key: 'used', dir: 'desc' } : null;
  const { key, dir } = fixedSort || folderSort();
  const m = dir === 'desc' ? -1 : 1;
  const byName = (a: Item, b: Item) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' });
  return list.slice().sort((a, b) => {
    const fa = isFolder(a);
    const fb = isFolder(b);
    if (fa !== fb && app.settings.foldersFirst && cwd !== RECENTS) return fa ? -1 : 1; // folders first, like the old windows
    let c = 0;
    if (key === 'size') c = (a.size ?? -1) - (b.size ?? -1);
    else if (key === 'kind') c = a.kind.localeCompare(b.kind);
    else if (key === 'modified') c = a.modified - b.modified;
    else if (key === 'created') c = (a.created || 0) - (b.created || 0);
    else if (key === 'added') c = (a.added || 0) - (b.added || 0);
    else if (key === 'deleted') c = (a.deleted || 0) - (b.deleted || 0);
    else if (key === 'used') c = (a.used || 0) - (b.used || 0);
    else if (key === 'from') c = (a.from || '').localeCompare(b.from || '');
    return (c || byName(a, b)) * m;
  });
}

// Every column a folder can show, in the order they sit, with their shares
// of the window until a column was resized.
const FILE_COLUMNS: { key: 'name' | ColumnKey; label: string; share: number; cls?: string }[] = [
  { key: 'name', label: 'Name', share: 40 },
  { key: 'size', label: 'Size', share: 15, cls: 'r' },
  { key: 'kind', label: 'Kind', share: 21 },
  { key: 'modified', label: 'Date Modified', share: 24 },
  { key: 'created', label: 'Date Created', share: 24 },
  { key: 'added', label: 'Date Added', share: 24 }
];

function filesColumns() {
  const shown = folderColumns();
  const cols = FILE_COLUMNS.filter((c) => c.key === 'name' || shown.includes(c.key));
  const total = cols.reduce((t, c) => t + c.share, 0);
  return cols.map((c) => ({ ...c, width: `${+(c.share * 100 / total).toFixed(2)}%` }));
}

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

function cellFor(col: Column, it: Item) {
  if (col.key === 'name') return `<div class="cell">${iconHtml(it)}<span class="nm">${esc(it.display)}</span></div>`;
  if (col.key === 'size') return fmtKB(it.size);
  if (col.key === 'kind') return esc(it.kind);
  if (col.key === 'folder') return `<span title="${esc(dirname(it.path))}">${esc(shortFolder(it.path))}</span>`;
  if (col.key === 'total' || col.key === 'free') return it[col.key] != null ? fmtBytes(it[col.key] as number) : '';
  if (col.key === 'from') return it.from ? `<span title="${esc(dirname(it.from))}">${esc(shortFolder(it.from))}</span>` : '';
  if (col.key === 'deleted') return it.deleted ? fmtDate(it.deleted) : '';
  if (col.key === 'used') return it.used ? fmtDate(it.used) : '';
  if (col.key === 'created') return it.created ? fmtDate(it.created) : '';
  if (col.key === 'added') return it.added ? fmtDate(it.added) : '';
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

// The column widths are kept per kind of list, since their columns differ.
const COLUMN_SETS = { files: null, computer: COMPUTER_COLUMNS, trash: TRASH_COLUMNS, recents: RECENTS_COLUMNS, search: SEARCH_COLUMNS };
const columnSet = () => (searchOn() ? 'search' : cwd === COMPUTER ? 'computer' : cwd === TRASH ? 'trash' : cwd === RECENTS ? 'recents' : 'files');

function renderDetails() {
  const fixedHead = (cwd === COMPUTER || cwd === RECENTS) && !searchOn(); // headers that don't sort
  const set = columnSet();
  const cols: Column[] = set === 'files' ? filesColumns() : COLUMN_SETS[set];
  // Widths in points once a column was resized, shares of the window until
  // then. A date turned on after that starts as wide as the other dates.
  const saved = app.settings.columnWidths[set];
  const dateWidth = saved && (saved.modified || saved.created || saved.added);
  const fresh = (c: Column) => (DATE_COLUMNS.includes(c.key) && dateWidth) || NEW_COLUMN;
  const widths = saved && cols.some((c) => saved[c.key]) ? cols.map((c) => saved[c.key] || fresh(c)) : null;
  const { key, dir } = folderSort();
  const edge = (c: Column) => `<span class="rz" data-rz="${c.key}"></span>`;
  const head = cols.map((c) => fixedHead || c.key === 'folder' ? `<th data-col="${c.key}" class="${c.cls || ''}">${c.label}${edge(c)}</th>` :
    `<th data-col="${c.key}" data-sort="${c.key}" class="${c.cls || ''}${c.key === key ? ` sorted ${dir}` : ''}">${c.label}${edge(c)}</th>`).join('');
  const rows = items.map((it, i) =>
    `<tr ${itemAttrs(it, i)}>` +
    cols.map((c) => `<td class="${c.cls || ''}">${cellFor(c, it)}</td>`).join('') + '</tr>').join('');
  const width = widths ? ` style="width:${widths.reduce((a, b) => a + b, 0)}px"` : '';
  return `<table class="det" data-set="${set}"${width}><colgroup>${cols.map((c, i) => `<col style="width:${widths ? widths[i] + 'px' : c.width}">`).join('')}</colgroup>` +
    `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// Dragging the edge of a header makes that column wider or narrower, and a
// double click fits it to its longest entry. Every column of the list is
// saved in points then, and the list scrolls sideways when they don't fit.
const MIN_COLUMN = 40;
const NEW_COLUMN = 160;
const DATE_COLUMNS = ['modified', 'created', 'added'];

function saveWidths(table: HTMLTableElement, widths: number[]) {
  const keys = [...table.querySelectorAll('th')].map((th) => th.dataset.col);
  const set = Object.fromEntries(keys.map((k, i) => [k, Math.round(widths[i])]));
  // Columns turned off keep their widths for when they come back.
  // Every Details table carries its kind of list.
  const old = app.settings.columnWidths[table.dataset.set as string];
  api.updateSettings({ columnWidths: { ...app.settings.columnWidths, [table.dataset.set as string]: { ...old, ...set } } });
}

function resizeColumn(edge: HTMLElement, e: MouseEvent) {
  e.preventDefault();
  // An edge is always in a header cell of a table.
  const table = edge.closest('table') as HTMLTableElement;
  const ths = [...table.querySelectorAll('th')];
  const cols = [...table.querySelectorAll('col')];
  const widths = ths.map((th) => th.getBoundingClientRect().width);
  const i = ths.indexOf(edge.closest('th') as HTMLTableCellElement);
  const x0 = e.clientX;
  const w0 = widths[i];
  let moved = false;
  const draw = () => {
    cols.forEach((col, k) => { col.style.width = widths[k] + 'px'; });
    table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
  };
  document.body.classList.add('resizing');
  const move = (m: MouseEvent) => {
    if (m.clientX === x0 && !moved) return;
    moved = true;
    widths[i] = Math.max(MIN_COLUMN, Math.round(w0 + m.clientX - x0));
    draw();
  };
  // A press on the edge that doesn't move leaves the widths as they were.
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
    if (moved) saveWidths(table, widths);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// How wide a cell has to be to show all of its text, cut off now or not:
// the text, anything before it such as the icon, and the padding.
function contentWidth(cell: HTMLElement) {
  const range = document.createRange();
  const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let left = Infinity;
  let right = -Infinity;
  while (walk.nextNode()) {
    range.selectNodeContents(walk.currentNode);
    const r = range.getBoundingClientRect();
    if (!r.width) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  if (right < left) return 0;
  const box = cell.getBoundingClientRect();
  const style = getComputedStyle(cell);
  const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  // Right aligned text grows to the left, so only its own width counts.
  return cell.classList.contains('r') ? right - left + pad : right - box.left + parseFloat(style.paddingRight);
}

function fitColumn(edge: HTMLElement) {
  // An edge is always in a header cell of a table.
  const table = edge.closest('table') as HTMLTableElement;
  const ths = [...table.querySelectorAll('th')];
  const th = edge.closest('th') as HTMLTableCellElement;
  const i = ths.indexOf(th);
  let w = contentWidth(th) + 14; // room for the sort arrow
  for (const row of table.tBodies[0].rows) w = Math.max(w, contentWidth(row.cells[i]));
  const widths = ths.map((x) => x.getBoundingClientRect().width);
  widths[i] = Math.max(MIN_COLUMN, Math.ceil(w) + 4);
  saveWidths(table, widths);
}

const NOTES = {
  denied: 'Filedrawer can\'t open this folder because macOS hasn\'t given it access.',
  missing: 'This folder isn\'t there anymore.',
  fda: '<b>Filedrawer needs Full Disk Access to show the Trash</b><br>macOS keeps the Trash private from other apps. Turn on Filedrawer under Full Disk Access in Privacy and Security, then pick Quit &amp; Reopen when macOS asks.',
  icloud: 'iCloud Drive isn\'t turned on for this Mac.',
  other: 'This folder couldn\'t be opened.'
};

const itemAttrs = (it: Item, i: number) => `class="item${sel.has(it.path) ? ' sel' : ''}${it.hidden ? ' hid' : ''}${(app.cut || []).includes(it.path) ? ' cut' : ''}" data-i="${i}"${it.volume ? '' : ' draggable="true"'}`;
const nameHtml = (it: Item) => `<span class="nm">${esc(it.display)}</span>`;

function renderIcons() {
  return '<div class="g-icons">' + items.map((it, i) => `<div ${itemAttrs(it, i)}>${iconHtml(it, 'big')}${nameHtml(it)}</div>`).join('') + '</div>';
}

function tileLine(it: Item) {
  // A disk whose size can't be read shows its free space alone.
  if (it.volume && it.free != null) return `<div class="sub">${fmtBytes(it.free)} free${it.total != null ? ` of ${fmtBytes(it.total)}` : ''}</div>`;
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

const RENDER: Record<string, () => string> = { details: renderDetails, icons: renderIcons, tiles: renderTiles, list: renderList, thumbs: renderThumbs };

// List fills columns top to bottom, as many rows as fit the window.
function fitList() {
  const grid = $('files').querySelector<HTMLElement>('.g-list');
  if (!grid) return;
  const row = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--list-row'), 10) || 20;
  // setProperty turns the number into a string.
  grid.style.setProperty('--rows', Math.max(1, Math.floor(($('files').clientHeight - 8) / row)) as unknown as string);
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
  // Greyed while the Trash is empty. Without Full Disk Access Filedrawer
  // can't see inside, and Finder can still empty it.
  $('b-empty').classList.toggle('off', cwd === TRASH && !listError && !items.length);
  renderStatus();
  renderPane();
  loadIcons();
  watchThumbs();
}

function setView(v: string) {
  if (!RENDER[v] || v === view) return;
  view = v;
  api.setView(look());
  const patch: SettingsPatch = { view: v };
  if (app.settings.perFolderView && cwd !== COMPUTER) patch.folderViews = { ...app.settings.folderViews, [cwd]: v };
  api.updateSettings(patch);
  const keep = $('files').scrollTop;
  render();
  if (cursor) scrollToItem(cursor);
  else $('files').scrollTop = keep;
}

let fitTimer: number | null = null;
window.addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitList, 50);
});

function rows() {
  return [...$('files').querySelectorAll<Row>('.item')];
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
  const total = files.reduce((sum, it) => sum + (it.size as number), 0); // sizes filtered above
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
  drawTabs();
  drawHeads();
}

const shownPath = (p: string) => (isPlace(p) ? placeLabel(p) : p);

function updateChrome() {
  if (document.activeElement !== $('path')) $<HTMLInputElement>('path').value = shownPath(cwd);
  $('b-back').classList.toggle('off', hIndex === 0);
  $('b-forward').classList.toggle('off', hIndex >= hist.length - 1);
  $('b-up').classList.toggle('off', !parentOf(cwd));
  $('b-term').classList.toggle('off', !targetFolder());
  if ($('b-empty').hidden !== !buttonWanted('b-empty')) fitToolbar();
  const icon = `<use href="#${specialIcon(cwd) || 'i-folder'}"/>`;
  $('addr-icon').innerHTML = icon;
  $('title-icon').innerHTML = icon;
  api.setView(look());
  updateTitle();
  renderTree();
}

// Opens dir in this window. select picks an item once it's listed, keep
// holds on to the selection (a refresh).
async function navigate(dir: string, { push = true, select = null, selectMany = null, keep = false, changed = false }: NavOptions = {}) {
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
    hist = hist.slice(0, hIndex + 1);
    hist.push(dir);
    hIndex = hist.length - 1;
  }
  const same = dir === cwd;
  cwd = dir;
  // A folder with a view of its own opens in it, the rest in the view picked last.
  if (!same && app.settings.perFolderView) {
    const own = app.settings.folderViews[dir];
    const want = RENDER[own] ? own : app.settings.view;
    if (want !== view) {
      view = want;
      api.setView(look());
    }
  }
  listError = res.error || null;
  // A listing that failed has neither, which reads the same as missing ones.
  folderModified = (res as FolderListing).modified || null;
  cwdWritable = (res as FolderListing).writable !== false;
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

function goHistory(i: number) {
  if (i < 0 || i >= hist.length) return;
  const from = cwd;
  hIndex = i;
  navigate(hist[i], { push: false, select: from });
}

const back = () => goHistory(hIndex - 1);
const forward = () => goHistory(hIndex + 1);

function up() {
  const parent = parentOf(cwd);
  if (parent) navigate(parent, { select: cwd });
}

// Folders open here, in a new window or in a new tab, per Folder Options.
function openItem(it: Item, { newWindow = app.settings.openFolders === 'new', inTab = app.settings.openFolders === 'tab' }: OpenOptions = {}) {
  const dir = it.alias && it.aliasDir ? it.alias : isFolder(it) ? it.path : null;
  if (!dir) api.open(it.path);
  else if (newWindow) api.openWindow(dir);
  else if (inTab) newTab(dir);
  else navigate(dir);
}

// Return opens the selection. One folder opens here, more than one each
// open in their own window.
function openSelected({ newWindow = app.settings.openFolders === 'new', inTab = app.settings.openFolders === 'tab' }: OpenOptions = {}) {
  const picked = items.filter((it) => sel.has(it.path));
  if (!picked.length) return;
  // More than one folder each open in their own tab, or window. Files open
  // together, so pictures share one Preview window.
  const many = picked.filter(isFolder).length > 1;
  const files = picked.filter((it) => !isFolder(it) && !(it.alias && it.aliasDir));
  if (files.length > 1) api.open(files.map((it) => it.path));
  for (const it of picked) if (files.length < 2 || !files.includes(it)) openItem(it, { newWindow, inTab: inTab || (many && !newWindow) });
}

// ---------- selection with the mouse and keys ----------

function scrollToItem(p: string) {
  const i = items.findIndex((it) => it.path === p);
  const el = i >= 0 && $('files').querySelector<HTMLElement>(`.item[data-i="${i}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  // The sticky header covers the top row.
  const head = $('files').querySelector('thead');
  if (head) {
    const top = el.offsetTop - head.offsetHeight;
    if (top < $('files').scrollTop) $('files').scrollTop = top;
  }
}

function selectRange(from: string, to: string) {
  const a = items.findIndex((it) => it.path === from);
  const b = items.findIndex((it) => it.path === to);
  if (a < 0 || b < 0) return new Set([to]);
  return new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((it) => it.path));
}

$('files').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const edge = (e.target as HTMLElement).closest<HTMLElement>('.rz');
  if (edge) {
    resizeColumn(edge, e);
    return;
  }
  const th = (e.target as HTMLElement).closest<Data<'sort', SortKey>>('th[data-sort]');
  if (th) {
    sortBy(th.dataset.sort);
    return;
  }
  const el = (e.target as HTMLElement).closest<Row>('.item');
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

// Command double click always opens a folder in a new window. On a
// header's edge it fits the column.
$('files').addEventListener('dblclick', (e) => {
  const edge = (e.target as HTMLElement).closest<HTMLElement>('.rz');
  if (edge) {
    fitColumn(edge);
    return;
  }
  const el = (e.target as HTMLElement).closest<Row>('.item');
  if (!el || app.settings.clickToOpen === 'single') return;
  openItem(items[el.dataset.i], e.metaKey ? { newWindow: true } : undefined);
});

// A middle click opens a folder, or a place in the left pane, in a new tab.
document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const el = (e.target as HTMLElement).closest<Row>('#files .item');
  const place = (e.target as HTMLElement).closest<HTMLElement>('#pane [data-place], #tree-list .n');
  if (el) {
    const it = items[el.dataset.i];
    const dir = it.alias && it.aliasDir ? it.alias : isFolder(it) ? it.path : null;
    if (dir) newTab(dir);
  } else if (place) {
    newTab(place.dataset.place || place.dataset.path);
  }
});

// With single click, a plain click on an item opens it once the button comes
// up where it went down, so a drag still moves it.
$('files').addEventListener('click', (e) => {
  if (app.settings.clickToOpen !== 'single' || e.shiftKey || e.altKey || e.button !== 0) return;
  if (e.metaKey && !(e.target as HTMLElement).closest('.item')) return;
  const el = (e.target as HTMLElement).closest<Row>('.item');
  if (!el || (e.target as HTMLElement).closest('input')) return;
  if (e.metaKey) return; // Command click adds to the selection
  openItem(items[el.dataset.i]);
});

// How far the arrow keys move in the current view: Up and Down go a whole
// row in the grids, Left and Right a whole column in List.
function stepFor(key: string) {
  const els = rows();
  if (view === 'details') return ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[key] || 0;
  if (view === 'list') {
    const perCol = els.filter((el) => el.offsetLeft === (els[0] && els[0].offsetLeft)).length || 1;
    return ({ ArrowDown: 1, ArrowUp: -1, ArrowRight: perCol, ArrowLeft: -perCol } as Record<string, number>)[key] || 0;
  }
  const perRow = els.filter((el) => el.offsetTop === (els[0] && els[0].offsetTop)).length || 1;
  return ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow } as Record<string, number>)[key] || 0;
}

function moveCursor(delta: number, extend: boolean) {
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
  const row = $('files').querySelector<HTMLElement>('.item');
  if (!row) return 10;
  const down = Math.max(1, stepFor('ArrowDown'));
  return Math.max(1, Math.floor($('files').clientHeight / row.offsetHeight) - 1) * (view === 'list' ? 1 : down);
}

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea')) return;
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
function fillMenu(m: HTMLElement, entries: MenuItem[]) {
  m.innerHTML = entries.map((en, i) => en === 'sep' ? '<div class="sep"></div>' :
    `<div class="mi${en.disabled ? ' disabled' : ''}${en.checked ? ' chk' : ''}${en.sub ? ' sub' : ''}" data-i="${i}">` +
    `<svg class="mic">${en.icon ? `<use href="#${en.icon}"/>` : ''}</svg>` +
    (en.bold ? `<b>${esc(en.label)}</b>` : esc(en.label)) + (en.key ? `<span class="key">${esc(en.key)}</span>` : '') + '</div>').join('');
  // Only entries get a row with data-i, and only disabled ones have no
  // click, which take no clicks.
  m.onclick = (e) => {
    const el = (e.target as HTMLElement).closest<Row>('.mi');
    if (!el || (entries[el.dataset.i] as MenuEntry).sub) return;
    closeMenu();
    (entries[el.dataset.i] as Required<MenuEntry>).click();
  };
  m.onmouseover = (e) => {
    const el = (e.target as HTMLElement).closest<Row>('.mi');
    if (!el || m.id !== 'menu') return;
    const en = entries[el.dataset.i] as MenuEntry;
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
function placeMenu(m: HTMLElement, entries: MenuItem[], x: number, y: number, flipX?: number) {
  fillMenu(m, entries);
  m.classList.add('open');
  const r = m.getBoundingClientRect();
  const left = x + r.width > innerWidth - 4 && flipX !== undefined ? flipX - r.width : Math.min(x, innerWidth - r.width - 4);
  m.style.left = Math.max(4, left) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}

function openMenu(entries: MenuItem[], x: number, y: number) {
  $('submenu').classList.remove('open');
  placeMenu($('menu'), entries, x, y);
}

function closeMenu() {
  $('menu').classList.remove('open');
  $('submenu').classList.remove('open');
  document.querySelectorAll('.tb.down, .dd.down').forEach((el) => el.classList.remove('down'));
}

const VIEWS = [['thumbs', 'Thumbnails'], ['tiles', 'Tiles'], ['icons', 'Icons'], ['list', 'List'], ['details', 'Details']];
const SORTS: [SortKey, string][] = [['name', 'Name'], ['size', 'Size'], ['kind', 'Kind'], ['modified', 'Date Modified'], ['created', 'Date Created'], ['added', 'Date Added']];

const viewEntries = () => VIEWS.map(([v, label]) => ({ label, checked: v === view, click: () => setView(v) }));
const sortEntries = () => SORTS.map(([k, label]) => ({ label, checked: k === folderSort().key, click: () => sortBy(k) }));

// Sorts the folder shown, and only that one. Sorting by the same thing again
// turns it around. Arranging by a column the folder doesn't show turns it on.
function sortBy(key: SortKey) {
  const s = folderSort();
  const patch: SettingsPatch = { folderSorts: { ...app.settings.folderSorts, [cwd]: { key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' } } };
  const shown = folderColumns();
  if (columnSet() === 'files' && key !== 'name' && !shown.includes(key as ColumnKey)) patch.folderColumns = { ...app.settings.folderColumns, [cwd]: withColumn(shown, key) };
  api.updateSettings(patch);
}

// A header's right click turns this folder's columns on and off. Name always shows.
// key is never name, so neither is any key kept.
const withColumn = (shown: ColumnKey[], key: string) => FILE_COLUMNS.map((c) => c.key).filter((k): k is ColumnKey => k === key || shown.includes(k as ColumnKey));
const columnEntries = () => FILE_COLUMNS.map((c) => (c.key === 'name' ? { label: c.label, checked: true, disabled: true }
  : { label: c.label, checked: folderColumns().includes(c.key), click: () => toggleColumn(c.key as ColumnKey) })); // not name here

function toggleColumn(key: ColumnKey) {
  const shown = folderColumns();
  const on = !shown.includes(key);
  const patch: SettingsPatch = { folderColumns: { ...app.settings.folderColumns, [cwd]: on ? withColumn(shown, key) : shown.filter((k) => k !== key) } };
  // Turning off the column it sorts by puts the folder back on its first sort.
  if (!on && (app.settings.folderSorts[cwd] || ({} as Partial<FolderSort>)).key === key) {
    patch.folderSorts = { ...app.settings.folderSorts };
    delete patch.folderSorts[cwd];
  }
  api.updateSettings(patch);
}

document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.menu') && !(e.target as HTMLElement).closest('[data-drop]') && !(e.target as HTMLElement).closest('#b-places') &&
    !(e.target as HTMLElement).closest('#b-views') && !(e.target as HTMLElement).closest('#b-more')) closeMenu();
  if (!(e.target as HTMLElement).closest('.addrrow')) hideSuggest();
}, true);
window.addEventListener('blur', closeMenu);

$('files').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if ((e.target as HTMLElement).closest('thead')) {
    if (columnSet() === 'files') openMenu(columnEntries(), e.clientX, e.clientY);
    return;
  }
  const el = (e.target as HTMLElement).closest<Row>('.item');
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
    const here: MenuItem[] = isPlace(cwd) ? [] : ['sep',
      { label: 'Open Terminal Here', icon: 'p-term', click: () => openTerminal(cwd) },
      isPinned(cwd) ? { label: 'Unpin This Folder', icon: 'p-pin', click: () => unpin(cwd) }
        : { label: 'Pin This Folder', icon: 'p-pin', click: () => pin(cwd) }];
    openMenu([
      { label: 'View', sub: viewEntries() },
      { label: 'Arrange Icons By', sub: sortEntries() },
      { label: 'Refresh', click: () => navigate(cwd, { push: false, keep: true }) },
      ...here,
      ...(isPlace(cwd) || listError ? [] : [
        ...(cwdWritable ? ['sep' as const, { label: 'Paste', click: () => pasteInto(cwd) }, 'sep' as const, { label: 'New', sub: [
          { label: 'Folder', icon: 'p-newfolder', click: () => makeNew('folder') },
          { label: 'Text Document', icon: 'p-text', click: () => makeNew('text') }
        ] }] : []),
        'sep' as const, { label: 'Properties', icon: 'p-props', click: () => showProps() }])
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
  const groups: MenuEntry[][] = [[{ label: 'Open', bold: true, click: () => openSelected() }], [], []];
  if (picked.every(isFolder)) {
    groups[0].push({ label: 'Open in New Window', click: () => openSelected({ newWindow: true }) });
    groups[0].push({ label: 'Open in New Tab', click: () => openSelected({ newWindow: false, inTab: true }) });
    if (split && picked.length === 1) groups[0].push({ label: 'Open in Other Side', click: () => openInOther(it.alias && it.aliasDir ? it.alias : it.path) });
  }
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
    // With two panes, straight to the folder on the other side.
    if (split && !isPlace(split.other.cwd) && !split.other.listError) {
      groups.splice(3, 0, [
        { label: 'Copy to Other Side', key: 'F5', click: () => toOtherSide(false) },
        ...(fixed ? [] : [{ label: 'Move to Other Side', key: 'F6', click: () => toOtherSide(true) }])
      ]);
    }
    if (!fixed) {
      groups[3].push({ label: 'Make Alias', click: () => aliasSelected() });
      if (picked.length === 1) groups[3].push({ label: 'Rename', icon: 'p-rename', click: () => startRename(it.path) });
      groups[3].push({ label: 'Move to Trash', icon: 'p-trash', click: () => trashSelected() });
    }
  }
  groups.push([{ label: 'Properties', icon: 'p-props', click: () => showProps() }]);
  const entries = groups.filter((g) => g.length).flatMap((g, i): MenuItem[] => (i ? ['sep', ...g] : g));
  openMenu(entries, e.clientX, e.clientY);
});

// Back and Forward each have a list of where they go, under their arrow.
function historyMenu(which: string, anchorEl: HTMLElement) {
  const entries: number[] = [];
  if (which === 'back') for (let i = hIndex - 1; i >= 0 && entries.length < 12; i--) entries.push(i);
  else for (let i = hIndex + 1; i < hist.length && entries.length < 12; i++) entries.push(i);
  const r = anchorEl.getBoundingClientRect();
  (anchorEl.closest('.tb') as HTMLElement).classList.add('down'); // the arrow is in its button
  openMenu(entries.map((i) => ({ label: placeLabel(hist[i]), icon: specialIcon(hist[i]) || 'i-folder', click: () => goHistory(i) })), r.left, r.bottom + 2);
}

$('b-back').addEventListener('click', (e) => {
  const drop = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]');
  if (drop) historyMenu('back', drop);
  else back();
});
$('b-forward').addEventListener('click', (e) => {
  const drop = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]');
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
  const list: string[] = [];
  for (let p: string | null = cwd; p; p = parentOf(p)) list.push(p);
  const r = ($('b-places').closest('.addr') as HTMLElement).getBoundingClientRect(); // the arrow is in the address bar
  $('b-places').classList.add('down');
  const entry = (p: string) => ({ label: placeLabel(p), icon: specialIcon(p) || 'i-folder', checked: p === cwd, click: () => navigate(p) });
  const pinned = pins().filter((p) => !list.includes(p));
  openMenu([...list.map(entry), ...(pinned.length ? ['sep' as const, ...pinned.map(entry)] : [])], r.left, r.bottom + 2);
});

// ---------- address bar ----------

const path = $<HTMLInputElement>('path');
let suggestions: Completion[] = [];
let suggestOn = -1; // the row picked with the arrow keys, -1 for none
let completeTimer: number | null = null;

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
  const row = (e.target as HTMLElement).closest<Row>('.row');
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
  const field = (document.activeElement && document.activeElement.matches('input, textarea') ? document.activeElement : null) as HTMLInputElement | null;
  const typing = !!field;
  switch (command) {
    case 'newWindow': api.openWindow(cwd); break;
    case 'newTab': newTab(); break;
    case 'split': setSplit(!split); break;
    case 'closeTab': closeTab(); break;
    case 'nextTab': nextTab(1); break;
    case 'prevTab': nextTab(-1); break;
    // The Finder window's name, shown until its folder comes.
    case 'waitTitle': $('title').textContent = arg as string; break;
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
    // These come with their argument.
    case 'view': setView(arg as string); break;
    case 'sort': sortBy(arg as SortKey); break;
    case 'back': back(); break;
    case 'forward': forward(); break;
    case 'up': up(); break;
    case 'home': navigate(app.home); break;
    case 'computer': navigate(COMPUTER); break;
    case 'navigate': navigate(arg as string); break;
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
      if (field && field.matches('input')) deleteToStart(field as HTMLInputElement);
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
const LOOK_KEYS: (keyof Settings)[] = ['showExtensions', 'foldersFirst', 'fullPathTitle', 'showPane', 'terminalButton', 'hiddenButton', 'previews'];

function applyChrome() {
  const s = app.settings;
  document.body.classList.toggle('no-pane', !s.showPane);
  $('b-hidden').classList.toggle('on', !!s.showHidden);
  fitToolbar();
}

// ---------- a toolbar that fits the window ----------

// Buttons that don't fit move into the More button's menu, right most first.
const OVERFLOW = ['b-empty', 'b-hidden', 'b-term', 'b-split', 'b-folders', 'b-search'];
const OVERFLOW_ICONS: Record<string, string> = { 'b-empty': 'p-trash', 'b-hidden': 'p-hidden', 'b-term': 'p-term', 'b-split': 't-split', 'b-folders': 't-folders', 'b-search': 't-search' };
const overflowed = new Set();
// Not called toolbar, the name of the page's own window.toolbar.
const toolbarEl = document.querySelector('.toolbar') as HTMLElement; // always on the page

// Empty Trash is only on the toolbar in the Trash.
const buttonWanted = (id: string) => (id !== 'b-term' || app.settings.terminalButton) && (id !== 'b-hidden' || app.settings.hiddenButton) &&
  (id !== 'b-empty' || cwd === TRASH);

// A separator shows only between two visible buttons.
function syncSeps() {
  let seen = false;
  let last: HTMLElement | null = null;
  for (const el of toolbarEl.children as HTMLCollectionOf<HTMLElement>) {
    if (el.classList.contains('tbsep')) {
      el.hidden = !seen;
      if (seen) last = el;
      seen = false;
    } else if (!el.hidden) seen = true;
  }
  if (!seen && last) last.hidden = true;
}

function fitToolbar() {
  if (!app) return;
  overflowed.clear();
  for (const id of OVERFLOW) $(id).hidden = !buttonWanted(id);
  $('b-more').hidden = true;
  syncSeps();
  for (const id of OVERFLOW) {
    if (toolbarEl.scrollWidth <= toolbarEl.clientWidth) break;
    if (!buttonWanted(id)) continue;
    $(id).hidden = true;
    overflowed.add(id);
    $('b-more').hidden = false;
    syncSeps();
  }
  if ($('menu').classList.contains('open') && $('b-more').classList.contains('down')) closeMenu();
}

new ResizeObserver(fitToolbar).observe(toolbarEl);

$('b-more').addEventListener('mousedown', (e) => {
  e.preventDefault();
  if ($('menu').classList.contains('open') && $('b-more').classList.contains('down')) {
    closeMenu();
    return;
  }
  const entry = (id: string) => {
    const b = $(id);
    return { label: b.title, icon: OVERFLOW_ICONS[id], checked: b.classList.contains('on') || b.classList.contains('down'), click: () => b.click() };
  };
  const views = ['b-search', 'b-folders', 'b-split'].filter((id) => overflowed.has(id)).map(entry);
  const tools = ['b-term', 'b-hidden', 'b-empty'].filter((id) => overflowed.has(id)).map(entry);
  const r = $('b-more').getBoundingClientRect();
  openMenu([...views, ...(views.length && tools.length ? ['sep' as const] : []), ...tools], r.left, r.bottom + 2);
  $('b-more').classList.add('down');
});

function applyState(state: State) {
  const old = app;
  app = state;
  window.applyTheme(state);
  applyChrome();
  const sortChanged = (dir: string) => old && (['folderSorts', 'folderColumns'] as const).some((k) => JSON.stringify(old.settings[k][dir]) !== JSON.stringify(state.settings[k][dir]));
  // The other side lists again when what it shows changes.
  if (split && old && ((['showHidden', 'showExtensions', 'foldersFirst', 'theme'] as const).some((k) => old.settings[k] !== state.settings[k]) ||
    sortChanged(split.other.cwd))) refreshOther();
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
  } else if (sortChanged(cwd)) {
    items = sortItems(items);
    render();
    api.setView(look());
  } else if (old && JSON.stringify(old.settings.columnWidths) !== JSON.stringify(state.settings.columnWidths)) {
    const { scrollTop, scrollLeft } = $('files');
    render();
    Object.assign($('files'), { scrollTop, scrollLeft });
    if (split) drawOther();
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
  if (split && dir === split.other.cwd) refreshOther();
  if (dir !== cwd || searchOn()) return;
  if (renaming) {
    changedWhileRenaming = true; // redrawing now would throw away the name being typed
    return;
  }
  treeKids.delete(cwd);
  navigate(cwd, { push: false, keep: true, changed: true });
});
// Starts once every script on the page is in (edit.ts and search.ts come after this one).
window.addEventListener('DOMContentLoaded', () => {
  api.getState().then((state) => {
    applyState(state);
    const s = state.settings;
    view = s.newWindowView !== 'last' ? s.newWindowView : s.view;
    startTabs();
    COMPUTER = state.computer;
    TRASH = state.trash;
    RECENTS = state.recents;
    ICLOUD = state.icloud;
    setPane(state.settings.pane, { save: false });
    const params = new URLSearchParams(location.search);
    if (params.get('wait')) {
      // Two frames after the theme's stylesheet is in, its colors are on screen.
      const drawn = () => requestAnimationFrame(() => requestAnimationFrame(() => api.drawn()));
      if ($<HTMLLinkElement>('theme-css').sheet) drawn();
      else $('theme-css').addEventListener('load', drawn, { once: true });
      // Opened in the spot of a Finder window, before its folder was known.
      api.waitFolder().then((dir) => {
        if (!dir) return;
        cwd = dir;
        hist = [dir];
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
const isPinned = (p: string) => pins().includes(p);

function pin(p: string) {
  if (!p || isPlace(p) || isPinned(p)) return;
  api.updateSettings({ pins: [...pins(), p] });
}

function unpin(p: string) {
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
$('b-hidden').addEventListener('click', () => api.updateSettings({ showHidden: !app.settings.showHidden }));
$('b-empty').addEventListener('click', () => {
  if (!$('b-empty').classList.contains('off')) api.emptyTrash();
});

// ---------- the left pane: Pinned, Other Places and Details ----------

const collapsed = new Set<string>(); // boxes folded shut in this window

// Other Places, less the ones switched off on the Folder Options page.
const PLACES = () => ([
  [RECENTS, 'Recents', 'recents'], [app.home, 'Home', 'home'], [app.home + '/Desktop', 'Desktop', 'desktop'],
  [app.home + '/Documents', 'Documents', 'documents'], [app.home + '/Downloads', 'Downloads', 'downloads'],
  ['/Applications', 'Applications', 'applications'], [ICLOUD, 'iCloud Drive', 'icloud'], [COMPUTER, 'Computer', 'computer'],
  [TRASH, 'Trash', 'trash']
] as [string, string, PlaceKey][]).filter(([p, , key]) => app.settings.places[key] !== false && (p !== ICLOUD || app.icloudOn));

function box(id: string, title: string, body: string, first = false) {
  if (!body) return '';
  return `<div class="box${first ? ' first' : ''}${collapsed.has(id) ? ' shut' : ''}" data-box="${id}">` +
    `<h3><span>${esc(title)}</span><span class="chev"><svg><use href="#t-chev-up"/></svg></span></h3>` +
    `<div class="bd">${body}</div></div>`;
}

function selectedItems() {
  return items.filter((it) => sel.has(it.path));
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

let countFor: string | null = null; // the folder whose count the Details box is waiting on

function detailsBox() {
  const picked = selectedItems();
  const one = picked.length === 1 ? picked[0] : null;
  const line = (t: string) => `<span class="d">${t}</span><br>`;
  let html: string;
  countFor = null;
  if (!picked.length) {
    html = `<b>${esc(placeLabel(cwd))}</b>` + line(isPlace(cwd) ? `${items.length} item${items.length === 1 ? '' : 's'}` : isVolumeRoot(cwd) ? 'Volume' : 'Folder') +
      (folderModified ? line(`Modified: ${fmtDate(folderModified)}`) : '');
  } else if (one) {
    html = `<b>${esc(one.display)}</b>` + line(esc(one.kind));
    if (one.volume && one.free != null) html += line(`Free space: ${fmtBytes(one.free)}`) + (one.total != null ? line(`Total size: ${fmtBytes(one.total)}`) : '');
    else if (isFolder(one)) {
      html += '<span class="d" id="det-count"></span>';
      countFor = one.path;
    } else if (one.size != null) html += line(`Size: ${fmtBytes(one.size)}`);
    if (!one.volume) html += line(`Modified: ${fmtDate(one.modified)}`);
  } else {
    const files = picked.filter((it) => it.size != null);
    html = `<b>${picked.length} items selected.</b>` + (files.length ? '<br>' + line(`Total size: ${fmtBytes(files.reduce((n, it) => n + (it.size as number), 0))}`) : '');
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

// Only a box whose markup changed is redrawn, so a click that changes
// Details doesn't make Pinned and Other Places blink.
const paneDrawn: Record<string, string> = {}; // box id -> the markup it was last drawn from
function renderPane() {
  if (pane !== 'tasks' || !app) return;
  const el = $('pane');
  let after: Element | null = null;
  for (const [id, html] of [['pinned', pinnedBox()], ['places', placesBox()], ['details', detailsBox()]]) {
    let node = el.querySelector(`[data-box="${id}"]`);
    if (!node || paneDrawn[id] !== html) {
      if (node) node.remove();
      node = null;
      if (html) {
        const t = document.createElement('template');
        t.innerHTML = html;
        node = t.content.firstElementChild;
        el.insertBefore(node as Element, after ? after.nextSibling : el.firstChild); // the markup is one element
      }
      paneDrawn[id] = html;
    }
    if (node) after = node;
  }
  loadCount();
}

$('pane').addEventListener('click', (e) => {
  const h = (e.target as HTMLElement).closest('h3');
  if (h) {
    const b = h.closest('.box') as Data<'box'>; // every heading is in a box
    if (collapsed.has(b.dataset.box)) collapsed.delete(b.dataset.box);
    else collapsed.add(b.dataset.box);
    b.classList.toggle('shut');
    return;
  }
  const x = (e.target as HTMLElement).closest<Data<'unpin', `${number}`>>('[data-unpin]');
  if (x) {
    unpin(pins()[x.dataset.unpin]);
    return;
  }
  const place = (e.target as HTMLElement).closest<Data<'place'>>('[data-place]');
  if (place) {
    navigate(place.dataset.place);
    return;
  }
});

// Pinning by dropping a folder on the Pinned box (not on a pin, which moves
// it into that folder, see edit.ts), and putting the pins in order by
// dragging them.
const PIN_TYPE = 'application/x-filedrawer-pin';
let dragPin: number | null = null; // the pin being moved

$('pane').addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<Data<'pin'>>('[data-pin]');
  if (!row) return;
  dragPin = Number(row.dataset.pin);
  // A drag event always has its dataTransfer.
  e.dataTransfer!.setData(PIN_TYPE, String(dragPin));
  e.dataTransfer!.effectAllowed = 'move';
});
$('pane').addEventListener('dragend', () => {
  dragPin = null;
  clearDropMarks();
});

function clearDropMarks() {
  document.querySelectorAll('.drop-on, .drop-before').forEach((el) => el.classList.remove('drop-on', 'drop-before'));
}

// The Pinned box itself, for a pin being moved or a folder dropped off a pin.
function pinnedTarget(e: DragEvent) {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-box="pinned"]');
  if (!b) return null;
  const row = (e.target as HTMLElement).closest<Data<'pin'>>('[data-pin]');
  if (dragPin === null && row) return null;
  return { box: b, row };
}

$('pane').addEventListener('dragover', (e) => {
  const t = pinnedTarget(e);
  if (!t) return;
  if (dragPin === null && ![...e.dataTransfer!.types].includes('Files')) return;
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
  const dropped = [...e.dataTransfer!.files].map((f) => api.pathForFile(f)).filter(Boolean);
  const paths: string[] = [];
  for (const p of dropped) {
    const res = await api.resolve(p, cwd);
    if (res.type === 'dir') paths.push(res.path);
  }
  const fresh = paths.filter((p) => !isPinned(p));
  if (fresh.length) api.updateSettings({ pins: [...pins(), ...fresh] });
});

// ---------- the left pane: the Folders tree ----------

const treeKids = new Map<string, TreeNode[] | null>(); // path -> child folders, once listed
const treeOpen = new Set<string>(); // paths shown open
let treeShownFor: string | null = null; // the folder the tree last opened its way down to

function treeRoots(): TreeRow[] {
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

async function loadKids(p: string) {
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
function chainTo(p: string) {
  const chain: string[] = [];
  if (p === app.home || p.startsWith(app.home + '/')) {
    for (let q = p; ; q = dirname(q)) {
      chain.unshift(q);
      if (q === app.home) break;
    }
  } else {
    for (let q: string | null = p; q; q = parentOf(q)) chain.unshift(q);
  }
  return chain;
}

// A hidden folder shows when hidden files are on, or when it's on the way to the open folder.
function shownKids(p: string) {
  const kids = treeKids.get(p);
  if (!kids || app.settings.showHidden) return kids;
  const chain = chainTo(cwd);
  return kids.filter((k) => !k.hidden || chain.includes(k.path));
}

function nodeHtml(n: TreeRow, depth: number): string {
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
  const n = (e.target as HTMLElement).closest<Data<'path'>>('.n');
  if (!n) return;
  const p = n.dataset.path;
  if ((e.target as HTMLElement).closest('.tw')) {
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

function setPane(p: string, { save = true, quiet = false }: { save?: boolean; quiet?: boolean } = {}) {
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
  api.setView(look());
  if (save) api.updateSettings({ pane });
  treeShownFor = null;
  renderPane();
  renderTree();
  fitList();
}
