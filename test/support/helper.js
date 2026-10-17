// Runs `filedrawer-helper serve` for a test file and sends it requests the
// way src/main/helper.js does, one JSON line each way. Build the helper
// first (npm run test:helper does).
const { spawn } = require('child_process');
const readline = require('readline');
const { helperPath } = require('../../scripts/build-helper');

function serve() {
  const bin = helperPath();
  if (!bin) throw new Error('the helper is not built, run npm run test:helper');
  const child = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve(msg);
  });
  return {
    request(cmd, args = {}) {
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
      });
    },
    stop: () => child.kill()
  };
}

module.exports = { serve };
