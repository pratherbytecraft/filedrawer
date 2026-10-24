// Working with the files in a window: renaming in place, new folders and
// text documents, selecting with a box, and typing to jump to a name.
// Loaded after window.ts and shares its state (items, sel, cwd and so on).

// ---------- renaming in place ----------

let renaming: { path: string; input: HTMLInputElement; hiddenExt: string; nm: Element } | null = null; // { path, input, hiddenExt } while a name is being edited
let changedWhileRenaming = false; // the folder changed meanwhile, refresh after

// The part of a name the Mac doesn't show, like ".app", kept on rename.
function hiddenExt(it: Item) {
  return it.name !== it.display && it.name.startsWith(it.display) ? it.name.slice(it.display.length) : '';
}

function itemEl(p: string) {
  const i = items.findIndex((it) => it.path === p);
  return i >= 0 ? $('files').querySelector(`.item[data-i="${i}"]`) : null;
}

// text, when given, is what the user typed last time (after a name was turned down).
function startRename(p: string, text?: string) {
  if (renaming || cwd === COMPUTER || cwd === TRASH) return;
  const it = items.find((x) => x.path === p);
  const el = itemEl(p);
  const nm = el && el.querySelector('.nm');
  if (!it || !nm || it.volume || it.fixed) return;
  scrollToItem(p);
  const input = document.createElement('input');
  input.className = 'ren';
  input.spellcheck = false;
  input.value = text !== undefined ? text : it.display;
  nm.replaceWith(input);
  renaming = { path: p, input, hiddenExt: hiddenExt(it), nm };
  fitRename();
  input.focus();
  // The name without its extension is picked, so typing keeps the extension.
  const dot = input.value.lastIndexOf('.');
  if (!isFolder(it) && dot > 0 && text === undefined) input.setSelectionRange(0, dot);
  else input.select();
  input.addEventListener('input', fitRename);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      endRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endRename(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      endRename(true);
    }
  });
  input.addEventListener('blur', () => endRename(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// The box grows with the name.
function fitRename() {
  if (!renaming) return;
  const { input } = renaming;
  input.style.width = '0px';
  input.style.width = Math.max(40, input.scrollWidth + 8) + 'px';
}

async function endRename(keep: boolean) {
  if (!renaming) return;
  const { path: from, input, hiddenExt: ext, nm } = renaming;
  renaming = null;
  const typed = input.value.trim();
  const it = items.find((x) => x.path === from);
  if (input.isConnected) input.replaceWith(nm);
  $('files').focus();
  if (!keep || !it || typed === it.display) {
    if (changedWhileRenaming) refreshAfterChange();
    return;
  }
  const name = await withExtension(it, typed);
  const res = await api.rename(from, name + ext);
  if (res.error) {
    startRename(from, typed);
    return;
  }
  changedWhileRenaming = false;
  // In search results the item is renamed where it stands.
  if (searchOn()) {
    // A rename that worked always answers with the new path.
    Object.assign(it, { path: res.path, name: typed + ext, display: typed });
    sel = new Set([res.path as string]);
    anchor = cursor = res.path as string;
    render();
    return;
  }
  await navigate(cwd, { push: false, select: res.path });
}

// Changing or taking off a file's extension asks first, as Finder does,
// since the file may then open in another app. Keep puts the old one back.
async function withExtension(it: Item, typed: string) {
  if (isFolder(it) || it.package || hiddenExt(it)) return typed;
  const extOf = (n: string) => {
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i + 1) : '';
  };
  const was = extOf(it.display);
  const now = extOf(typed);
  if (!was || was.toLowerCase() === now.toLowerCase()) return typed;
  if (!(await api.askExtension(was, now))) return typed;
  return (now ? typed.slice(0, -(now.length + 1)) : typed) + '.' + was;
}

function refreshAfterChange() {
  changedWhileRenaming = false;
  navigate(cwd, { push: false, keep: true, changed: true });
}

function renameSelected() {
  const picked = selectedItems();
  if (picked.length === 1) startRename(picked[0].path);
}

// A click on the name of the one selected item, held still for a moment
// and not followed by a second click, starts a rename.
let slowClick: number | null = null;
$('files').addEventListener('mousedown', (e) => {
  clearTimeout(slowClick);
  slowClick = null;
  const el = (e.target as HTMLElement).closest<Row>('.item');
  const onName = (e.target as HTMLElement).closest('.nm');
  if (!el || !onName || e.button !== 0 || e.metaKey || e.shiftKey || app.settings.clickToOpen === 'single') return;
  const p = items[el.dataset.i].path;
  if (sel.size === 1 && sel.has(p)) {
    const x = e.clientX;
    const y = e.clientY;
    const startedAt = Date.now();
    const up = (u: MouseEvent) => {
      document.removeEventListener('mouseup', up, true);
      if (Math.abs(u.clientX - x) > 3 || Math.abs(u.clientY - y) > 3 || Date.now() - startedAt > 1000) return;
      slowClick = setTimeout(() => {
        slowClick = null;
        if (sel.size === 1 && sel.has(p)) startRename(p);
      }, 550);
    };
    document.addEventListener('mouseup', up, true);
  }
}, true);
$('files').addEventListener('dblclick', () => {
  clearTimeout(slowClick);
  slowClick = null;
}, true);

// ---------- the Trash and Undo ----------

async function trashSelected() {
  if (cwd === COMPUTER) return;
  // In the Trash, Command Delete deletes for good, after asking.
  if (cwd === TRASH) {
    const paths = selectedItems().map((it) => it.path);
    if (paths.length) api.deleteNow(paths);
    return;
  }
  const picked = selectedItems().filter((it) => !it.volume);
  if (!picked.length || picked.some((it) => it.fixed)) return;
  sel.clear();
  const res = await api.trash(picked.map((it) => it.path));
  // Search results don't follow the disk, so trashed ones are taken out here.
  if (searchOn() && res && res.items) {
    const gone = new Set(res.items.map((t) => t.from));
    items = items.filter((it) => !gone.has(it.path));
    render();
  }
}

// Undo and Redo undo typing while a name or the address bar is being
// edited, and what was done to files otherwise.
function undoOrRedo(which: UndoWhich) {
  const field = document.activeElement;
  if (field && field.matches('input')) document.execCommand(which);
  else api.undo(which);
}

// The menu's Command Delete reaches a field being typed in as the Mac's
// delete-to-the-start, since the menu catches the key first.
function deleteToStart(input: HTMLInputElement) {
  // A text field always has a selection.
  const end = input.selectionEnd as number;
  const start = input.selectionStart === end ? 0 : input.selectionStart as number;
  input.setRangeText('', start, end, 'start');
  input.dispatchEvent(new Event('input'));
}

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea') || e.key !== 'Delete') return;
  e.preventDefault();
  trashSelected();
});

