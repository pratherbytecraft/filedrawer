// Connections to SSH sites, and folders read over SFTP. One connection per
// site, shared by every window and tab on it, closed after a few quiet
// minutes and opened again when it's needed. Before a server is used the
// first time, its key is shown and the user decides; a server whose key
// changed isn't used at all.
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Client, utils, type AnyAuthMethod, type SFTPWrapper, type Stats } from '../vendor/ssh2';
import * as sites from './sites';
import * as sshconfig from './sshconfig';
import * as secrets from './secrets';
import type { SecretAnswer, SecretAsk } from '../shared/types';
import type { Completion, Item, Listing, ListError, ListOptions, Resolved, SiteStatus } from '../shared/types';

type Site = sites.Site;

const IDLE = 5 * 60 * 1000; // a connection nobody used for this long is closed
const REACH_TIMEOUT = 8000; // ms to wait for the server to answer at all
const PROBE_TIMEOUT = 4000; // ms for the online check
const CALL_TIMEOUT = 15000; // ms a server gets to answer one request before its connection is dropped
const LOGIN_TIMEOUT = 30000; // ms the login itself may take, once the server's key is settled
const posix = path.posix;

// Why a site couldn't be used, with a sentence for the window. locked is
// a key that has a passphrase, when that may be why the login failed.
export class SiteError extends Error {
  kind: ListError;
  locked: string | null;
  declined: boolean; // the user said no
  constructor(kind: ListError, message: string, locked: string | null = null, declined = false) {
    super(message);
    this.kind = kind;
    this.locked = locked;
    this.declined = declined;
  }
}

// ---------- asking about a new server ----------

export interface HostQuestion {
  site: Site;
  type: string;
  fingerprint: string;
}

// Set by the main process: shows the question and says whether to go on.
let ask: (q: HostQuestion) => Promise<boolean> = async () => false;
export function setAsk(fn: (q: HostQuestion) => Promise<boolean>) {
  ask = fn;
}

// Set by the main process: the sheet that asks for a password or passphrase.
let askSecret: (a: SecretAsk) => Promise<SecretAnswer | null> = async () => null;
export function setAskSecret(fn: (a: SecretAsk) => Promise<SecretAnswer | null>) {
  askSecret = fn;
}

// ---------- whether a site's server answers ----------

const status: SiteStatus = {};
const statusListeners = new Set<(s: SiteStatus) => void>();
export const getStatus = () => ({ ...status });
export function onStatus(fn: (s: SiteStatus) => void) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function setStatus(id: string, up: boolean) {
  if (status[id] === up) return;
  status[id] = up;
  for (const fn of statusListeners) fn(getStatus());
}

// A TCP connection to the server's port, closed again straight away.
function reach(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const fail = (err: Error) => {
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timeout, () => fail(new Error('timed out')));
    sock.once('error', fail);
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeListener('error', fail);
      resolve(sock);
    });
  });
}

// Checks every site in the list and tells the listeners about changes.
export async function check(list: Site[]) {
  await Promise.all(list.map(async (s) => {
    if (conns.has(s.id)) return; // connected, so it answers
    try {
      (await reach(s.host, s.port, PROBE_TIMEOUT)).destroy();
      setStatus(s.id, true);
    } catch {
      setStatus(s.id, false);
    }
  }));
}

// ---------- connections ----------

interface Conn {
  id: string; // the site's
  host: string;
  client: Client;
  sftp: SFTPWrapper;
  home: string;
  sig: string; // the settings it was made with
  timer?: NodeJS.Timeout;
}

const conns = new Map<string, Promise<Conn>>();
// What a connection depends on: when any of it changes, a new one is made.
const signature = (s: Site) => JSON.stringify([s.host, s.port, s.user, s.logon, s.keys]);

// Keys ssh2 can use: readable, and not locked with a passphrase unless
// it was given. Says which ones are still locked.
function usableKeys(files: string[], passphrase?: string) {
  const keys: { key: Buffer; passphrase?: string }[] = [];
  const locked: string[] = [];
  for (const f of files) {
    let data: Buffer;
    try {
      data = fs.readFileSync(f);
    } catch {
      continue;
    }
    const parsed = utils.parseKey(data);
    if (parsed instanceof Error) {
      if (!/passphrase|encrypted/i.test(parsed.message)) continue;
      if (passphrase !== undefined && !(utils.parseKey(data, passphrase) instanceof Error)) keys.push({ key: data, passphrase });
      else locked.push(f);
      continue;
    }
    keys.push({ key: data });
  }
  return { keys, locked };
}

