// Tabs, in a strip under the title bar. Each tab keeps its own folder, Back
// and Forward history, view and selection; the window shows one at a time.
// Switching tabs puts this tab's place away and lists the other's folder
// again, so it's never out of date. Loaded after window.js, edit.js and
// search.js, and shares their state (cwd, history, view, sel and so on).

let tabs = []; // { cwd, history, hIndex, view, sel, scroll } for every tab but the shown one's live state
let tabOn = 0;
let tabDrag = null; // the tab being dragged to a new spot

const TAB_TYPE = 'application/x-filedrawer-tab';

function tabNow() {
  return { cwd, history: history.slice(), hIndex, view, sel: [...sel], scroll: $('files').scrollTop, split: splitNow() };
}

function startTabs() {
  tabs = [tabNow()];
  tabOn = 0;
  drawTabs();
}

function drawTabs() {
  if (!tabs.length) return;
  tabs[tabOn] = { ...tabs[tabOn], cwd };
  $('tabstrip').innerHTML = tabs.map((t, i) => {
    const label = i === tabOn && searchOn() ? 'Search Results' : placeLabel(t.cwd);
    return `<div class="tab${i === tabOn ? ' on' : ''}" data-tab="${i}" draggable="true" title="${esc(shownPath(t.cwd))}">` +
      `<svg><use href="#${specialIcon(t.cwd) || 'i-folder'}"/></svg><span class="tl">${esc(label)}</span>` +
      `<span class="tx" data-close="${i}" title="Close Tab">&times;</span></div>`;
  }).join('') + '<div class="tab-add" id="tab-add" title="New Tab">+</div>';
}

// Puts the shown tab's place away and shows tab i.
async function showTab(i) {
  if (i === tabOn || !tabs[i]) return;
  if (renaming) endRename(true);
  closeMenu();
  tabs[tabOn] = tabNow();
  tabOn = i;
  await openTabState(tabs[i]);
}

async function openTabState(t) {
  history = t.history.slice();
  hIndex = t.hIndex;
  if (t.view !== view && RENDER[t.view]) view = t.view;
  // Two panes are this tab's own: the side in use comes back, then the other.
  await restoreSplit(null);
  await navigate(t.cwd, { push: false, selectMany: t.sel });
  if (t.scroll) $('files').scrollTop = t.scroll;
  if (t.split) await restoreSplit(t.split);
  drawTabs();
  $('files').focus();
}

// A new tab after the shown one, at dir or the start folder.
async function newTab(dir = app.startFolder || app.home) {
  if (renaming) endRename(true);
  closeMenu();
  tabs[tabOn] = tabNow();
  const t = { cwd: dir, history: [dir], hIndex: 0, view: app.settings.newWindowView !== 'last' ? app.settings.newWindowView : app.settings.view, sel: [], scroll: 0 };
  tabs.splice(tabOn + 1, 0, t);
  tabOn += 1;
  await openTabState(t);
}

// Closing the last tab closes the window.
async function closeTab(i = tabOn) {
  if (tabs.length === 1) {
    window.close();
    return;
  }
  if (i !== tabOn) {
    tabs.splice(i, 1);
    if (i < tabOn) tabOn -= 1;
    drawTabs();
    return;
  }
  tabs.splice(i, 1);
  tabOn = Math.min(i, tabs.length - 1);
  await openTabState(tabs[tabOn]);
}

const nextTab = (step) => showTab((tabOn + step + tabs.length) % tabs.length);

$('tabstrip').addEventListener('mousedown', (e) => {
  const x = e.target.closest('[data-close]');
  if (x && e.button === 0) {
    e.preventDefault();
    closeTab(Number(x.dataset.close));
    return;
  }
  if (e.target.closest('#tab-add') && e.button === 0) {
    e.preventDefault();
    newTab();
    return;
  }
  const t = e.target.closest('.tab');
  if (t && e.button === 0) showTab(Number(t.dataset.tab));
});

// A middle click closes a tab, a double click on the empty strip opens one.
$('tabstrip').addEventListener('auxclick', (e) => {
  const t = e.target.closest('.tab');
  if (t && e.button === 1) closeTab(Number(t.dataset.tab));
});
$('tabstrip').addEventListener('dblclick', (e) => {
  if (e.target === $('tabstrip')) newTab();
});

// Dragging a tab along the strip puts the tabs in another order.
$('tabstrip').addEventListener('dragstart', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  tabDrag = Number(t.dataset.tab);
  e.dataTransfer.setData(TAB_TYPE, String(tabDrag));
  e.dataTransfer.effectAllowed = 'move';
});
$('tabstrip').addEventListener('dragover', (e) => {
  if (tabDrag === null) return;
  e.preventDefault();
  e.stopPropagation();
});
$('tabstrip').addEventListener('drop', (e) => {
  if (tabDrag === null) return;
  e.preventDefault();
  e.stopPropagation();
  const over = e.target.closest('.tab');
  const to = over ? Number(over.dataset.tab) : tabs.length - 1;
  tabs[tabOn] = tabNow();
  const shown = tabs[tabOn];
  const [moved] = tabs.splice(tabDrag, 1);
  tabs.splice(to, 0, moved);
  tabOn = tabs.indexOf(shown);
  tabDrag = null;
  drawTabs();
});
$('tabstrip').addEventListener('dragend', () => {
  tabDrag = null;
});
