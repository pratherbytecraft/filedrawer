import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tempAppData } from '../support/electron';
import * as settings from '../../src/main/settings';
import * as sshconfig from '../../src/main/sshconfig';
import * as sites from '../../src/main/sites';
import { findCommand, quote } from '../../src/main/sitesearch';

// A made up home folder with its own ~/.ssh, so the real one is never read.
function fakeHome(config = '', known = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-home-'));
  fs.mkdirSync(path.join(home, '.ssh'));
  if (config) fs.writeFileSync(path.join(home, '.ssh', 'config'), config);
  if (known) fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), known);
  process.env.HOME = home;
  return home;
}

// A key blob the way a server sends it: its type, then made up key data.
function blob(type: string, fill = 1) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length);
  return Buffer.concat([len, name, Buffer.alloc(32, fill)]);
}

const CONFIG = `
# made up hosts
Host homelab
  HostName homelab.local
  User aaron

Host homelab-storage
  HostName homelab.local
  User storage
  IdentityFile ~/.ssh/homelab_storage

Host box "quoted host" *.lan !skip.lan
  Port=2222

Host *
  User fallback
  IdentityFile ~/.ssh/extra
`;

test('the config lists its named hosts, with the first value for each setting', () => {
  const home = fakeHome();
  const hosts = sshconfig.hostsIn(CONFIG);
  assert.deepEqual(hosts.map((h) => h.alias), ['homelab', 'homelab-storage', 'box', 'quoted host']);
  const [lab, storage, box] = hosts;
  assert.equal(lab.host, 'homelab.local');
  assert.equal(lab.user, 'aaron');
  assert.equal(lab.port, 22);
  // Host * adds its key file, and its User doesn't win over the one before it.
  assert.deepEqual(lab.identityFiles, [path.join(home, '.ssh', 'extra')]);
  assert.deepEqual(storage.identityFiles, [path.join(home, '.ssh', 'homelab_storage'), path.join(home, '.ssh', 'extra')]);
  assert.equal(box.host, 'box');
  assert.equal(box.port, 2222);
  assert.equal(box.user, 'fallback');
});

test('wildcards and negated names follow ssh', () => {
  fakeHome();
  const blocks = sshconfig.parseConfig(CONFIG);
  assert.equal(sshconfig.hostFor(blocks, 'nas.lan').port, 2222);
  assert.equal(sshconfig.hostFor(blocks, 'skip.lan').port, 22);
  assert.equal(sshconfig.hostFor(blocks, 'NAS.LAN').port, 2222);
});