// ---------- Duplicate, Make Alias and Copy Path ----------

// The selected items that are files or folders, not disks, when they can be changed.
function workItems() {
  const picked = cwd === COMPUTER ? [] : selectedItems().filter((it) => !it.volume);
  return picked.some((it) => it.fixed) ? [] : picked;
}

async function duplicateSelected() {
  const picked = workItems();
  if (!picked.length) return;
  const res = await api.duplicate(picked.map((it) => it.path));
  if (!searchOn() && res.paths.length) await navigate(cwd, { push: false, selectMany: res.paths });
}

async function aliasSelected() {
  const picked = workItems();
  if (!picked.length) return;
  const res = await api.makeAlias(picked.map((it) => it.path));
  if (!searchOn() && res.paths.length) await navigate(cwd, { push: false, selectMany: res.paths });
}

// The selection's paths, or the open folder's when nothing is selected.
function copyPaths() {
  const picked = selectedItems().map((it) => it.path);
  if (picked.length) api.copyPath(picked);
  else if (!isPlace(cwd)) api.copyPath([cwd]);
}

// ---------- Cut, Copy and Paste ----------

// Text being typed gets the text commands; otherwise they work on files.
function clipCommand(which: EditCommand) {
  const field = document.activeElement;
  if (field && field.matches('input')) {
    api.editText(which);
    return;
  }
  if (which === 'paste') {
    pasteInto(cwd);
    return;
  }
  const picked = selectedItems().filter((it) => !it.volume);
  if (!picked.length || (which === 'cut' && picked.some((it) => it.fixed))) return;
  const paths = picked.map((it) => it.path);
  if (which === 'cut') api.cutFiles(paths);
  else api.copyFiles(paths);
}

async function pasteInto(dir: string) {
  if (isPlace(dir) || (dir === cwd && (listError || !cwdWritable))) return;
  const res = await api.paste(dir);
  if (dir === cwd && res.paths.length) await navigate(cwd, { push: false, selectMany: res.paths });
}

// Cut items look faded until they're pasted somewhere.
function showCut() {
  const cutSet = new Set(app.cut || []);
  for (const el of rows()) el.classList.toggle('cut', cutSet.has(items[el.dataset.i].path));
}

// ---------- drag and drop ----------