// What a login uses besides keys and the agent.
interface Creds {
  password?: string;
  passphrase?: string;
}

// ssh2's names for the key types known_hosts can hold.
const HOST_KEY_ALGOS: Record<string, string[]> = {
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521']
};

const shortPath = (f: string) => f.replace(sshconfig.sshDir(), '~/.ssh');

async function connect(site: Site, creds: Creds = {}): Promise<Conn> {
  if (site.proxy) throw new SiteError('other', `${site.name} is reached through another host in your SSH config, which Filedrawer can't do yet.`);
  let sock: net.Socket;
  try {
    sock = await reach(site.host, site.port, REACH_TIMEOUT);
  } catch {
    setStatus(site.id, false);
    throw new SiteError('offline', `${site.host} isn't answering. The site opens as soon as the server is back on the network.`);
  }
  setStatus(site.id, true);
  const usesPassword = site.logon === 'password' || site.logon === 'ask';
  const { keys, locked } = usesPassword ? { keys: [], locked: [] } : usableKeys(site.keys, creds.passphrase);
  const agent = process.env.SSH_AUTH_SOCK;
  const methods: AnyAuthMethod[] = [];
  const keyMethods: AnyAuthMethod[] = keys.map((k) => ({ type: 'publickey', username: site.user, key: k.key, passphrase: k.passphrase }));
  const agentMethods: AnyAuthMethod[] = agent ? [{ type: 'agent', username: site.user, agent }] : [];
  const pw = creds.password || '';
  if (usesPassword) {
    // Servers take a password one of two ways. Only one is tried: macOS's
    // own server never answers a wrong password given the second way.
    methods.push({ type: 'password', username: site.user, password: pw },
      { type: 'keyboard-interactive', username: site.user, prompt: (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)) });
  } else if (site.logon === 'agent') {
    methods.push(...agentMethods, ...keyMethods);
  } else {
    methods.push(...keyMethods, ...agentMethods);
  }
  if (!methods.length) {
    sock.destroy();
    throw new SiteError('login', locked.length
      ? `The key ${shortPath(locked[0])} has a passphrase.`
      : `Filedrawer couldn't find a key to log in to ${site.host} with. Pick a key file in Site Manager.`, locked[0] || null);
  }
  let refused: 'changed' | 'declined' | null = null;
  // The methods in order, each tried when the server allows it. A password
  // site asks the server what it allows first, with none.
  const queue = methods.slice();
  let askedNone = false;
  let triedPassword = false;
  let loginTimer: NodeJS.Timeout | undefined;
  let loginLate = false;
  const authHandler = (left: string[] | null, _partial: boolean, next: (m: AnyAuthMethod | false) => void) => {
    if (!loginTimer) {
      loginTimer = setTimeout(() => {
        loginLate = true;
        client.end();
      }, LOGIN_TIMEOUT);
    }
    if (usesPassword && !askedNone && !left) {
      askedNone = true;
      return next({ type: 'none', username: site.user });
    }
    while (queue.length) {
      const m = queue.shift() as AnyAuthMethod;
      if (m.type === 'keyboard-interactive' && triedPassword) continue;
      if (left && !left.includes(m.type === 'agent' ? 'publickey' : m.type)) continue;
      if (m.type === 'password') triedPassword = true;
      return next(m);
    }
    next(false);
  };
  const known = sshconfig.knownTypes(site.host, site.port).flatMap((t) => HOST_KEY_ALGOS[t] || []);
  const client = new Client();
  const ready = new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.once('close', () => reject(new Error('closed')));
  });
  client.connect({
    sock,
    username: site.user,
    readyTimeout: 10 * 60 * 1000, // the key question can sit open; the server answered already
    keepaliveInterval: 15 * 1000,
    keepaliveCountMax: 2,
    authHandler: authHandler as never,
    algorithms: known.length ? { serverHostKey: { prepend: known as never[] } as never } : undefined,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      const seen = sshconfig.checkKey(site.host, site.port, key);
      if (seen === 'known') return verify(true);
      if (seen === 'changed') {
        refused = 'changed';
        return verify(false);
      }
      ask({ site, type: sshconfig.keyType(key), fingerprint: sshconfig.fingerprint(key) }).then((yes) => {
        if (yes) {
          try {
            sshconfig.addKnown(site.host, site.port, key);
          } catch {
            // still connect; it asks again next time
          }
        } else {
          refused = 'declined';
        }
        verify(yes);
      }, () => verify(false));
    }
  });
  try {
    await ready;
    clearTimeout(loginTimer);
  } catch (err) {
    clearTimeout(loginTimer);
    client.end();
    if (loginLate) throw new SiteError('login', `${site.host} didn't finish the login. Check the user and ${usesPassword ? 'password' : 'key'} in Site Manager.`);
    if (refused === 'changed') {
      throw new SiteError('hostkey', `The key ${site.host} sent isn't the one in ~/.ssh/known_hosts, so Filedrawer didn't connect. If you know why it changed, remove its old line from that file and try again.`);
    }
    if (refused === 'declined') throw new SiteError('hostkey', `Filedrawer didn't connect to ${site.host}.`, null, true);
    const level = (err as { level?: string }).level;
    if (level === 'client-authentication') {
      throw new SiteError('login', usesPassword
        ? `Filedrawer couldn't log in to ${site.user}@${site.host}. Check the user and password in Site Manager.`
        : `Filedrawer couldn't log in to ${site.user}@${site.host}. Check the user and key in Site Manager.`, locked[0] || null);
    }
    throw new SiteError('other', `Filedrawer couldn't connect to ${site.host}: ${(err as Error).message}`);
  }
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s)))).catch((err: Error) => {
    client.end();
    throw new SiteError('other', `${site.host} doesn't allow SFTP: ${err.message}`);
  });
  // The server ending SFTP ends the connection, so the next request makes a new one.
  sftp.on('close', () => client.end());
  const home = await new Promise<string>((resolve) => sftp.realpath('.', (err, p) => resolve(err ? '/' : p)));
  return { id: site.id, host: site.host, client, sftp, home, sig: signature(site) };
}

