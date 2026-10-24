// The sheet that asks for a site's password, or for a key's passphrase.
const api = window.filedrawer;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

api.onState((state) => window.applyTheme(state));
api.getState().then((state) => window.applyTheme(state));

api.secretGet().then((ask) => {
  if (!ask) return;
  document.title = ask.title;
  $('detail').textContent = ask.detail;
  $('label').textContent = ask.label;
  $('save-row').hidden = !ask.canSave;
  $('value').focus();
});

const done = () => api.secretDone({ value: $<HTMLInputElement>('value').value, save: !$('save-row').hidden && $<HTMLInputElement>('save').checked });
$('ok').addEventListener('click', done);
$('cancel').addEventListener('click', () => api.secretDone(null));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') done();
  else if (e.key === 'Escape') api.secretDone(null);
});
