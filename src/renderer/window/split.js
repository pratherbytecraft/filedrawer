// Two panes: the file list splits into two sides, each with its own folder,
// history, view and selection. The side in use is the live one (window.js's
// state, drawn in #files); the other side is kept here and drawn in
// #files-other, and the two swap when the other side is clicked. The
// toolbar, address bar, left pane and status bar follow the side in use.
// Loaded after window.js, edit.js, search.js and tabs.js.

const SIDE_KEYS = ['cwd', 'history', 'hIndex', 'items', 'sel', 'anchor', 'cursor', 'view', 'listError', 'folderModified', 'cwdWritable', 'volumeName'];

// The live side's state, to put away.
function takeSide() {
  return {
    cwd, history: history.slice(), hIndex, items, sel: new Set(sel), anchor, cursor, view, listError,
    folderModified, cwdWritable, volumeName, scroll: $('files').scrollTop
  };
}

function putSide(s) {
  ({ cwd, hIndex, items, anchor, cursor, view, listError, folderModified, cwdWritable, volumeName } = s);
  history = s.history.slice();
  sel = new Set(s.sel);
}

// Runs fn with the other side's state as the live one, for drawing it.
function asOther(fn) {
  const mine = takeSide();
  putSide(split.other);
  try {
    return fn();
  } finally {
    putSide(mine);
  }
}

const sideOf = (el) => el.closest('.side');
const liveSide = () => sideOf($('files'));

// Draws the other side from its state, and fetches its missing icons.
function drawOther() {
  if (!split) return;
  const el = $('files-other');
  el.dataset.view = split.other.view;
  el.innerHTML = asOther(() => (listError ? `<div class="note">${NOTES[listError] || ''}</div>` : RENDER[view]()));
  el.scrollTop = split.other.scroll || 0;
  asOther(() => loadIcons());
  drawHeads();
}

// Lists the other side's folder again (it changed on disk, or files moved there).
async function refreshOther() {
  if (!split) return;
  const dir = split.other.cwd;
  const res = await api.list(dir, { hidden: app.settings.showHidden, extensions: app.settings.showExtensions });
  if (!split || split.other.cwd !== dir) return;
  const o = split.other;
  o.listError = res.error || null;
  o.items = res.error ? [] : asOther(() => sortItems(res.items));
  const paths = new Set(o.items.map((it) => it.path));
  o.sel = new Set([...o.sel].filter((p) => paths.has(p)));
  o.scroll = $('files-other').scrollTop;
  drawOther();
}

// The folder bar on top of each side.
function drawHeads() {
  if (!split) return;
  const head = (side, dir) => {
    side.querySelector('.sidehead').innerHTML = `<svg><use href="#${specialIcon(dir) || 'i-folder'}"/></svg><span>${esc(shownPath(dir))}</span>`;
  };
  head(liveSide(), cwd);
  head(sideOf($('files-other')), split.other.cwd);
  liveSide().classList.add('on');
  sideOf($('files-other')).classList.remove('on');
}

// The other side becomes the live one.
async function swapSides() {
  if (!split) return;
  if (renaming) endRename(true);
  closeMenu();
  if (searchOn()) await navigate(cwd, { push: false, keep: true });
  const live = $('files');
  const other = $('files-other');
  const liveBox = liveSide();
  const otherBox = sideOf(other);
  const mine = takeSide();
  const back = split.other;
  // The live list's drawing stays where it is, as the other side's.
  other.innerHTML = live.innerHTML;
  other.dataset.view = live.dataset.view;
  liveBox.appendChild(other);
  otherBox.appendChild(live);
  other.scrollTop = mine.scroll;
  putSide(back);
  split.other = mine;
  render();
  $('files').scrollTop = back.scroll || 0;
  updateChrome();
  loadVolume();
  api.watch(cwd, 'main');
  api.watch(split.other.cwd, 'other');
  drawHeads();
  $('files').focus();
}

// Turns two panes on, the new side at the same folder, or off, keeping the side in use.
function setSplit(on) {
  if (on === !!split) return;
  if (on) {
    split = { other: { ...takeSide(), history: [cwd], hIndex: 0, sel: new Set(), anchor: null, cursor: null, scroll: 0 } };
    document.body.classList.add('split');
    $('side-r').hidden = false;
    $('divider').hidden = false;
    drawOther();
    api.watch(split.other.cwd, 'other');
  } else {
    split = null;
    document.body.classList.remove('split');
    // The side in use goes back to the left.
    if (liveSide() !== $('side-l')) {
      $('side-r').appendChild($('files-other'));
      $('side-l').appendChild($('files'));
    }
    $('files-other').innerHTML = '';
    $('side-r').hidden = true;
    $('divider').hidden = true;
    api.watch(null, 'other');
  }
  $('b-split').classList.toggle('down', !!split);
  api.setView(look());
  fitList();
}