function close(id: string) {
  const p = conns.get(id);
  conns.delete(id);
  if (p) p.then((c) => c.client.end(), () => {});
}

// The site's connection, made when there isn't one (or its settings changed).
async function conn(site: Site): Promise<Conn> {
  let p = conns.get(site.id);
  if (p) {
    const c = await p.catch(() => null);
    if (c && c.sig !== signature(site)) {
      close(site.id);
      p = undefined;
    }
  }
  if (!p) {
    const made = logIn(site);
    conns.set(site.id, made);
    made.then((c) => {
      c.client.on('close', () => {
        if (conns.get(site.id) === made) conns.delete(site.id);
      });
      c.client.on('error', () => {}); // the close that follows clears it
    }, () => {
      if (conns.get(site.id) === made) conns.delete(site.id);
    });
    p = made;
  }
  const c = await p;
  clearTimeout(c.timer);
  c.timer = setTimeout(() => close(site.id), IDLE);
  return c;
}

// Passwords typed for Ask for password sites, kept until Filedrawer quits
// so a connection made again after a quiet spell doesn't ask again.
const typed = new Map<string, string>();

// Connects, asking for a password or a key's passphrase when the site
// needs one, and again when one doesn't work.
// A no to a password, passphrase or new server key holds for a moment, so
// the window's next request right after it doesn't ask again.
const saidNo = new Map<string, { at: number; err: SiteError }>();
const NO_HOLDS = 5000;

async function logIn(site: Site): Promise<Conn> {
  const no = saidNo.get(site.id);
  if (no && Date.now() - no.at < NO_HOLDS) throw no.err;
  try {
    return await logInAsking(site);
  } catch (err) {
    if (err instanceof SiteError && err.declined) saidNo.set(site.id, { at: Date.now(), err });
    throw err;
  }
}

