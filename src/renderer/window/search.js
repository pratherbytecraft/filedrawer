// Searching from the left pane, like the old Search panel. The results take
// the file list's place, with an In Folder column in Details, until the
// search is closed or another folder is opened. Loaded after window.js.

let search = null; // { id, state, count, capped, pane } while results are shown
let searchId = 0;
let paneBefore = 'tasks'; // the pane to go back to

const searchOn = () => !!search;

function rootChoices() {
  const out = [];
  if (!isPlace(cwd) && cwd !== app.home) out.push([cwd, placeLabel(cwd)]);
  out.push([app.home, `${placeLabel(app.home)} (your home folder)`]);
  out.push([COMPUTER, 'Computer (every disk)']);
  return out;
}

function openSearch() {
  if (document.body.dataset.pane !== 'search') paneBefore = pane;
  $('q-root').innerHTML = rootChoices().map(([p, label]) => `<option value="${esc(p)}">${esc(label)}</option>`).join('');
  document.body.dataset.pane = 'search';
  $('b-search').classList.add('down');
  $('b-folders').classList.remove('down');
  fitList();
  $('q-name').focus();
  $('q-name').select();
}

// Back to the folder, and the pane that was there before.
function closeSearch() {
  const had = searchOn();
  leaveSearch();
  $('b-search').classList.remove('down');
  setPane(paneBefore, { save: false });
  if (had) navigate(cwd, { push: false, keep: true });
}

// Drops the results without redrawing. navigate calls this first.
function leaveSearch() {
  if (!search) return;
  api.stopSearch();
  search = null;
  $('q-stop').disabled = true;
  $('q-state').textContent = '';
}

function runSearch() {
  const q = {
    name: $('q-name').value.trim(),
    word: $('q-word').value.trim(),
    root: $('q-root').value,
    age: $('q-age').value,
    size: $('q-size').value,
    hidden: app.settings.showHidden,
    extensions: app.settings.showExtensions
  };
  if (!q.name && !q.word && !q.age && !q.size) {
    $('q-state').textContent = 'Type part of a name or a word to look for.';
    return;
  }
  if (renaming) endRename(false);
  search = { id: ++searchId, state: 'searching', count: 0, capped: false };
  items = [];
  sel = new Set();
  anchor = cursor = null;
  listError = null;
  $('q-stop').disabled = false;
  drawSearchState();
  render();
  updateTitle();
  api.startSearch(search.id, q);
}

function drawSearchState() {
  if (!search) return;
  const n = items.length;
  const found = `${n.toLocaleString('en-US')} item${n === 1 ? '' : 's'} found`;
  const text = {
    searching: n ? `Searching... ${found} so far.` : 'Searching...',
    walking: n ? `Looking through the folders... ${found} so far.` : 'Spotlight has nothing here, looking through the folders...',
    stopped: `Stopped. ${found}.`,
    done: search.capped ? `${found}. That's as many as one search shows, try narrowing it down.` : n ? `Done. ${found}.` : 'Nothing was found.'
  }[search.state];
  $('q-state').textContent = text;
  if (!sel.size) $('st1').textContent = search.state === 'searching' || search.state === 'walking' ? 'Searching...' : found;
}

// Results come in batches; the list is drawn again a few times a second at most.
let searchDraw = null;
api.onSearchResults(({ id, items: found }) => {
  if (!search || id !== search.id) return;
  items = sortItems(items.concat(found));
  if (searchDraw) return;
  searchDraw = setTimeout(() => {
    searchDraw = null;
    if (!search) return;
    const keep = $('files').scrollTop;
    render();
    $('files').scrollTop = keep;
    drawSearchState();
  }, 150);
});

api.onSearchState(({ id, state, count, capped }) => {
  if (!search || id !== search.id) return;
  Object.assign(search, { state, count: count ?? search.count, capped: !!capped });
  if (state === 'done' || state === 'stopped') $('q-stop').disabled = true;
  drawSearchState();
});

$('b-search').addEventListener('click', () => {
  if (document.body.dataset.pane === 'search') closeSearch();
  else openSearch();
});
$('search-close').addEventListener('click', closeSearch);
$('q-go').addEventListener('click', runSearch);
$('q-stop').addEventListener('click', () => api.stopSearch());
for (const id of ['q-name', 'q-word']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
      $('files').focus();
    }
  });
}

// The folder a result is in, short: ~ for the home folder.
function shortFolder(p) {
  const dir = dirname(p);
  return dir === app.home || dir.startsWith(app.home + '/') ? '~' + dir.slice(app.home.length) : dir;
}
