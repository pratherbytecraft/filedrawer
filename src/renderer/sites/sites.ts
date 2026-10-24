// Site Manager: the sites made here on the left under My Sites, with the
// hosts from ~/.ssh/config under them, and the picked one's settings on the
// right. Nothing is kept until Save or Connect. A config host can only be
// ticked for the sidebar here; Duplicate copies it into My Sites to change.
const api = window.filedrawer;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

let saved: SavedSite[] = [];
let config: SiteInfo[] = [];
let shown = new Set<string>(); // config hosts ticked for the sidebar
let withPassword = new Set<string>(); // saved sites with a saved password
const passwords: Record<string, string | null> = {}; // typed here, or null to forget
let picked: string | null = null;

const LOGONS: [SiteLogon, string][] = [['key', 'Key file'], ['password', 'Password'], ['ask', 'Ask for password'], ['agent', 'SSH agent']];

api.onState((state) => window.applyTheme(state));
api.getState().then((state) => window.applyTheme(state));

const savedSite = (id: string | null) => saved.find((s) => s.id === id) || null;
const configSite = (id: string | null) => config.find((s) => s.id === id) || null;

function drawList() {
  const row = (id: string, name: string) => `<div class="row${id === picked ? ' on' : ''}" data-id="${esc(id)}"><svg><use href="#p-site"/></svg><span class="nm">${esc(name)}</span></div>`;
  $('list').innerHTML =
    `<div class="grp"><svg><use href="#p-folder"/></svg>My Sites</div>` + (saved.length ? saved.map((s) => row(s.id, s.name || s.host || 'New site')).join('') : '<div class="none">None yet</div>') +
    (config.length ? `<div class="grp"><svg><use href="#p-key"/></svg>From SSH Config</div>` + config.map((s) => row(s.id, s.name)).join('') : '');
  const fromConfig = !!configSite(picked);
  $<HTMLButtonElement>('b-dup').disabled = !picked;
  $<HTMLButtonElement>('b-ren').disabled = !savedSite(picked);
  $<HTMLButtonElement>('b-del').disabled = !savedSite(picked);
  $<HTMLButtonElement>('b-connect').disabled = !picked;
  $('list').querySelector('.row.on')?.scrollIntoView({ block: 'nearest' });
  if (fromConfig) $('err').textContent = '';
}

