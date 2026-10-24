// Saved SSH site passwords. Each is encrypted with Electron's safeStorage,
// whose key macOS keeps in the Keychain for Filedrawer's app, and the
// encrypted text is kept in site-passwords.json next to the settings. The
// settings file never holds a password, so exporting settings doesn't
// carry one either.
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

const file = () => path.join(app.getPath('appData'), 'Filedrawer', 'site-passwords.json');

function read(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, string>) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
}

export const has = (id: string) => id in read();

export function get(id: string): string | null {
  const enc = read()[id];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null; // the Keychain said no, or the key changed
  }
}

// False when macOS can't encrypt it, in which case nothing is saved.
export function set(id: string, password: string) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const all = read();
  all[id] = safeStorage.encryptString(password).toString('base64');
  write(all);
  return true;
}

export function remove(id: string) {
  const all = read();
  if (!(id in all)) return;
  delete all[id];
  write(all);
}

// Drops the passwords of sites that aren't there anymore.
export function keepOnly(ids: string[]) {
  const all = read();
  const kept = Object.fromEntries(Object.entries(all).filter(([id]) => ids.includes(id)));
  if (Object.keys(kept).length !== Object.keys(all).length) write(kept);
}
