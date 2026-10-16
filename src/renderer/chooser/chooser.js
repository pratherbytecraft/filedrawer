// The app list window. Change... from Properties picks between every file
// with the extension and this file only; Choose App... from Open With opens
// the file, with a box to make the app the default as well.
const api = window.filedrawer;
const $ = (id) => document.getElementById(id);
let data = null;
let apps = [];
let picked = null; // an app path

api.onState((state) => window.applyTheme(state));
api.getState().then((state) => window.applyTheme(state));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);


// Recommended: the default, apps picked here before (last picked first) and
// apps that name this kind of file. Other Apps: the rest that can open it.
function groups() {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const rank = (a) => (a.default ? -1 : data.order.indexOf(a.path) >= 0 ? data.order.indexOf(a.path) : 99);
  const top = apps.filter((a) => a.default || a.picked || a.claims).sort((a, b) => rank(a) - rank(b) || byName(a, b));
  const rest = apps.filter((a) => !top.includes(a)).sort(byName);
  return [['Recommended', top], ['Other Apps', rest]].filter(([, list]) => list.length);
}

function draw() {
  const ordered = [];
  $('list').innerHTML = groups().map(([title, list]) => `<div class="grp">${title}</div>` + list.map((a) => {
    ordered.push(a);
    const tag = a.default ? 'default' : '';
    return `<div class="row${a.path === picked ? ' on' : ''}" data-i="${ordered.length - 1}">` +
      `${a.icon ? `<img src="${a.icon}" alt="">` : ''}<span class="nm">${esc(a.name)}</span>${tag ? `<small>${tag}</small>` : ''}</div>`;
  }).join('')).join('');
  $('list').ordered = ordered;
  $('ok').disabled = !picked;
  const on = $('list').querySelector('.row.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

$('list').addEventListener('mousedown', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  picked = $('list').ordered[row.dataset.i].path;
  draw();
});
$('list').addEventListener('dblclick', (e) => {
  if (e.target.closest('.row')) ok();
});

// Up and Down move through the list.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    ok();
  } else if (e.key === 'Escape') {
    window.close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const list = $('list').ordered;
    const i = list.findIndex((a) => a.path === picked);
    const next = Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (list[next]) picked = list[next].path;
    draw();
  }
});

async function ok() {
  if (!picked || !data) return;
  let scope;
  if (data.mode === 'change') scope = document.querySelector('input[name="scope"]:checked').value;
  else scope = $('always') && $('always').checked ? 'type' : 'open';
  $('ok').disabled = true;
  const res = await api.chooserDone({ app: picked, scope });
  if (res && res.error) $('ok').disabled = false;
}

$('ok').addEventListener('click', ok);
$('cancel').addEventListener('click', () => window.close());
$('browse').addEventListener('click', async () => {
  const app = await api.chooserBrowse();
  if (!app) return;
  if (!apps.some((a) => a.path === app.path)) apps.push(app);
  const known = apps.find((a) => a.path === app.path);
  known.picked = true;
  picked = app.path;
  draw();
});

api.chooserGet().then((d) => {
  data = d;
  if (!d) return;
  apps = d.apps;
  document.title = d.mode === 'change' ? 'Change Default App' : 'Open With';
  if (d.icon) $('icon').src = d.icon;
  $('intro').innerHTML = `Choose the app to open <b>${esc(d.name)}</b> with.`;
  // A file with no extension only changes itself: its kind is "any file".
  const only = d.name.endsWith(' files') ? 'These files only' : 'This file only';
  if (d.mode === 'change' && !d.ext) {
    $('scope').innerHTML = `<label><input type="radio" name="scope" value="file" checked> ${only}</label>`;
    const current = apps.find((a) => a.default);
    picked = current ? current.path : null;
  } else if (d.mode === 'change') {
    $('scope').innerHTML = `<label><input type="radio" name="scope" value="type" checked> All .${esc(d.ext)} files</label>` +
      `<label><input type="radio" name="scope" value="file"> ${only}</label>`;
    const current = apps.find((a) => a.default);
    picked = current ? current.path : null;
  } else {
    $('scope').innerHTML = d.ext ? `<label><input type="checkbox" id="always"> Always use this app to open .${esc(d.ext)} files</label>` : '';
    $('ok').textContent = 'Open';
    const first = groups()[0];
    picked = first ? first[1][0].path : null;
  }
  draw();
  $('list').focus();
});
