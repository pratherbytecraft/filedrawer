// ~/.ssh/config and ~/.ssh/known_hosts, read the way ssh reads them, for
// SSH sites. Filedrawer never changes the config file. The only thing it
// writes is one line added to known_hosts, after the user says yes to a
// server it hasn't seen before.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// One host from the config file, with every setting that applies to it.
export interface ConfigHost {
  alias: string; // the name on the Host line
  host: string; // HostName, or the alias
  user: string;
  port: number;
  identityFiles: string[]; // full paths, as the file says (they may not exist)
  proxy: boolean; // ProxyJump or ProxyCommand, which Filedrawer doesn't follow
}

export const sshDir = () => path.join(os.homedir(), '.ssh');
// The keys ssh tries when the config names none, in ssh's order.
export const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk'];

// ssh's patterns: * and ? as wildcards, ignoring case.
function glob(pattern: string, text: string) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i').test(text);
}

// A Host line's patterns against a name: one match is enough, and a
// pattern starting with ! that matches rules it out.
function matches(patterns: string[], name: string) {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (glob(p.slice(1), name)) return false;
    } else if (glob(p, name)) {
      hit = true;
    }
  }
  return hit;
}

// A line's words, with "quoted words" kept whole. Keyword=value works too.
function words(line: string) {
  const out: string[] = [];
  const re = /"([^"]*)"|([^\s"]+)/g;
  let m;
  const text = line.replace(/^\s*([A-Za-z]+)\s*=\s*/, '$1 ');
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out;
}

interface Block {
  patterns: string[] | null; // null for the lines before the first Host
  skip: boolean; // a Match block, which Filedrawer doesn't work out
  opts: [string, string[]][];
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);

// The files an Include line names: relative to ~/.ssh, with * in the name.
function included(arg: string) {
  const full = path.isAbsolute(expandHome(arg)) ? expandHome(arg) : path.join(sshDir(), arg);
  const base = path.basename(full);
  if (!/[*?]/.test(base)) return [full];
  const dir = path.dirname(full);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => glob(base, n)).sort().map((n) => path.join(dir, n));
}

// The config text as blocks, with Include files read in where they're named.
export function parseConfig(text: string, blocks: Block[] = [{ patterns: null, skip: false, opts: [] }], depth = 0): Block[] {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...args] = words(line);
    if (!key) continue;
    const k = key.toLowerCase();
    if (k === 'host') {
      blocks.push({ patterns: args, skip: false, opts: [] });
    } else if (k === 'match') {
      blocks.push({ patterns: [], skip: true, opts: [] });
    } else if (k === 'include') {
      if (depth >= 8) continue;
      for (const arg of args) {
        for (const f of included(arg)) {
          let more = '';
          try {
            more = fs.readFileSync(f, 'utf8');
          } catch {
            continue;
          }
          parseConfig(more, blocks, depth + 1);
        }
      }
    } else {
      blocks[blocks.length - 1].opts.push([k, args]);
    }
  }
  return blocks;
}

// ssh's %h, %p, %r, %u and %% in a value.
function tokens(value: string, h: { host: string; port: number; user: string }) {
  return value.replace(/%([hpru%])/g, (_m, t: string) =>
    t === 'h' ? h.host : t === 'p' ? String(h.port) : t === 'r' ? h.user : t === 'u' ? os.userInfo().username : '%');
}

// Every setting for one name: the first value found wins, as in ssh, and
// IdentityFile adds up.
export function hostFor(blocks: Block[], alias: string): ConfigHost {
  const got = new Map<string, string[]>();
  const ids: string[] = [];
  for (const b of blocks) {
    if (b.skip || (b.patterns && !matches(b.patterns, alias))) continue;
    for (const [k, args] of b.opts) {
      if (k === 'identityfile') ids.push(...args);
      else if (!got.has(k)) got.set(k, args);
    }
  }
  const first = (k: string) => (got.get(k) || [])[0];
  const port = Number(first('port')) || 22;
  const user = first('user') || os.userInfo().username;
  const host = tokens(first('hostname') || alias, { host: alias, port, user });
  const via = [first('proxyjump'), first('proxycommand')];
  const proxy = via.some((v) => !!v && v.toLowerCase() !== 'none');
  return {
    alias,
    host,
    user,
    port,
    identityFiles: ids.filter((f) => f.toLowerCase() !== 'none').map((f) => {
      const p = expandHome(tokens(f, { host, port, user }));
      return path.isAbsolute(p) ? p : path.join(sshDir(), p);
    }),
    proxy
  };
}

