// The window of a copy or move: what's going where, how far along, the time
// left, and the question when a name is taken.
const api = window.filedrawer;
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

api.getState().then((state) => window.applyTheme(state));
api.onState((state) => window.applyTheme(state));

api.onJob((u) => {
  document.title = u.title;
  $('title').textContent = u.title;
  $('line').textContent = u.line;
  $('current').textContent = u.current;
  $('fill').style.width = Math.round(u.fraction * 100) + '%';
  $('left').textContent = u.left;
  const q = u.question;
  $('ask').hidden = !q;
  $('job').hidden = !!q;
  if (q) {
    $('q').textContent = `There's already an item named "${q.name}" in "${q.folder}". Do you want to replace it?`;
    $('all-row').hidden = !q.more;
    $('all-text').textContent = `Do this for the other ${q.more === 1 ? 'item' : `${q.more} items`} too`;
    $('replace').focus();
  }
});

const answer = (choice) => api.answerJob(id, choice, $('all').checked);
$('replace').addEventListener('click', () => answer('replace'));
$('keep').addEventListener('click', () => answer('keep'));
$('skip').addEventListener('click', () => answer('skip'));
$('stop').addEventListener('click', () => answer('cancel'));
$('cancel').addEventListener('click', () => api.cancelJob(id));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.cancelJob(id);
});