function drawForm() {
  const s = savedSite(picked);
  const c = configSite(picked);
  if (!s && !c) {
    $('form').innerHTML = '<p class="empty">Pick a site on the left, or make one with New Site.</p>';
    return;
  }
  const ro = c ? ' disabled' : '';
  const v = (s || c) as SavedSite | SiteInfo; // one of them, checked above
  const logon = v.logon;
  const field = (label: string, key: string, value: string | number, extra = '') =>
    `<label for="f-${key}">${label}</label><input type="text" id="f-${key}" data-f="${key}" value="${esc(value)}" spellcheck="false"${ro}${extra}>`;
  const pwNote = s && withPassword.has(s.id) && passwords[s.id] === undefined
    ? 'A password is saved. Type a new one to change it.'
    : 'Saved on this Mac, locked with your Keychain.';
  $('form').innerHTML =
    (c ? `<div class="src">Read from ~/.ssh/config. Filedrawer doesn't change that file. Duplicate this site to change it here.${c.proxy ? ' It goes through another host, which Filedrawer can\'t do yet.' : ''}</div>` : '') +
    `<div class="grid">
      ${field('Name', 'name', v.name, ' class="wide"')}
      ${field('Host', 'host', v.host, ' placeholder="example.com"')}
      <span class="port"><label for="f-port">Port</label><input type="text" id="f-port" data-f="port" value="${esc(v.port === 22 && c ? '' : v.port)}" placeholder="22"${ro}></span>
      ${field('User', 'user', v.user, ' class="wide"')}
      <div class="hr"></div>
      <label for="f-logon">Logon Type</label><select id="f-logon" data-f="logon" class="wide"${ro}>${LOGONS.map(([k, l]) => `<option value="${k}"${k === logon ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${logon === 'key' ? `${field('Key file', 'key', v.key, ' placeholder="~/.ssh/id_ed25519"')}<button id="b-key"${ro}>Browse...</button>` : ''}
      ${logon === 'password' && s ? `<label for="f-pw">Password</label><input type="password" id="f-pw" class="wide" value="${esc(passwords[s.id] || '')}" placeholder="${withPassword.has(s.id) ? '••••••••' : ''}"><div class="note">${pwNote}</div>` : ''}
      ${logon === 'ask' ? '<div class="note">Filedrawer asks each time it connects, and doesn\'t save it.</div>' : ''}
      ${logon === 'agent' ? '<div class="note">Uses the keys loaded in your SSH agent, then your usual keys in ~/.ssh.</div>' : ''}
      ${logon === 'key' && !v.key ? '<div class="note">Empty, Filedrawer tries your usual keys in ~/.ssh.</div>' : ''}
      <div class="hr"></div>
      ${field('Start folder', 'start', v.start, ' class="wide" placeholder="Home folder"')}
      <label for="f-local">Local folder</label><input type="text" id="f-local" data-f="local" value="${esc(v.local)}" placeholder="None" spellcheck="false"${ro}><button id="b-local"${ro}>Browse...</button>
      <div class="note">Opens on the other side when Two Panes is on.</div>
      <label class="chk"><input type="checkbox" id="f-side"${(s ? s.side : shown.has(c!.name)) ? ' checked' : ''}> Show in the sidebar</label>
    </div>`;
}

function draw() {
  drawList();
  drawForm();
}

function pick(id: string | null) {
  picked = id;
  $('err').textContent = '';
  draw();
}

// Typing changes the site as it goes, without drawing again, so the field keeps its place.
$('form').addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  const s = savedSite(picked);
  if (!s) return;
  if (t.id === 'f-pw') {
    passwords[s.id] = t.value;
    return;
  }
  const f = t.dataset.f as keyof SavedSite | undefined;
  if (!f || f === 'logon') return;
  if (f === 'port') s.port = Number(t.value) || 22;
  else (s as unknown as Record<string, string>)[f] = t.value;
  if (f === 'name' || f === 'host') drawList();
});

$('form').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const s = savedSite(picked);
  const c = configSite(picked);
  if (t.id === 'f-side') {
    if (s) s.side = t.checked;
    else if (c) {
      if (t.checked) shown.add(c.name);
      else shown.delete(c.name);
    }
    return;
  }
  if (s && t.dataset.f === 'logon') {
    s.logon = t.value as SiteLogon;
    drawForm();
  }
});

$('form').addEventListener('click', async (e) => {
  const s = savedSite(picked);
  if (!s) return;
  const id = (e.target as HTMLElement).id;
  if (id === 'b-key') {
    const p = await api.browseKey(s.key);
    if (p) {
      s.key = p;
      drawForm();
    }
  } else if (id === 'b-local') {
    const p = await api.browseLocal(s.local);
    if (p) {
      s.local = p;
      drawForm();
    }
  }
});

$('list').addEventListener('mousedown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
  if (row) pick(row.dataset.id as string);
});

// Up and Down move through the list.
$('list').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const ids = [...saved.map((s) => s.id), ...config.map((s) => s.id)];
  const i = ids.indexOf(picked || '');
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (next) pick(next);
});

const newId = () => 's' + Math.random().toString(36).slice(2, 10);

function freeName(base: string) {
  const names = new Set([...saved, ...config].map((s) => s.name.toLowerCase()));
  let name = base;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

$('b-new').addEventListener('click', () => {
  const s: SavedSite = { id: newId(), name: freeName('New site'), host: '', port: 22, user: '', logon: 'key', key: '', start: '', local: '', side: true };
  saved.push(s);
  pick(s.id);
  $('f-host').focus();
});

$('b-dup').addEventListener('click', () => {
  const s = savedSite(picked);
  const c = configSite(picked);
  const from = (s || c) as SavedSite | SiteInfo | null;
  if (!from) return;
  const copy: SavedSite = {
    id: newId(), name: freeName(`${from.name} copy`), host: from.host, port: from.port, user: from.user,
    logon: from.logon, key: from.key, start: from.start, local: from.local, side: true
  };
  saved.push(copy);
  pick(copy.id);
});

$('b-ren').addEventListener('click', () => {
  const f = $<HTMLInputElement>('f-name');
  if (f) {
    f.focus();
    f.select();
  }
});

$('b-del').addEventListener('click', () => {
  const s = savedSite(picked);
  if (!s) return;
  const i = saved.indexOf(s);
  saved.splice(i, 1);
  passwords[s.id] = null;
  pick((saved[i] || saved[i - 1] || config[0] || { id: null }).id);
});

// The change for the main process: a site set to another logon forgets its saved password.
function change(): SitesChange {
  const pw: Record<string, string | null> = { ...passwords };
  for (const s of saved) if (s.logon !== 'password' && withPassword.has(s.id)) pw[s.id] = null;
  return { saved: saved.map((s) => ({ ...s, name: s.name.trim(), host: s.host.trim(), user: s.user.trim() })), configShown: [...shown], passwords: pw };
}

async function save() {
  const s = savedSite(picked);
  if (s && !s.host.trim()) {
    $('err').textContent = 'Type the server\'s address in Host.';
    $('f-host').focus();
    return false;
  }
  const res = await api.sitesSave(change());
  if (res.error) {
    $('err').textContent = res.error;
    return false;
  }
  return true;
}

$('b-cancel').addEventListener('click', () => api.closeSiteManager());
$('b-save').addEventListener('click', async () => {
  if (await save()) api.closeSiteManager();
});
$('b-connect').addEventListener('click', async () => {
  const id = picked;
  if (id && (await save())) api.connectSite(id);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.closeSiteManager();
  else if (e.key === 'Enter' && (e.target as HTMLElement).matches('input')) $('b-connect').click();
});

api.onSitesSelect((id) => pick(id));

api.sitesGet().then((data) => {
  if (!data) return;
  saved = data.saved.map((s) => ({ ...s }));
  config = data.config;
  shown = new Set(data.configShown);
  withPassword = new Set(data.passwords);
  picked = data.select && (savedSite(data.select) || configSite(data.select)) ? data.select : (saved[0] || config[0] || { id: null }).id;
  if (data.draft) {
    // Opened from a link with no site yet: a new one, filled in from the link.
    const d = data.draft;
    const s: SavedSite = { id: newId(), name: freeName(d.host), host: d.host, port: d.port, user: d.user, logon: 'key', key: '', start: d.start, local: '', side: true };
    saved.push(s);
    picked = s.id;
  }
  draw();
  $('list').focus();
});