async function logInAsking(site: Site): Promise<Conn> {
  const creds: Creds = {};
  let note = '';
  let fromSheet: SecretAnswer | null = null;
  if (site.logon === 'password') creds.password = secrets.get(site.id) ?? undefined;
  if (site.logon === 'ask') creds.password = typed.get(site.id);
  for (let tries = 0; tries < 4; tries++) {
    if ((site.logon === 'password' || site.logon === 'ask') && creds.password === undefined) {
      fromSheet = await askSecret({
        title: `Log in to ${site.name}`,
        detail: note || `Password for ${site.user}@${site.host}`,
        label: 'Password',
        canSave: site.logon === 'password' && site.from === 'saved'
      });
      if (!fromSheet) throw new SiteError('login', `Filedrawer didn't log in to ${site.user}@${site.host}.`, null, true);
      creds.password = fromSheet.value;
    }
    try {
      const c = await connect(site, creds);
      if (fromSheet && fromSheet.save) secrets.set(site.id, fromSheet.value);
      if (site.logon === 'ask') typed.set(site.id, creds.password || '');
      return c;
    } catch (err) {
      if (!(err instanceof SiteError) || err.kind !== 'login') throw err;
      if (site.logon === 'password' || site.logon === 'ask') {
        creds.password = undefined;
        typed.delete(site.id);
        note = `That password didn't work for ${site.user}@${site.host}. Try again.`;
        continue;
      }
      if (err.locked) {
        const a = await askSecret({
          title: `Unlock ${shortPath(err.locked)}`,
          detail: creds.passphrase === undefined ? `The key ${shortPath(err.locked)} has a passphrase.` : `That passphrase didn't unlock ${shortPath(err.locked)}. Try again.`,
          label: 'Passphrase',
          canSave: false
        });
        if (!a) throw new SiteError('login', `Filedrawer didn't log in to ${site.user}@${site.host}.`, null, true);
        creds.passphrase = a.value;
        continue;
      }
      throw err;
    }
  }
  throw new SiteError('login', `Filedrawer couldn't log in to ${site.user}@${site.host}.`);
}

// Forgets the connection and typed password of a site, after its settings change.
export function forget(id: string) {
  typed.delete(id);
  close(id);
}

export function closeAll() {
  for (const id of [...conns.keys()]) close(id);
}

// ---------- SFTP calls as promises ----------

// SFTP's status codes: 2 no such file, 3 permission denied.
const code = (err: unknown) => (err as { code?: number }).code;

function errorOf(err: unknown): ListError {
  if (err instanceof SiteError) return err.kind;
  return code(err) === 2 ? 'missing' : code(err) === 3 ? 'denied' : 'other';
}

// A request the server doesn't answer in time: the connection is dropped,
// so the next try makes a new one, and the window says the server isn't
// answering.
function timed<T>(c: Conn, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      close(c.id);
      setStatus(c.id, false);
      reject(new SiteError('offline', `${c.host} stopped answering. The site opens as soon as the server is back on the network.`));
    }, CALL_TIMEOUT);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const readdir = (c: Conn, p: string) => timed(c, new Promise<{ filename: string; attrs: Stats }[]>((resolve, reject) =>
  c.sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list)))));
const stat = (c: Conn, p: string) => timed(c, new Promise<Stats>((resolve, reject) => c.sftp.stat(p, (err, s) => (err ? reject(err) : resolve(s)))));

// ---------- folders ----------

const site = (p: string) => {
  const at = sites.split(p);
  const s = at && sites.byId(at.id);
  if (!at || !s) throw new SiteError('missing', 'This site isn\'t in Site Manager or your SSH config anymore.');
  return { site: s, path: at.path };
};

// The items in a folder on a site. Kinds are filled in by folders.ts.
export async function list(dir: string, { hidden = false }: ListOptions = {}): Promise<Listing> {
  try {
    const at = site(dir);
    const c = await conn(at.site);
    const entries = await readdir(c, at.path);
    const items: Item[] = await Promise.all(entries
      .filter((e) => e.filename !== '.' && e.filename !== '..' && (hidden || !e.filename.startsWith('.')))
      .map(async (e) => {
        const full = posix.join(at.path, e.filename);
        let attrs = e.attrs;
        const link = attrs.isSymbolicLink();
        if (link) attrs = await stat(c, full).catch(() => e.attrs);
        const isDir = attrs.isDirectory();
        return {
          name: e.filename,
          display: e.filename,
          path: sites.join(at.site.id, full),
          dir: isDir,
          package: false,
          link,
          ext: isDir ? '' : posix.extname(e.filename).slice(1).toLowerCase(),
          size: isDir ? null : attrs.size,
          modified: attrs.mtime * 1000,
          created: 0, // servers don't say
          hidden: e.filename.startsWith('.'),
          kind: '',
          canAdd: isDir
        };
      }));
    const self = await stat(c, at.path).catch(() => null);
    return { path: dir, items, modified: self ? self.mtime * 1000 : null, writable: true };
  } catch (err) {
    const error = errorOf(err);
    return { path: dir, error, message: err instanceof SiteError ? err.message : undefined };
  }
}

