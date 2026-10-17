// The settings window. Each control is tied to a setting (data-key, with a
// dot for a nested one), and every change is saved at once. The small window
// at the top follows the Appearance and Folder Options pages.
const api = window.filedrawer;
const $ = (id) => document.getElementById(id);

let app = null; // state from the main process
let page = new URLSearchParams(location.search).get('page') || 'appearance';
let terminals = [];

const TITLES = { appearance: 'Appearance', folders: 'Folder Options', terminal: 'Terminal', viewer: 'Default File Manager', general: 'General', about: 'About' };
const PREVIEW_ON = new Set(['appearance', 'folders']);
const FILES = [['Invoices', 'd'], ['Projects', 'd'], ['Recipes', 'd'], ['.config', 'h'], ['Budget 2026', 'f', '.numbers'], ['Notes', 'f', '.txt'], ['Resume', 'f', '.pdf']];

const get = (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), app.settings);

function patchFor(key, value) {
  const parts = key.split('.');
  const out = {};
  let at = out;
  parts.slice(0, -1).forEach((k) => {
    at = at[k] = {};
  });
  at[parts[parts.length - 1]] = value;
  return out;
}

const set = (key, value) => api.updateSettings(patchFor(key, value));

// ---------- drawing the controls from the settings ----------

function macLook() {
  const s = app.settings;
  return s.theme === 'system' && s.appearance !== 'auto' ? s.appearance : app.system.appearance;
}

function fillThemes() {
  const s = app.settings;
  $('theme').innerHTML = app.themes.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  $('theme').value = s.theme;
  const theme = app.themes.find((t) => t.id === s.theme) || app.themes[0];
  $('scheme').innerHTML = theme.schemes.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if (theme.schemes.length) $('scheme').value = s.schemes[s.theme] || theme.schemes[0][0];
  $('row-scheme').hidden = theme.schemes.length < 2;
  const sys = s.theme === 'system';
  $('row-app').classList.toggle('off', !sys);
  $('row-accent').classList.toggle('off', !sys);
}

function draw() {
  const s = app.settings;
  document.documentElement.dataset.appearance = macLook();
  document.documentElement.dataset.accent = s.accent === 'auto' ? 'blue' : s.accent;
  if (s.accent === 'auto') document.documentElement.style.setProperty('--accent', app.system.accent);
  else document.documentElement.style.removeProperty('--accent');
  fillThemes();
  for (const el of document.querySelectorAll('.toggle[data-key]')) el.classList.toggle('on', !!get(el.dataset.key));
  for (const el of document.querySelectorAll('.seg[data-key]')) {
    for (const span of el.children) span.classList.toggle('on', span.dataset.v === get(el.dataset.key));
  }
  for (const el of document.querySelectorAll('select[data-key]')) el.value = get(el.dataset.key);
  for (const i of document.querySelectorAll('#accent i')) i.classList.toggle('on', i.dataset.v === s.accent);
  $('start').value = s.startFolder;
  $('start-path').textContent = s.startFolder === 'custom' ? s.startPath : '';
  $('login').classList.toggle('on', app.loginItem.on);
  $('login-note').textContent = app.loginItem.needsApproval ? 'macOS wants this allowed in System Settings, General, Login Items.' : '';
  drawVersion();
  $('about-version').textContent = `Version ${app.version}`;
  drawTerminals();
  drawPreview();
  drawFinder();
  drawPhotos();
}

// The Photos row on General: with the Photos permission, a picture or video
// dropped from Photos comes out as its edited version, the way Finder gets it.
function drawPhotos() {
  const p = app.photos || 'unknown';
  const allowed = '<span class="status"><i></i>Allowed</span>';
  const missing = (label) => `<span class="status"><i class="warn"></i>Not allowed</span><span class="btn primary" id="ph-btn">${label}</span>`;
  $('ph-ctl').innerHTML = p === 'allowed' ? allowed : missing(p === 'denied' ? 'Open Privacy Settings' : 'Allow');
  $('photos-note').textContent = p === 'allowed'
    ? 'A picture or video dropped from Photos lands as its edited version, the way Finder gets it. Pictures come out as JPEG.'
    : 'With the Photos permission, a picture or video dropped from Photos lands as its edited version, the way Finder gets it. Without it, a picture lands as its original file and a video can\'t be dropped.';
}