// Items leave with the Mac's own drag, so Finder, other apps and other
// Filedrawer windows all take them the same way.
$('files').addEventListener('dragstart', (e) => {
  const el = (e.target as HTMLElement).closest<Row>('.item');
  if (!el) return;
  e.preventDefault();
  if (renaming) return;
  const it = items[el.dataset.i];
  if (!sel.has(it.path)) {
    sel = new Set([it.path]);
    anchor = cursor = it.path;
    showSelection();
  }
  const paths = selectedItems().filter((x) => !x.volume).map((x) => x.path);
  if (paths.length) api.startDrag(paths);
});

// A folder or the Trash, and the element marked while a drag is over it.
type DropTarget = { dir: string; trash?: undefined; el: HTMLElement | null } | { trash: true; dir?: undefined; el: HTMLElement | null };

// Where a drop lands: a folder in the list, the tree or the pane, the
// Trash in Other Places, or the open folder.
function dropTarget(e: DragEvent): DropTarget | null {
  const item = (e.target as HTMLElement).closest<Row>('#files .item');
  if (item) {
    const it = items[item.dataset.i];
    if (isFolder(it)) return { dir: it.path, el: item };
  }
  if ((e.target as HTMLElement).closest('#files-other')) return otherDropTarget(e);
  if ((e.target as HTMLElement).closest('#files')) {
    if (cwd === TRASH && !listError) return { trash: true, el: null };
    return isPlace(cwd) || listError ? null : { dir: cwd, el: null };
  }
  const node = (e.target as HTMLElement).closest<Data<'path'>>('#tree-list .n');
  if (node) {
    const p = node.dataset.path;
    if (p === TRASH) return { trash: true, el: node };
    return isPlace(p) ? null : { dir: p, el: node };
  }
  const place = (e.target as HTMLElement).closest<Data<'place'>>('#pane [data-place]');
  if (place) {
    const p = place.dataset.place;
    if (p === TRASH) return { trash: true, el: place };
    return isPlace(p) ? null : { dir: p, el: place };
  }
  return null;
}

// Whether a drop copies: with Option held, or when another app's drag only
// offers a copy, the way Photos does (asking to move such a drag cancels
// it). Filedrawer's own drags move, though the Mac reports them as copy only.
let ownDrag = false;
api.onDragOwn((own) => { ownDrag = own; });
function dropCopies(e: DragEvent) {
  if (e.altKey) return true;
  if (ownDrag) return false;
  // A drag event always has its dataTransfer.
  const allowed = e.dataTransfer!.effectAllowed;
  return !(allowed === 'all' || allowed === 'uninitialized' || /move/i.test(allowed));
}

document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || ![...e.dataTransfer!.types].includes('Files')) return;
  const t = dropTarget(e);
  clearDropMarks();
  if (!t) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = dropCopies(e) ? 'copy' : 'move';
  if (t.el) t.el.classList.add('drop-on');
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) clearDropMarks();
});

document.addEventListener('drop', async (e) => {
  if (e.defaultPrevented) return;
  const t = dropTarget(e);
  clearDropMarks();
  if (!t) return;
  e.preventDefault();
  const paths = [...e.dataTransfer!.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  if (t.trash) {
    api.trash(paths);
    return;
  }
  // A folder dropped on itself stays where it is.
  if (paths.includes(t.dir)) return;
  const res = await api.drop(paths, t.dir, dropCopies(e));
  if (t.dir === cwd && res.paths.length) await navigate(cwd, { push: false, selectMany: res.paths });
});

// ---------- Properties, Open With and Quick Look ----------

// Properties of the selection, or of the open folder when nothing is selected.
function showProps() {
  const picked = selectedItems().map((it) => it.path);
  if (picked.length) api.showProps(picked);
  else if (!isPlace(cwd)) api.showProps([cwd]);
}

// Space shows the selected file in Quick Look. Once the preview is up it
// takes the keys itself, and Space closes it again.
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || typed || (e.target as HTMLElement).closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const it = selectedItems()[0];
  if (!it) return;
  e.preventDefault();
  api.quickLook(it.path);
});

// The apps that can open the right clicked file, with its usual app first,
// and Choose App... for the app list, which can also change the default.
async function openWithEntries(paths: string[]): Promise<MenuItem[]> {
  const apps = await api.openWithApps(paths[0]);
  // true counts as 1.
  const sorted = apps.slice().sort((a, b) => ((b.default as unknown as number) - (a.default as unknown as number)) || a.name.localeCompare(b.name));
  const rows = sorted.map((a) => ({ label: a.default ? `${a.name} (default)` : a.name, click: () => api.openWith(a.path, paths) }));
  return [...rows, ...(rows.length ? ['sep' as const] : []), { label: 'Choose App...', click: () => api.chooseApp(paths) }];
}

