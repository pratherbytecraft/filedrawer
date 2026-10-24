// SSH sites: the ones made in Site Manager and the hosts in ~/.ssh/config,
// and the paths that point into them. A folder on a site travels through
// Filedrawer as SITE_PREFIX, the site's id, then the path on the server
// (::site/s1a2b3/home/me), so the windows, tabs, history and pins handle
// it like any other folder. The address bar shows it as user@host:/path.
import os from 'os';
import path from 'path';
import * as settings from './settings';
import * as sshconfig from './sshconfig';
import type { SavedSite, SiteInfo } from '../shared/types';

export const SITE_PREFIX = '::site/';

// A site with what connecting needs.
export interface Site extends SiteInfo {
  keys: string[]; // key files to try, full paths
}

export const isRemote = (p: string) => typeof p === 'string' && p.startsWith(SITE_PREFIX);

// Config hosts get an id from their name, so pins and sorts on them last.
const configId = (alias: string) => 'ssh-' + encodeURIComponent(alias);

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);
const defaultKeys = () => sshconfig.DEFAULT_KEYS.map((k) => path.join(sshconfig.sshDir(), k));

function fromSaved(s: SavedSite): Site {
  return {
    id: s.id, name: s.name, host: s.host, port: s.port || 22, user: s.user || os.userInfo().username,
    from: 'saved', shown: s.side, logon: s.logon, key: s.key, start: s.start, local: s.local, proxy: false,
    keys: s.logon === 'key' && s.key ? [expandHome(s.key)] : defaultKeys()
  };
}

function fromConfig(h: sshconfig.ConfigHost, shown: string[]): Site {
  return {
    id: configId(h.alias), name: h.alias, host: h.host, port: h.port, user: h.user,
    from: 'config', shown: shown.includes(h.alias), logon: h.identityFiles.length ? 'key' : 'agent',
    key: h.identityFiles[0] || '', start: '', local: '', proxy: h.proxy,
    keys: h.identityFiles.length ? h.identityFiles : defaultKeys()
  };
}

// Every site: the saved ones first, in their order, then the config's hosts.
export function all(): Site[] {
  const s = settings.get();
  if (!s) return [];
  return [...s.sites.map(fromSaved), ...sshconfig.configHosts().map((h) => fromConfig(h, s.configShown))];
}

// What the pages are told about each site (no key list).
export const info = (): SiteInfo[] => all().map(({ keys: _keys, ...rest }) => rest);

export const byId = (id: string) => all().find((s) => s.id === id) || null;

// A folder on a site, as its site's id and the path on the server.
export function split(p: string): { id: string; path: string } | null {
  const m = /^::site\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return null;
  return { id: m[1], path: path.posix.normalize(m[2] || '/').replace(/(.)\/+$/, '$1') };
}

export const join = (id: string, serverPath: string) => SITE_PREFIX + id + (serverPath === '/' ? '' : path.posix.normalize(serverPath).replace(/\/+$/, ''));

// user@host:/path, the way the address bar shows a folder on a site.
export function address(p: string) {
  const at = split(p);
  if (!at) return p;
  const site = byId(at.id);
  return site ? `${site.user}@${site.host}:${at.path}` : p;
}

// A typed address on a site: sftp://user@host:port/path, user@host:path,
// host:path or a site's name followed by :path. The path may be empty (the
// home folder), start with ~/ (in the home folder), be relative to the home
// folder, or start with /. A Mac path never gets here: it starts with /, ~
// or ., or has no colon before its first slash.
export interface Typed {
  site: Site;
  path: string; // as typed after the colon
}

// The parts of an sftp:// link: user, host, port and path (decoded, empty for the home folder).
export interface SftpUrl {
  user: string;
  host: string;
  port: number;
  path: string;
}

export function parseSftpUrl(text: string): SftpUrl | null {
  const m = /^sftp:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)?$/i.exec(text.trim());
  if (!m) return null;
  let p = '';
  try {
    p = m[4] ? decodeURIComponent(m[4]) : '';
  } catch {
    return null;
  }
  return { user: m[1] ? decodeURIComponent(m[1]) : '', host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22, path: p };
}

export const isSftpUrl = (text: string) => /^sftp:\/\//i.test(text.trim());

export function parseAddress(text: string): Typed | null {
  const t = text.trim();
  if (!t || /^[/~.]/.test(t) || !t.includes(':')) return null;
  const sites = all();
  if (isSftpUrl(t)) {
    const url = parseSftpUrl(t);
    if (!url) return null;
    // A site matches by host, and by user and port when the link has them.
    const site = sites.find((s) => s.host.toLowerCase() === url.host.toLowerCase() && (!url.user || s.user === url.user) && s.port === url.port);
    return site ? { site, path: url.path } : null;
  }
  const colon = t.indexOf(':');
  if (colon < 1 || t.slice(0, colon).includes('/')) return null;
  const left = t.slice(0, colon);
  const rest = t.slice(colon + 1);
  const lower = left.toLowerCase();
  const at = left.indexOf('@');
  const site =
    sites.find((s) => s.name.toLowerCase() === lower) ||
    (at > 0
      ? sites.find((s) => s.user === left.slice(0, at) && s.host.toLowerCase() === left.slice(at + 1).toLowerCase())
      : sites.find((s) => s.host.toLowerCase() === lower));
  return site ? { site, path: rest } : null;
}

// How a typed address writes its site, so completions keep it the same way.
export const typedSite = (text: string) => text.trim().slice(0, text.trim().indexOf(':'));
