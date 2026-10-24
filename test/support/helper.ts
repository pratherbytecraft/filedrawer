// Runs `filedrawer-helper serve` for a test file and sends it requests the
// way src/main/helper.ts does, one JSON line each way. Build the helper
// first (npm run test:helper does).
import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

// The replies src/main/helper.ts expects, by command, so the tests read
// them with the app's own types. Type only, nothing here loads it.
type HelperModule = typeof import('../../src/main/helper');
type Command = Parameters<HelperModule['request']>[0];
declare const request: HelperModule['request'];
type ReplyTo<K extends Command> = NonNullable<Awaited<ReturnType<typeof request<K>>>>;
// A command the app never sends can only answer with an error.
type Answer<K extends string> = K extends Command ? ReplyTo<K> : { error?: string };

const HELPER = path.join(__dirname, '..', '..', 'helper', 'filedrawer-helper');
const helperPath = () => (fs.existsSync(HELPER) ? HELPER : null);

export function serve() {
  const bin = helperPath();
  if (!bin) throw new Error('the helper is not built, run npm run test:helper');
  const child = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (msg: unknown) => void>();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve(msg);
  });
  return {
    request<K extends string>(cmd: K, args: Record<string, unknown> = {}): Promise<Answer<K>> {
      const id = next++;
      return new Promise((resolve) => {
        // The reply is the helper's JSON, trusted to match its command.
        pending.set(id, (msg) => resolve(msg as Answer<K>));
        child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
      });
    },
    stop: () => child.kill()
  };
}