// ---------- Send To and Eject ----------

function sendToEntries(paths: string[]): MenuItem[] {
  const dir = cwd;
  const pinned = pins().filter((p) => p !== dir && !paths.includes(p));
  return [
    { label: 'Compressed (zipped) Folder', icon: 'i-zip', click: async () => {
      const res = await api.sendToZip(paths);
      if (res.path && dir === cwd) await navigate(cwd, { push: false, select: res.path });
    } },
    { label: 'Desktop (create alias)', icon: 'p-desktop', click: () => api.sendToDesktop(paths) },
    { label: 'Mail Recipient', icon: 'p-mail', click: () => api.sendToMail(paths) },
    ...(pinned.length ? ['sep' as const, ...pinned.map((p) => ({ label: placeLabel(p), icon: specialIcon(p) || 'i-folder', click: () => api.sendToFolder(paths, p) }))] : [])
  ];
}

const ejectable = (p: string) => /^\/Volumes\/[^/]+$/.test(p);

async function eject(volume: string) {
  const res = await api.eject(volume);
  if (!res.error && cwd === COMPUTER) navigate(cwd, { push: false, keep: true });
}

// A place in Other Places or Pinned: open it here or in a new window, and
// for the Trash, empty it, for a pin, unpin it.
function placeEntries(p: string) {
  const entries: MenuItem[] = [{ label: 'Open', bold: true, click: () => navigate(p) }, { label: 'Open in New Window', click: () => api.openWindow(p) },
    { label: 'Open in New Tab', click: () => newTab(p) }];
  if (split) entries.push({ label: 'Open in Other Side', click: () => openInOther(p) });
  if (!isPlace(p)) entries.push({ label: 'Open Terminal Here', icon: 'p-term', click: () => openTerminal(p) });
  if (p === TRASH) entries.push('sep', { label: 'Empty Trash...', icon: 'p-trash', click: () => api.emptyTrash() });
  if (isPinned(p)) entries.push('sep', { label: 'Unpin', icon: 'p-pin', click: () => unpin(p) });
  return entries;
}

$('pane').addEventListener('contextmenu', (e) => {
  const place = (e.target as HTMLElement).closest<Data<'place'>>('[data-place]');
  if (!place) return;
  e.preventDefault();
  openMenu(placeEntries(place.dataset.place), e.clientX, e.clientY);
});

// Put Back, for the selection or the given paths, and the Trash is shown again.
async function putBackSelected(paths = selectedItems().map((it) => it.path)) {
  if (!paths.length) return;
  await api.putBack(paths);
  navigate(cwd, { push: false, keep: true, changed: true });
}

// The Folders tree's own right click menu.
$('tree-list').addEventListener('contextmenu', (e) => {
  const n = (e.target as HTMLElement).closest<Data<'path'>>('.n');
  if (!n) return;
  e.preventDefault();
  const p = n.dataset.path;
  if (isPlace(p) && p !== COMPUTER) {
    openMenu(placeEntries(p), e.clientX, e.clientY);
    return;
  }
  const entries: MenuItem[] = [{ label: 'Open', bold: true, click: () => navigate(p) }, { label: 'Open in New Window', click: () => api.openWindow(p) },
    { label: 'Open in New Tab', click: () => newTab(p) }];
  if (p !== COMPUTER) entries.push({ label: 'Open Terminal Here', icon: 'p-term', click: () => openTerminal(p) });
  if (ejectable(p)) entries.push('sep', { label: 'Eject', icon: 'p-eject', click: () => eject(p) });
  else if (p !== COMPUTER && !isVolumeRoot(p)) {
    entries.push('sep', isPinned(p) ? { label: 'Unpin', icon: 'p-pin', click: () => unpin(p) } : { label: 'Pin to Pinned', icon: 'p-pin', click: () => pin(p) });
  }
  openMenu(entries, e.clientX, e.clientY);
});

// ---------- new folders and text documents ----------

async function makeNew(kind: string) {
  if (isPlace(cwd) || listError || !cwdWritable) return;
  const res = kind === 'folder' ? await api.newFolder(cwd) : await api.newText(cwd);
  if (res.error) return;
  await navigate(cwd, { push: false, select: res.path });
  startRename(res.path as string); // made, so it has a path
}

// ---------- selecting with a box ----------

