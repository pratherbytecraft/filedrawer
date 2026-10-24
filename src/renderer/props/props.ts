// The Properties window: what an item is, its sizes and dates, and its
// name and switches, which OK applies.
const api = window.filedrawer;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let data: PropsData | null = null;

api.onState((state) => window.applyTheme(state));
api.getState().then((state) => window.applyTheme(state));

function fmtBytes(n: number) {
  if (n < 1000) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1000;
    i++;
  } while (v >= 1000 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]} (${n.toLocaleString('en-US')} bytes)`;
}

const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
};

api.getProps().then((d) => {
  data = d;
  if (!d) return;
  document.title = d.one ? `${d.fullName} Properties` : 'Properties';
  if (d.icon) $<HTMLImageElement>('icon').src = d.icon;
  $<HTMLInputElement>('name').value = d.name;
  $<HTMLInputElement>('name').disabled = !d.one;
  $('kind').textContent = d.kind;
  $('location').textContent = d.location;
  $('contains-label').hidden = $('contains').hidden = !d.folder;
  showOpensWith(d.opensWith);
  $('version-label').hidden = $('version').hidden = !d.version;
  $('version').textContent = d.version || '';
  $('from-label').hidden = $('from').hidden = !(d.whereFrom && d.whereFrom.length);
  $('from').innerHTML = (d.whereFrom || []).map((u) => u.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c])).join('<br>');
  if (d.volume) {
    // A disk: how full it is, in place of the sizes and the switches.
    // The page always has a .grid.
    (document.querySelector('.grid') as HTMLElement).querySelectorAll<HTMLElement>(':scope > span').forEach((el, i) => {
      if (i >= 6) el.hidden = true;
    });
    $('disk-grid').hidden = false;
    if (d.volume.total) $('used').textContent = fmtBytes(d.volume.total - d.volume.free);
    $('free').textContent = fmtBytes(d.volume.free);
    if (d.volume.total) $('capacity').textContent = fmtBytes(d.volume.total);
    $<HTMLInputElement>('name').disabled = true;
  }
  for (const k of ['created', 'modified', 'accessed'] as const) $(k).textContent = d[k] ? fmtDate(d[k]) : '';
  $('dates').hidden = $('dates-rule').hidden = !d.one;
  $('flags').hidden = $('flags-rule').hidden = !d.one || !!d.volume;
  $<HTMLInputElement>('locked').checked = !!d.locked;
  $<HTMLInputElement>('hidden').checked = !!d.hidden;
  $('hide-ext-box').hidden = d.hideExt === null || d.hideExt === undefined;
  $<HTMLInputElement>('hide-ext').checked = !!d.hideExt;
  $('comment-label').hidden = $('comment-box').hidden = d.comment === null || d.comment === undefined || !!d.volume;
  $<HTMLTextAreaElement>('comment').value = d.comment || '';
  $('ok').focus();
  fit();
});

// The window grows or shrinks to what this item shows: everything outside
// the page, plus the page's padding and the bottom of its last shown row.
function fit() {
  // The page always has a .page.
  const page = document.querySelector('.page') as HTMLElement;
  const box = page.getBoundingClientRect();
  const shown = [...page.children as HTMLCollectionOf<HTMLElement>].filter((el) => el.offsetParent);
  const bottom = Math.max(...shown.map((el) => el.getBoundingClientRect().bottom)) + page.scrollTop;
  const style = getComputedStyle(page);
  const padding = parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
  api.fitProps(window.innerHeight - box.height + (bottom - box.top) + padding + 1);
}

// The app these files open with, for files of one extension.
function showOpensWith(app: OpensWith | null) {
  $('opens-label').hidden = $('opens').hidden = !app;
  if (!app) return;
  $('opens-name').textContent = app.name;
  if (app.icon) $<HTMLImageElement>('opens-icon').src = app.icon;
  else $('opens-icon').removeAttribute('src');
}
api.onPropsOpensWith(showOpensWith);
$('change').addEventListener('click', () => api.changeDefaultApp());

api.onPropsSize((t) => {
  const more = t.done ? '' : '...';
  $('size').textContent = fmtBytes(t.bytes) + more;
  $('disk').textContent = fmtBytes(t.disk) + more;
  const files = `${t.files.toLocaleString('en-US')} file${t.files === 1 ? '' : 's'}`;
  const inner = Math.max(0, t.folders - (data && data.one ? 1 : 0));
  $('contains').textContent = `${files}, ${inner.toLocaleString('en-US')} folder${inner === 1 ? '' : 's'}${more}`;
});

async function ok() {
  if (!data) return window.close();
  const change: PropsChange = {};
  const name = $<HTMLInputElement>('name').value.trim();
  if (data.one && name && name !== data.name) change.name = name + (data.fullName.startsWith(data.name) ? data.fullName.slice(data.name.length) : '');
  if (data.one && $<HTMLInputElement>('locked').checked !== !!data.locked) change.locked = $<HTMLInputElement>('locked').checked;
  if (data.one && $<HTMLInputElement>('hidden').checked !== !!data.hidden) change.hidden = $<HTMLInputElement>('hidden').checked;
  if (data.one && !$('hide-ext-box').hidden && $<HTMLInputElement>('hide-ext').checked !== !!data.hideExt) change.hideExt = $<HTMLInputElement>('hide-ext').checked;
  if (data.one && !$('comment-box').hidden && $<HTMLTextAreaElement>('comment').value !== (data.comment || '')) change.comment = $<HTMLTextAreaElement>('comment').value;
  if (Object.keys(change).length) {
    const res = await api.applyProps(change);
    if (res.error) return;
  }
  window.close();
}

$('ok').addEventListener('click', ok);
$('cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => {
  // Return in Comments starts a new line, as in Finder.
  if (e.key === 'Enter' && !(e.target as HTMLElement).closest('textarea')) {
    e.preventDefault();
    ok();
  } else if (e.key === 'Escape') {
    window.close();
  }
});