// The hosts the config names outright, not the patterns (Host *, Host *.lan).
export function hostsIn(text: string): ConfigHost[] {
  const blocks = parseConfig(text);
  const seen = new Set<string>();
  const out: ConfigHost[] = [];
  for (const b of blocks) {
    if (b.skip || !b.patterns) continue;
    for (const p of b.patterns) {
      if (/[*?!]/.test(p) || seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      out.push(hostFor(blocks, p));
    }
  }
  return out;
}

// The hosts in ~/.ssh/config, read again only when the file changes.
let cached: { mtime: number; hosts: ConfigHost[] } | null = null;
export function configHosts(): ConfigHost[] {
  const file = path.join(sshDir(), 'config');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cached = null;
    return [];
  }
  if (cached && cached.mtime === mtime) return cached.hosts;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  cached = { mtime, hosts: hostsIn(text) };
  return cached.hosts;
}

// ---------- known_hosts ----------

// How known_hosts names a host: plain on port 22, [host]:port otherwise.
export const hostEntry = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`);

// The key type written at the start of a key's data, such as ssh-ed25519.
export function keyType(blob: Buffer) {
  if (blob.length < 4) return '';
  const n = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + n).toString('ascii');
}

// The way ssh shows a key: SHA256: and the hash in base64 without padding.
export const fingerprint = (blob: Buffer) => 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

// One name in a known_hosts line against the host: plain, a pattern, or
// hashed (|1|salt|hash, from HashKnownHosts).
function nameMatches(name: string, entry: string) {
  if (name.startsWith('|1|')) {
    const [, , salt, hash] = name.split('|');
    if (!salt || !hash) return false;
    const mac = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(entry).digest('base64');
    return mac === hash;
  }
  return glob(name, entry);
}

export interface KnownKey {
  type: string;
  key: string; // base64
}

// The keys known_hosts has for a host.
export function knownKeys(text: string, host: string, port: number): KnownKey[] {
  const entry = hostEntry(host, port);
  const out: KnownKey[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // @revoked and @cert-authority lines aren't keys for one host.
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [names, type, key] = line.split(/\s+/);
    if (!names || !type || !key) continue;
    const list = names.split(',');
    if (list.some((n) => n.startsWith('!') && nameMatches(n.slice(1), entry))) continue;
    if (list.some((n) => !n.startsWith('!') && nameMatches(n, entry))) out.push({ type, key });
  }
  return out;
}

const KNOWN_FILE = () => path.join(sshDir(), 'known_hosts');
const readKnown = () => {
  try {
    return fs.readFileSync(KNOWN_FILE(), 'utf8');
  } catch {
    return '';
  }
};

// known: the key is there. new: the host isn't, or only with keys of other
// types. changed: the host is there with a different key of the same type,
// which stops the connection.
export function checkKey(host: string, port: number, blob: Buffer, text = readKnown()): 'known' | 'new' | 'changed' {
  const keys = knownKeys(text, host, port);
  const b64 = blob.toString('base64');
  if (keys.some((k) => k.key === b64)) return 'known';
  const type = keyType(blob);
  return keys.some((k) => k.type === type) ? 'changed' : 'new';
}

// The key types known_hosts has for a host, so the server is asked for one
// of those first.
export const knownTypes = (host: string, port: number) => [...new Set(knownKeys(readKnown(), host, port).map((k) => k.type))];

// Adds the host's key to known_hosts, the way ssh does after a yes.
export function addKnown(host: string, port: number, blob: Buffer) {
  fs.mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const text = readKnown();
  const line = `${hostEntry(host, port)} ${keyType(blob)} ${blob.toString('base64')}\n`;
  fs.appendFileSync(KNOWN_FILE(), (text && !text.endsWith('\n') ? '\n' : '') + line, { mode: 0o600 });
}