// The Finder takeover: the switch, and a row per permission it needs.
function drawFinder() {
  const on = app.settings.takeOverFinder;
  const p = app.finder || {};
  const allowed = '<span class="status"><i></i>Allowed</span>';
  const missing = (id, label) => `<span class="status"><i class="warn"></i>Not allowed</span><span class="btn primary" id="${id}">${label}</span>`;
  $('ax-ctl').innerHTML = p.accessibility ? allowed : missing('ax-btn', 'Open Privacy Settings');
  $('ae-ctl').innerHTML = p.automation === 'allowed' ? allowed
    : missing('ae-btn', p.automation === 'denied' ? 'Open Privacy Settings' : 'Allow');
  document.querySelectorAll('.perm').forEach((r) => r.classList.toggle('dim', !on));
  const note = $('finder-note');
  const lacking = !p.accessibility ? 'Accessibility' : p.automation !== 'allowed' ? 'Control Finder' : null;
  note.classList.toggle('warn', on && !!lacking);
  note.textContent = !on ? 'Folders open in Finder. Show in Finder from other apps opens Finder.'
    : lacking ? `Folders still open in Finder until ${lacking} is allowed below.`
      : 'Finder\'s new windows open here, and so does Show in Finder from other apps.';
  $('startbar-group').hidden = !app.startbar;
}

function drawVersion() {
  const u = app.update || { state: 'idle' };
  const line = {
    checking: 'Checking...',
    current: 'This is the newest version.',
    available: `Version ${u.latest} is out. Run the line below in Terminal, then quit Filedrawer and open it again.`,
    failed: 'The check didn\'t go through. Try again in a bit.'
  }[u.state] || '';
  $('version').innerHTML = `Version ${app.version}${line ? `<small>${line}</small>` : ''}`;
  // The line matches how this copy was installed, Homebrew or npm.
  $('update-cmd').textContent = app.updateCommand;
}

function drawTerminals() {
  const want = app.settings.terminal;
  const isOn = (t) => t.path === want || t.name === want;
  $('apps').innerHTML = terminals.map((t, i) =>
    `<div class="app${isOn(t) ? ' on' : ''}" data-i="${i}">${t.icon ? `<img alt="" src="${t.icon}">` : '<i style="background:#3a3a3c">&gt;_</i>'}${t.name}</div>`).join('') +
    '<div class="app" data-other="1"><i style="background:rgba(127,127,127,.35);color:var(--text)">+</i>Other...</div>';
}

// The colors of the classic schemes the preview draws from variables.
const SCHEME_1995 = {
  standard: ['#c0c0c0', '#000080', '#1084d0'], brick: ['#c2bfa5', '#800000', '#c08060'], desert: ['#d5ccbb', '#008080', '#80c0b8'],
  eggplant: ['#90b0a8', '#5a4a7a', '#9a88c0'], lilac: ['#b0a8d0', '#5a4e8c', '#a094d0'], maple: ['#d8c098', '#804000', '#c08040'],
  marine: ['#88c0b8', '#004060', '#4080a0'], plum: ['#a89890', '#483048', '#987088'], pumpkin: ['#e0c070', '#604020', '#d08040'],
  rainy: ['#8098b0', '#405068', '#8098b8'], rose: ['#d0a0a0', '#803040', '#c07080'], slate: ['#98a8b8', '#304860', '#7090b0'],
  spruce: ['#a0c0a0', '#305030', '#70a070'], storm: ['#a0a0a0', '#202030', '#606080'], teal: ['#a8c8c0', '#006060', '#40a0a0'],
  wheat: ['#d8d0a0', '#808000', '#c0c060']
};
const SCHEME_2009 = {
  sky: '#4a9ff5', dusk: '#2c4f8a', sea: '#14a4a8', leaf: '#4ca54d', lime: '#a3d55b', sun: '#f2c94c', pumpkin: '#f39c32', ruby: '#c8343b',
  pink: '#e055a5', blush: '#f4a6c6', violet: '#8b5bc0', lavender: '#b8a1e0', taupe: '#a69580', cocoa: '#6b4a2f', slate: '#6f7680',
  frost: '#e8eef5', graphite: '#8e8e93'
};

function drawPreview() {
  const s = app.settings;
  const mini = $('mini');
  const scheme = s.theme === 'system' ? '' : s.schemes[s.theme] || '';
  mini.className = `mini ${s.theme === 'system' ? 'system' + (macLook() === 'dark' ? ' dark' : '') : s.theme + ' ' + scheme}`;
  const c95 = SCHEME_1995[scheme] || SCHEME_1995.standard;
  mini.style.setProperty('--face', c95[0]);
  mini.style.setProperty('--t1', c95[1]);
  mini.style.setProperty('--t2', c95[2]);
  mini.style.setProperty('--g', SCHEME_2009[scheme] || SCHEME_2009.sky);
  $('preview').classList.toggle('no-pane', !s.showPane);
  $('mini-term').hidden = !s.terminalButton;
  $('mini-hidden').hidden = !s.hiddenButton;
  $('mini-title').textContent = s.fullPathTitle ? '/Users/you/Documents' : 'Documents';
  $('mini-list').innerHTML = FILES.filter((f) => s.showHidden || f[1] !== 'h').map(([n, k, ext], i) =>
    `<div class="${i === 1 ? 'sel' : ''}${k === 'h' ? ' hid' : ''}"><i class="${k === 'f' ? 'f' : ''}"></i><span>${n}${s.showExtensions && ext ? ext : ''}</span></div>`).join('');
}

