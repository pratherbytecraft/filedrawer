// Opening files on an SSH site, and a terminal on one. A file is copied to
// a folder of its own under the Mac's temporary folder, opened in its app,
// and copied back to the site each time it's saved, for as long as
// Filedrawer runs. Quick Look shows the copy.
import { BrowserWindow, dialog, shell } from 'electron';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as copier from './copier';
import * as fsx from './fsx';
import * as sites from './sites';
import { quote } from './sitesearch';

const ROOT = () => path.join(os.tmpdir(), 'Filedrawer Sites');
const CHECK = 2000; // ms between looks at the copies for a save

interface Copy {
  remote: string;
  local: string;
  synced: number; // the copy's mtime when it last matched the site
  saving: boolean;
  failed: boolean;
}

const copies = new Map<string, Copy>(); // remote path -> its copy
let timer: NodeJS.Timeout | null = null;

const localFor = (p: string) => {
  const at = sites.split(p) as { id: string; path: string }; // only called for paths on a site
  const hash = crypto.createHash('sha1').update(at.path).digest('hex').slice(0, 12);
  return path.join(ROOT(), at.id, hash, fsx.basename(p));
};

const mtime = (p: string) => fs.promises.stat(p).then((st) => st.mtimeMs, () => 0);

// The site's file on the Mac, fresh from the site unless the copy has
// changes that haven't gone back yet. null when it couldn't be fetched.
async function fetch(p: string, near: BrowserWindow | null): Promise<string | null> {
  const known = copies.get(p);
  if (known && (await mtime(known.local)) !== known.synced) return known.local;
  const local = localFor(p);
  await fs.promises.rm(local, { force: true });
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  // Through the copier, so a big file shows its progress and can be stopped.
  const res = await copier.start({ mode: 'copy', pairs: [{ src: p, target: local }], near });
  if (res.error || res.cancelled || !res.done.length) {
    if (res.error) await warn(near, `"${fsx.basename(p)}" couldn't be opened. ${res.error}`);
    return null;
  }
  copies.set(p, { remote: p, local, synced: await mtime(local), saving: false, failed: false });
  watch();
  return local;
}

async function warn(near: BrowserWindow | null, message: string) {
  const opts = { type: 'warning' as const, message, buttons: ['OK'] };
  if (near && !near.isDestroyed()) await dialog.showMessageBox(near, opts);
  else await dialog.showMessageBox(opts);
}

// Opens each file in its app; pictures share one Preview window, like on the Mac.
export async function open(paths: string[], near: BrowserWindow | null) {
  const locals: string[] = [];
  for (const p of paths) {
    const local = await fetch(p, near);
    if (local) locals.push(local);
  }
  if (locals.length > 1) execFile('open', locals, () => {});
  else if (locals.length) shell.openPath(locals[0]);
}

export async function preview(p: string, win: BrowserWindow) {
  const local = await fetch(p, win);
  if (local && !win.isDestroyed()) win.previewFile(local, fsx.basename(p));
}

// Saves go back to the site. A save that fails says so once, and tries
// again with the next save.
function watch() {
  if (timer) return;
  timer = setInterval(async () => {
    for (const c of copies.values()) {
      if (c.saving) continue;
      const now = await mtime(c.local);
      if (!now || now === c.synced) continue;
      c.saving = true;
      try {
        await fsx.copyFile(c.local, c.remote, () => {}, () => false);
        c.synced = now;
        c.failed = false;
      } catch (err) {
        if (!c.failed) await warn(null, `Your changes to "${fsx.basename(c.remote)}" couldn't be saved to ${sites.address(fsx.dirname(c.remote))}. ${(err as Error).message}`);
        c.failed = true;
        c.synced = now; // asked again on the next save
      }
      c.saving = false;
    }
  }, CHECK);
}

// Nothing is left behind in the temporary folder after Filedrawer quits.
export function cleanUp() {
  if (timer) clearInterval(timer);
  fs.rmSync(ROOT(), { recursive: true, force: true });
}

// Open Terminal Here on a site: the terminal app runs ssh into the folder.
// A host from the SSH config goes by its name, so ssh uses all of its
// settings; a site from Site Manager by user, host, port and key.
export function terminal(dir: string, app: string) {
  const at = sites.split(dir);
  const site = at && sites.byId(at.id);
  if (!at || !site) return;
  const target = site.from === 'config' ? [site.name] : [
    ...(site.port !== 22 ? ['-p', String(site.port)] : []),
    ...(site.logon === 'key' && site.key ? ['-i', site.key.replace(/^~(?=\/|$)/, os.homedir())] : []),
    `${site.user}@${site.host}`
  ];
  const there = `cd ${quote(at.path)} && exec $SHELL -l`;
  const script = path.join(ROOT(), `ssh-${Date.now()}.command`);
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.writeFileSync(script, `#!/bin/sh\nrm -f ${quote(script)}\nexec ssh -t ${target.map(quote).join(' ')} ${quote(there)}\n`, { mode: 0o755 });
  execFile('open', ['-a', app, script], (err) => {
    if (err && app !== 'Terminal') execFile('open', ['-a', 'Terminal', script], () => {});
  });
}