// For tabs: what to keep, and putting a tab's panes back.
function splitNow() {
  return split ? { other: { ...split.other, sel: [...split.other.sel], scroll: $('files-other').scrollTop }, left: liveSide() === $('side-l') } : null;
}

async function restoreSplit(saved) {
  setSplit(false);
  if (!saved) return;
  setSplit(true);
  split.other = { ...saved.other, sel: new Set(saved.other.sel) };
  if (!saved.left) {
    // The side in use was the right one.
    $('side-l').appendChild($('files-other'));
    $('side-r').appendChild($('files'));
  }
  await refreshOther();
}

// ---------- using the other side ----------

let pending = null; // a press on the other side, which makes it the live one on release
let justSwapped = 0;

$('files-other').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const el = e.target.closest('.item');
  pending = { i: el ? Number(el.dataset.i) : null, meta: e.metaKey || e.shiftKey };
});

document.addEventListener('mouseup', async (e) => {
  if (!pending) return;
  const p = pending;
  pending = null;
  if (!e.target.closest('#files-other')) return;
  await swapSides();
  justSwapped = Date.now();
  if (p.i !== null && items[p.i]) {
    sel = new Set([items[p.i].path]);
    anchor = cursor = items[p.i].path;
  } else if (!p.meta) {
    sel.clear();
  }
  showSelection();
});

// Dragging straight from the other side drags its items without switching.
$('files-other').addEventListener('dragstart', (e) => {
  const el = e.target.closest('.item');
  pending = null;
  e.preventDefault();
  if (!el || !split) return;
  const it = split.other.items[el.dataset.i];
  if (!it || it.volume) return;
  const paths = split.other.sel.has(it.path) ? split.other.items.filter((x) => split.other.sel.has(x.path)).map((x) => x.path) : [it.path];
  api.startDrag(paths);
});

// A right click on the other side switches to it, then shows its menu.
$('files-other').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  pending = null;
  const x = e.clientX;
  const y = e.clientY;
  await swapSides();
  const target = document.elementFromPoint(x, y);
  if (target) target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
});

// The second click of a double click lands after the switch.
$('files').addEventListener('mousedown', (e) => {
  if (e.detail !== 2 || Date.now() - justSwapped > 600 || app.settings.clickToOpen === 'single') return;
  const el = e.target.closest('.item');
  justSwapped = 0;
  if (el) openItem(items[el.dataset.i]);
}, true);

// Where a drop on the other side lands: a folder under the pointer, or its folder.
function otherDropTarget(e) {
  if (!split) return null;
  const el = e.target.closest('#files-other .item');
  if (el) {
    const it = split.other.items[el.dataset.i];
    if (it && isFolder(it)) return { dir: it.path, el };
  }
  const o = split.other;
  if (o.cwd === TRASH && !o.listError) return { trash: true, el: null };
  return isPlace(o.cwd) || o.listError ? null : { dir: o.cwd, el: null };
}

// ---------- Copy and Move to Other Side ----------

async function toOtherSide(move) {
  if (!split || isPlace(split.other.cwd) || split.other.listError) return;
  const picked = selectedItems().filter((it) => !it.volume && !(move && it.fixed));
  if (!picked.length) return;
  const paths = picked.map((it) => it.path);
  if (move) await api.moveTo(paths, split.other.cwd);
  else await api.sendToFolder(paths, split.other.cwd);
  refreshOther();
}

// Opens a folder or place in the other side, and moves to it.
async function openInOther(dir) {
  if (!split) setSplit(true);
  await swapSides();
  await navigate(dir);
}

document.addEventListener('keydown', (e) => {
  if (!split || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    swapSides();
  } else if (e.key === 'F5') {
    e.preventDefault();
    toOtherSide(false);
  } else if (e.key === 'F6') {
    e.preventDefault();
    toOtherSide(true);
  }
});

$('b-split').addEventListener('click', () => setSplit(!split));

// A click on the other side's folder bar switches to it as well.
$('sides').addEventListener('mousedown', (e) => {
  const head = e.target.closest('.sidehead');
  if (head && split && sideOf(head) !== liveSide()) swapSides();
});

// The line between the sides can be dragged to make one wider.
$('divider').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const box = $('sides').getBoundingClientRect();
  const move = (m) => {
    const f = Math.min(0.8, Math.max(0.2, (m.clientX - box.left) / box.width));
    $('side-l').style.flex = `${f} 1 0`;
    $('side-r').style.flex = `${1 - f} 1 0`;
    fitList();
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
});