interface Band {
  x: number;
  y: number;
  base: Set<string>;
  toggle: boolean;
  el: HTMLDivElement;
  mx: number;
  my: number;
  frame: number | null;
  scroll: number | null;
}

let band: Band | null = null; // { x, y, base, el } while a box is being drawn, in the list's own coordinates

$('files').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.item, th, .note')) return;
  const f = $('files');
  const r = f.getBoundingClientRect();
  if (e.clientX > r.left + f.clientWidth || e.clientY > r.top + f.clientHeight) return; // on a scroll bar
  const el = document.createElement('div');
  el.className = 'band';
  f.appendChild(el);
  band = {
    x: e.clientX - r.left + f.scrollLeft,
    y: e.clientY - r.top + f.scrollTop,
    base: e.metaKey || e.shiftKey ? new Set(sel) : new Set(),
    toggle: e.metaKey,
    el,
    mx: e.clientX,
    my: e.clientY,
    frame: null,
    scroll: null
  };
  e.preventDefault(); // no text selection while drawing
  f.focus();
});

function drawBand() {
  if (!band) return;
  band.frame = null;
  const f = $('files');
  const r = f.getBoundingClientRect();
  const x2 = band.mx - r.left + f.scrollLeft;
  const y2 = band.my - r.top + f.scrollTop;
  const left = Math.min(band.x, x2);
  const top = Math.min(band.y, y2);
  const w = Math.abs(x2 - band.x);
  const h = Math.abs(y2 - band.y);
  Object.assign(band.el.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
  // Items under the box, compared on the screen.
  const box = { l: left - f.scrollLeft + r.left, t: top - f.scrollTop + r.top, r: left + w - f.scrollLeft + r.left, b: top + h - f.scrollTop + r.top };
  const hits = new Set<string>();
  for (const el of rows()) {
    const q = el.getBoundingClientRect(); // in Details, the whole row counts
    if (q.right >= box.l && q.left <= box.r && q.bottom >= box.t && q.top <= box.b) hits.add(items[el.dataset.i].path);
  }
  const next = new Set(band.base);
  for (const p of hits) {
    if (band.toggle && band.base.has(p)) next.delete(p);
    else next.add(p);
  }
  if (next.size !== sel.size || [...next].some((p) => !sel.has(p))) {
    sel = next;
    for (const el of rows()) el.classList.toggle('sel', sel.has(items[el.dataset.i].path));
    renderStatus();
  }
}

// Near the top or bottom edge the list scrolls along.
function bandScroll() {
  if (!band) return;
  const f = $('files');
  const r = f.getBoundingClientRect();
  const edge = 24;
  let dy = 0;
  if (band.my < r.top + edge) dy = -Math.ceil((r.top + edge - band.my) / 2);
  else if (band.my > r.bottom - edge) dy = Math.ceil((band.my - (r.bottom - edge)) / 2);
  if (dy) {
    f.scrollTop += dy;
    drawBand();
  }
  band.scroll = requestAnimationFrame(bandScroll);
}

document.addEventListener('mousemove', (e) => {
  if (!band) return;
  band.mx = e.clientX;
  band.my = e.clientY;
  if (!band.scroll) band.scroll = requestAnimationFrame(bandScroll);
  if (!band.frame) band.frame = requestAnimationFrame(drawBand);
});

document.addEventListener('mouseup', () => {
  if (!band) return;
  cancelAnimationFrame(band.scroll);
  cancelAnimationFrame(band.frame);
  drawBand();
  band.el.remove();
  band = null;
  const last = items.filter((it) => sel.has(it.path)).pop();
  anchor = cursor = last ? last.path : null;
  renderPane();
});

// ---------- typing to jump to a name ----------

let typed = '';
let typedTimer: number | null = null;

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('menu').classList.contains('open') || e.key.length !== 1) return;
  if (e.key === ' ' && !typed) return; // Space alone is for Quick Look
  e.preventDefault();
  clearTimeout(typedTimer);
  typedTimer = setTimeout(() => {
    typed = '';
  }, 1000);
  typed += e.key.toLowerCase();
  // The same letter again goes on to the next name starting with it.
  const same = [...typed].every((c) => c === typed[0]);
  const want = same ? typed[0] : typed;
  const start = items.findIndex((it) => it.path === cursor);
  const order = items.slice(start + (same ? 1 : 0)).concat(items.slice(0, start + (same ? 1 : 0)));
  const hit = order.find((it) => it.display.toLowerCase().startsWith(want));
  if (!hit) return;
  sel = new Set([hit.path]);
  anchor = cursor = hit.path;
  showSelection();
  scrollToItem(hit.path);
});