test('Include reads more files from ~/.ssh, and ProxyJump marks a host', () => {
  const home = fakeHome();
  fs.mkdirSync(path.join(home, '.ssh', 'conf.d'));
  fs.writeFileSync(path.join(home, '.ssh', 'conf.d', 'work.conf'), 'Host work\n  HostName work.example.com\n  ProxyJump gate\n');
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Include conf.d/*.conf\nHost home\n  HostName %h.local\n');
  const hosts = sshconfig.configHosts();
  assert.deepEqual(hosts.map((h) => [h.alias, h.host, h.proxy]), [['work', 'work.example.com', true], ['home', 'home.local', false]]);
});

test('known_hosts finds a host plain, on another port, in a list and hashed', () => {
  fakeHome();
  const key = blob('ssh-ed25519').toString('base64');
  const salt = crypto.randomBytes(20);
  const hashed = `|1|${salt.toString('base64')}|${crypto.createHmac('sha1', salt).update('secret.lan').digest('base64')}`;
  const text = [
    '# comment',
    `homelab.local ssh-ed25519 ${key}`,
    `[nas.lan]:2222 ssh-rsa AAAA`,
    `a.lan,b.lan,10.0.0.5 ecdsa-sha2-nistp256 BBBB`,
    `${hashed} ssh-ed25519 CCCC`,
    `@revoked homelab.local ssh-rsa DDDD`
  ].join('\n');
  assert.deepEqual(sshconfig.knownKeys(text, 'homelab.local', 22), [{ type: 'ssh-ed25519', key }]);
  assert.deepEqual(sshconfig.knownKeys(text, 'nas.lan', 2222), [{ type: 'ssh-rsa', key: 'AAAA' }]);
  assert.deepEqual(sshconfig.knownKeys(text, 'nas.lan', 22), []);
  assert.deepEqual(sshconfig.knownKeys(text, 'b.lan', 22), [{ type: 'ecdsa-sha2-nistp256', key: 'BBBB' }]);
  assert.deepEqual(sshconfig.knownKeys(text, 'secret.lan', 22), [{ type: 'ssh-ed25519', key: 'CCCC' }]);
});

test('a server key is known, new, or changed, and a yes adds it', () => {
  const home = fakeHome();
  const key = blob('ssh-ed25519', 1);
  assert.equal(sshconfig.checkKey('homelab.local', 22, key), 'new');
  sshconfig.addKnown('homelab.local', 22, key);
  sshconfig.addKnown('nas.lan', 2222, blob('ssh-rsa'));
  const text = fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8');
  assert.match(text, /^homelab\.local ssh-ed25519 \S+\n\[nas\.lan\]:2222 ssh-rsa \S+\n$/);
  assert.equal(sshconfig.checkKey('homelab.local', 22, key), 'known');
  assert.equal(sshconfig.checkKey('homelab.local', 22, blob('ssh-ed25519', 2)), 'changed');
  // Known only with a key of another type: asked like a new one.
  assert.equal(sshconfig.checkKey('homelab.local', 22, blob('ecdsa-sha2-nistp256')), 'new');
  assert.deepEqual(sshconfig.knownTypes('homelab.local', 22), ['ssh-ed25519']);
  assert.match(sshconfig.fingerprint(key), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('sites are the saved ones and the config hosts, ticked ones shown', () => {
  fakeHome(CONFIG);
  fs.mkdirSync(path.join(tempAppData(), 'Filedrawer'), { recursive: true });
  settings.init();
  settings.update({
    sites: [{ id: 's1', name: 'Work', host: 'files.example.com', port: 22, user: 'me', logon: 'password', key: '', start: '/var/www', local: '', side: true }],
    configShown: ['homelab-storage']
  });
  const all = sites.all();
  assert.deepEqual(all.map((s) => [s.id, s.from, s.shown]), [
    ['s1', 'saved', true], ['ssh-homelab', 'config', false], ['ssh-homelab-storage', 'config', true],
    ['ssh-box', 'config', false], ['ssh-quoted%20host', 'config', false]
  ]);
  assert.equal(sites.byId('ssh-homelab-storage')!.logon, 'key');
  assert.equal(sites.byId('ssh-homelab')!.logon, 'key'); // Host * names a key file
});

test('saved sites are cleaned: no id or host drops one, a bad port is 22', () => {
  fakeHome();
  settings.init();
  settings.update({ sites: [{ id: 'a', host: 'h', port: 99999, logon: 'nope' }, { id: '', host: 'x' }, { id: 'b/c', host: 'y' }, 'z'] as never });
  assert.deepEqual(settings.get().sites, [{ id: 'a', name: 'h', host: 'h', port: 22, user: '', logon: 'key', key: '', start: '', local: '', side: true }]);
});

test('a folder on a site splits into its site and server path, and shows as user@host:/path', () => {
  fakeHome(CONFIG);
  settings.init();
  settings.update({ sites: [], configShown: [] });
  assert.deepEqual(sites.split('::site/ssh-homelab/home/aaron/'), { id: 'ssh-homelab', path: '/home/aaron' });
  assert.deepEqual(sites.split('::site/ssh-homelab'), { id: 'ssh-homelab', path: '/' });
  assert.equal(sites.split('/Users/me'), null);
  assert.equal(sites.join('ssh-homelab', '/'), '::site/ssh-homelab');
  assert.equal(sites.join('ssh-homelab', '/srv/media/'), '::site/ssh-homelab/srv/media');
  assert.equal(sites.address('::site/ssh-homelab-storage/home/storage'), 'storage@homelab.local:/home/storage');
});

test('typed addresses find their site by name, user@host, host or sftp://', () => {
  fakeHome(CONFIG);
  settings.init();
  settings.update({ sites: [{ id: 's1', name: 'Work', host: 'files.example.com', port: 22, user: 'me', logon: 'key', key: '', start: '', local: '', side: true }], configShown: [] });
  const found = (t: string) => {
    const r = sites.parseAddress(t);
    return r && [r.site.id, r.path];
  };
  assert.deepEqual(found('homelab-storage:/srv'), ['ssh-homelab-storage', '/srv']);
  assert.deepEqual(found('storage@homelab.local:Media'), ['ssh-homelab-storage', 'Media']);
  assert.deepEqual(found('aaron@homelab.local:'), ['ssh-homelab', '']);
  assert.deepEqual(found('work:~/www'), ['s1', '~/www']);
  assert.deepEqual(found('files.example.com:/var'), ['s1', '/var']);
  assert.deepEqual(found('sftp://me@files.example.com/var/www'), ['s1', '/var/www']);
  for (const local of ['/Users/me', '~/Documents', './a:b', 'Documents', 'nowhere:/x', 'a/b:c']) assert.equal(sites.parseAddress(local), null, local);
});

test('a search on a site becomes one find, with grep for a word, and nothing typed is read as shell', () => {
  assert.equal(quote("it's"), `'it'\\''s'`);
  const q = { name: '', word: '', age: '', size: '', hidden: false };
  assert.equal(findCommand('/srv', { ...q, name: 'report' }), `find '/srv' -mindepth 1 -name '.*' -prune -o -iname '*report*' -print 2>/dev/null`);
  assert.equal(findCommand('/srv', { ...q, name: 'a*b', hidden: true, age: 'week' }), `find '/srv' -mindepth 1 -iname '*a\\*b*' -mtime -7 -print 2>/dev/null`);
  assert.equal(findCommand('/my files', { ...q, word: "don't $(rm)" }),
    `find '/my files' -mindepth 1 -name '.*' -prune -o -type f -size -2048k -exec grep -lIiF -- 'don'\\''t $(rm)' '{}' + 2>/dev/null`.replace(`'{}'`, '{}'));
  assert.match(findCommand('/srv', { ...q, size: 'large' }), /-type f -print/);
});

test('sftp:// links split into user, host, port and path, and find their site by all three', () => {
  fakeHome(CONFIG);
  settings.init();
  settings.update({ sites: [], configShown: [] });
  assert.deepEqual(sites.parseSftpUrl('sftp://aaron@homelab.local/opt/homelab/slots/image'), { user: 'aaron', host: 'homelab.local', port: 22, path: '/opt/homelab/slots/image' });
  assert.deepEqual(sites.parseSftpUrl('SFTP://nas.lan:2222/My%20Files'), { user: '', host: 'nas.lan', port: 2222, path: '/My Files' });
  assert.deepEqual(sites.parseSftpUrl('sftp://me@[fe80::1]'), { user: 'me', host: 'fe80::1', port: 22, path: '' });
  assert.equal(sites.parseSftpUrl('sftp://bad/%E0%A4%A'), null);
  assert.equal(sites.parseSftpUrl('/Users/me'), null);
  const found = (t: string) => sites.parseAddress(t)?.site.id ?? null;
  assert.equal(found('sftp://aaron@homelab.local/opt/homelab'), 'ssh-homelab');
  assert.equal(found('sftp://storage@homelab.local/'), 'ssh-homelab-storage');
  assert.equal(found('sftp://box:2222/'), 'ssh-box');
  assert.equal(found('sftp://box/'), null); // box is on 2222
  assert.equal(found('sftp://someone@homelab.local/'), null);
});