// ---------- pages and search ----------

function showPage(p) {
  page = TITLES[p] ? p : 'appearance';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === page));
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('on', el.dataset.page === page));
  $('title').textContent = TITLES[page];
  $('preview').hidden = !PREVIEW_ON.has(page);
  $('content').scrollTop = 0;
}

function runSearch() {
  const q = $('search').value.trim().toLowerCase();
  const c = $('content');
  c.classList.toggle('searching', !!q);
  let hits = 0;
  document.querySelectorAll('.page .row').forEach((r) => {
    const miss = !!q && !r.textContent.toLowerCase().includes(q);
    r.classList.toggle('miss', miss);
    if (q && !miss) hits++;
  });
  c.classList.toggle('none', !!q && !hits);
  $('preview').hidden = !!q || !PREVIEW_ON.has(page);
  $('title').textContent = q ? 'Search' : TITLES[page];
}

$('nav').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  $('search').value = '';
  runSearch();
  showPage(a.dataset.page);
});
$('search').addEventListener('input', runSearch);

// ---------- changes ----------

document.addEventListener('click', (e) => {
  const t = e.target.closest('.toggle[data-key]');
  if (t) {
    set(t.dataset.key, !get(t.dataset.key));
    return;
  }
  const seg = e.target.closest('.seg[data-key] span');
  if (seg) {
    set(seg.parentNode.dataset.key, seg.dataset.v);
    return;
  }
  const sw = e.target.closest('#accent i');
  if (sw) {
    set('accent', sw.dataset.v);
    return;
  }
  if (e.target.id === 'ax-btn') {
    api.finderAccessibility();
    return;
  }
  if (e.target.id === 'ae-btn') {
    api.finderAutomation();
    return;
  }
  if (e.target.id === 'ph-btn') {
    api.photosAsk();
    return;
  }
  const term = e.target.closest('#apps .app');
  if (term) {
    if (term.dataset.other) api.chooseTerminal();
    else set('terminal', terminals[term.dataset.i].path);
  }
});

// Back from Privacy Settings, the Photos row looks again.
window.addEventListener('focus', () => api.photosRefresh());

$('theme').addEventListener('change', (e) => set('theme', e.target.value));
$('scheme').addEventListener('change', (e) => api.updateSettings({ schemes: { [app.settings.theme]: e.target.value } }));
for (const el of document.querySelectorAll('select[data-key]')) el.addEventListener('change', () => set(el.dataset.key, el.value));
$('start').addEventListener('change', (e) => {
  if (e.target.value === 'custom') {
    e.target.value = app.settings.startFolder; // until a folder is picked
    api.chooseStartFolder();
  } else {
    set('startFolder', e.target.value);
  }
});
$('login').addEventListener('click', () => api.setLoginItem(!app.loginItem.on));
$('check').addEventListener('click', () => api.checkUpdates());
$('copy-cmd').addEventListener('click', () => {
  api.copyText(app.updateCommand);
  $('copy-cmd').textContent = 'Copied';
  setTimeout(() => { $('copy-cmd').textContent = 'Copy'; }, 1500);
});
$('export').addEventListener('click', () => api.exportSettings());
$('import').addEventListener('click', () => api.importSettings());
$('reset').addEventListener('click', () => api.resetSettings());
$('kofi').addEventListener('click', () => api.openLink('kofi'));
$('issues').addEventListener('click', () => api.openLink('issues'));

// ---------- start ----------

async function loadTerminals() {
  terminals = await api.terminals();
  if (app) drawTerminals();
}

api.onState((state) => {
  const terminalChanged = app && app.settings.terminal !== state.settings.terminal;
  app = state;
  draw();
  if (terminalChanged) loadTerminals();
});
api.onSettingsPage((p) => {
  $('search').value = '';
  runSearch();
  showPage(p);
});
api.getState().then((state) => {
  app = state;
  draw();
  showPage(page);
  loadTerminals();
});