// The folder a site opens in: its start folder, else the home folder on the
// server. The site's top when it can't be reached, so the window can say why.
export async function home(id: string): Promise<string> {
  const s = sites.byId(id);
  if (!s) return sites.join(id, '/');
  try {
    const c = await conn(s);
    if (s.start) return sites.join(id, s.start.startsWith('/') ? s.start : posix.join(c.home, s.start.replace(/^~\/?/, '')));
    return sites.join(id, c.home);
  } catch {
    return sites.join(id, s.start.startsWith('/') ? s.start : '/');
  }
}

// A typed path on a site, against its home folder.
function serverPath(typed: string, homeDir: string) {
  if (!typed || typed === '~') return homeDir;
  if (typed.startsWith('~/')) return posix.join(homeDir, typed.slice(2));
  return typed.startsWith('/') ? posix.normalize(typed) : posix.join(homeDir, typed);
}

// What an address points at, for a site's address or a path typed while a
// site's folder is open. null for anything on the Mac.
export async function resolve(text: string, cwd: string): Promise<Resolved | null> {
  const t = text.trim();
  let target: { site: Site; path: string } | null = null;
  let typed: string | null = null;
  if (sites.isRemote(t)) {
    try {
      target = site(t);
    } catch {
      return { type: 'missing', path: t };
    }
  } else {
    const parsed = sites.parseAddress(t);
    if (parsed) {
      target = { site: parsed.site, path: '' };
      typed = parsed.path;
    } else if (sites.isRemote(cwd) && t && !/^[/~]/.test(t)) {
      // A name or a relative path, from a folder on a site.
      try {
        const here = site(cwd);
        target = { site: here.site, path: posix.join(here.path, t) };
      } catch {
        return null;
      }
    }
  }
  if (!target) return null;
  let c: Conn;
  try {
    c = await conn(target.site);
  } catch {
    // The window lists it and says why it can't.
    return { type: 'dir', path: sites.join(target.site.id, typed !== null ? (typed.startsWith('/') ? typed : '/') : target.path) };
  }
  const p = typed !== null ? serverPath(typed, c.home) : target.path;
  const full = sites.join(target.site.id, p);
  try {
    const st = await stat(c, p);
    return { type: st.isDirectory() ? 'dir' : 'file', path: full };
  } catch {
    return { type: 'missing', path: full };
  }
}

// Folders on a site that start with what's been typed, written the way the
// site was typed (homelab:/srv/..., or the full user@host:/srv/... for a
// path typed while a site's folder is open).
export async function complete(text: string, cwd: string): Promise<Completion[] | null> {
  const t = text.trim();
  const parsed = sites.parseAddress(t);
  let s: Site;
  let typed: string;
  let lead: string;
  if (parsed && !/^sftp:/i.test(t)) {
    s = parsed.site;
    typed = parsed.path;
    lead = sites.typedSite(t) + ':';
  } else if (sites.isRemote(cwd) && t && !/^[/~]/.test(t)) {
    try {
      const here = site(cwd);
      s = here.site;
      typed = posix.join(here.path, t) + (t.endsWith('/') ? '/' : '');
      lead = `${s.user}@${s.host}:`;
    } catch {
      return null;
    }
  } else {
    return null;
  }
  let c: Conn;
  try {
    c = await conn(s);
  } catch {
    return [];
  }
  const full = serverPath(typed, c.home);
  const ends = typed.endsWith('/') || typed === '' || typed === '~';
  const parent = ends ? full : posix.dirname(full);
  const prefix = ends ? '' : posix.basename(full).toLowerCase();
  let entries;
  try {
    entries = await readdir(c, parent);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.attrs.isDirectory() && e.filename.toLowerCase().startsWith(prefix) && (!e.filename.startsWith('.') || prefix.startsWith('.')))
    .map((e) => posix.join(parent, e.filename))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 12)
    .map((p) => ({ path: sites.join(s.id, p), value: lead + p }));
}

// The number of items in a folder on a site, hidden ones left out.
export async function count(dir: string) {
  try {
    const at = site(dir);
    const c = await conn(at.site);
    const entries = await readdir(c, at.path);
    return entries.filter((e) => !e.filename.startsWith('.')).length;
  } catch {
    return null;
  }
}
