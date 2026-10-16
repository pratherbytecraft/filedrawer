// Working with the files in a window: renaming in place, new folders and
// text documents, selecting with a box, and typing to jump to a name.
// Loaded after window.js and shares its state (items, sel, cwd and so on).

// ---------- renaming in place ----------

let renaming = null; // { path, input, hiddenExt } while a name is being edited
let changedWhileRenaming = false; // the folder changed meanwhile, refresh after

// The part of a name the Mac doesn't show, like ".app", kept on rename.
function hiddenExt(it) {
  return it.name !== it.display && it.name.startsWith(it.display) ? it.name.slice(it.display.length) : '';
}

function itemEl(p) {
  const i = items.findIndex((it) => it.path === p);
  return i >= 0 ? $('files').querySelector(`.item[data-i="${i}"]`) : null;
}

// text, when given, is what the user typed last time (after a name was turned down).
function startRename(p, text) {
  if (renaming || cwd === COMPUTER) return;
  const it = items.find((x) => x.path === p);
  const el = itemEl(p);
  const nm = el && el.querySelector('.nm');
  if (!it || !nm || it.volume) return;
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

async function endRename(keep) {
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
  const res = await api.rename(from, typed + ext);
  if (res.error) {
    startRename(from, typed);
    return;
  }
  changedWhileRenaming = false;
  await navigate(cwd, { push: false, select: res.path });
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
let slowClick = null;
$('files').addEventListener('mousedown', (e) => {
  clearTimeout(slowClick);
  slowClick = null;
  const el = e.target.closest('.item');
  const onName = e.target.closest('.nm');
  if (!el || !onName || e.button !== 0 || e.metaKey || e.shiftKey) return;
  const p = items[el.dataset.i].path;
  if (sel.size === 1 && sel.has(p)) {
    const x = e.clientX;
    const y = e.clientY;
    const startedAt = Date.now();
    const up = (u) => {
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

function trashSelected() {
  if (cwd === COMPUTER) return;
  const picked = selectedItems().filter((it) => !it.volume);
  if (!picked.length) return;
  sel.clear();
  api.trash(picked.map((it) => it.path));
}

// Undo and Redo undo typing while a name or the address bar is being
// edited, and what was done to files otherwise.
function undoOrRedo(which) {
  const field = document.activeElement;
  if (field && field.matches('input')) document.execCommand(which);
  else api.undo(which);
}

// The menu's Command Delete reaches a field being typed in as the Mac's
// delete-to-the-start, since the menu catches the key first.
function deleteToStart(input) {
  const end = input.selectionEnd;
  const start = input.selectionStart === end ? 0 : input.selectionStart;
  input.setRangeText('', start, end, 'start');
  input.dispatchEvent(new Event('input'));
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.key !== 'Delete') return;
  e.preventDefault();
  trashSelected();
});

// ---------- Cut, Copy and Paste ----------

// Text being typed gets the text commands; otherwise they work on files.
function clipCommand(which) {
  const field = document.activeElement;
  if (field && field.matches('input')) {
    api.editText(which);
    return;
  }
  if (which === 'paste') {
    pasteInto(cwd);
    return;
  }
  const paths = selectedItems().filter((it) => !it.volume).map((it) => it.path);
  if (!paths.length) return;
  if (which === 'cut') api.cutFiles(paths);
  else api.copyFiles(paths);
}

async function pasteInto(dir) {
  if (dir === COMPUTER || (dir === cwd && listError)) return;
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
  const el = e.target.closest('.item');
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

// Where a drop lands: a folder in the list, the tree or the pane, the
// Trash in Other Places, or the open folder.
function dropTarget(e) {
  const item = e.target.closest('#files .item');
  if (item) {
    const it = items[item.dataset.i];
    if (isFolder(it)) return { dir: it.path, el: item };
  }
  if (e.target.closest('#files')) return cwd === COMPUTER || listError ? null : { dir: cwd, el: null };
  const node = e.target.closest('#tree-list .n');
  if (node) {
    const p = node.dataset.path;
    if (p === COMPUTER) return null;
    return p === 'trash' ? { trash: true, el: node } : { dir: p, el: node };
  }
  const place = e.target.closest('#pane [data-place]');
  if (place) {
    const p = place.dataset.place;
    if (p === COMPUTER) return null;
    return p === 'trash' ? { trash: true, el: place } : { dir: p, el: place };
  }
  return null;
}

document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || ![...e.dataTransfer.types].includes('Files')) return;
  const t = dropTarget(e);
  clearDropMarks();
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
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
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  if (t.trash) {
    api.trash(paths);
    return;
  }
  // A folder dropped on itself stays where it is.
  if (paths.includes(t.dir)) return;
  const res = await api.drop(paths, t.dir, e.altKey);
  if (t.dir === cwd && res.paths.length) await navigate(cwd, { push: false, selectMany: res.paths });
});

// ---------- new folders and text documents ----------

async function makeNew(kind) {
  if (cwd === COMPUTER || listError) return;
  const res = kind === 'folder' ? await api.newFolder(cwd) : await api.newText(cwd);
  if (res.error) return;
  await navigate(cwd, { push: false, select: res.path });
  startRename(res.path);
}

// ---------- selecting with a box ----------

let band = null; // { x, y, base, el } while a box is being drawn, in the list's own coordinates

$('files').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.item, th, .note')) return;
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
  const hits = new Set();
  for (const el of rows()) {
    const target = el.querySelector('.cell') || el; // in Details, the name and icon
    const q = target.getBoundingClientRect();
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
let typedTimer = null;

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
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
