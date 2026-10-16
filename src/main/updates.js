// Checks the npm registry for a newer Filedrawer. It only checks: updating is
// `npm install -g filedrawer`, which the person runs themselves.
const { net } = require('electron');
const { EventEmitter } = require('events');

const LATEST = 'https://registry.npmjs.org/filedrawer/latest';
const FIRST_CHECK = 15 * 1000; // after launch, so it doesn't slow startup
const EVERY = 6 * 60 * 60 * 1000;

const events = new EventEmitter();
// state: idle | checking | current | available | failed. latest: the version on npm.
let status = { state: 'idle' };

// Whether version a is newer than b. Plain x.y.z, anything after a dash is ignored.
function newer(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function set(next) {
  status = next;
  events.emit('change', status);
}

async function check(current) {
  const before = status;
  set({ state: 'checking' });
  try {
    const res = await net.fetch(LATEST, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    // Not on npm (yet): nothing newer to find.
    if (res.status === 404) {
      set({ state: 'current', latest: current });
      return status;
    }
    if (!res.ok) throw new Error(`npm answered ${res.status}`);
    const { version } = await res.json();
    set({ state: newer(version, current) ? 'available' : 'current', latest: version });
  } catch (err) {
    console.log(`Filedrawer: update check failed: ${err.message}`);
    // A failed check doesn't hide an update that was already found.
    set(before.state === 'available' ? before : { state: 'failed' });
  }
  return status;
}

// Checks soon after launch and every few hours while enabled() says so.
function schedule(current, enabled) {
  const tick = () => enabled() && check(current);
  setTimeout(tick, FIRST_CHECK);
  setInterval(tick, EVERY);
}

module.exports = {
  check,
  schedule,
  newer,
  get: () => status,
  onChange: (fn) => events.on('change', fn)
};
