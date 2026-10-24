// Cypress loads each renderer page on its own, served from dist/renderer by
// a small server started here, with the preload's window.filedrawer replaced
// by a fake (support/fake.ts) that has a small made up home folder. Run with
// npm run test:pages.
import { defineConfig } from 'cypress';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import type { Settings, State } from '../../src/shared/types';

const ROOT = path.join(__dirname, '..', '..', 'dist', 'renderer');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve(): Promise<number> {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url || '/', 'http://x').pathname));
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

// What the main process sends as state, with every setting at its default.
// photos and loginItem.needsApproval are left out, so the pages read them
// as unset.
type Fixture = Omit<State, 'photos' | 'loginItem'> & { loginItem: { on: boolean } };

function filedrawerState(): Fixture {
  require('../support/electron');
  // From the build, which npm run test:pages makes first.
  const { DEFAULTS }: { DEFAULTS: Settings } = require('../../dist/main/settings');
  return {
    settings: JSON.parse(JSON.stringify(DEFAULTS)),
    system: { appearance: 'light', accent: '#007aff' },
    home: '/Users/test',
    cut: [],
    computer: '::computer',
    trash: '::trash',
    recents: '::recents',
    icloud: '::icloud',
    icloudOn: false,
    user: 'test',
    version: '9.9.9',
    loginItem: { on: false },
    update: { state: 'idle' },
    themes: [
      { id: 'system', name: 'System', schemes: [] },
      { id: 'classic-1995', name: 'Classic 1995', schemes: [['standard', 'Standard'], ['brick', 'Brick']] }
    ],
    finder: { accessibility: true, automation: 'allowed' },
    startbar: false,
    siblings: [
      { key: 'startbar', name: 'Startbar', desc: 'A taskbar.', installed: true, line: 'npm install -g startbar' },
      { key: 'shotdrawer', name: 'Shotdrawer', desc: 'Recent screenshots.', installed: false, line: 'npm install -g shotdrawer' }
    ],
    startFolder: '/Users/test',
    updateCommand: 'npm install -g filedrawer'
  };
}

// The functions the preload gives the pages, so the fake has the same ones.
function apiNames() {
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload.ts'), 'utf8');
  return [...preload.matchAll(/^  (\w+): /gm)].map((m) => m[1]);
}

export default defineConfig({
  video: false,
  screenshotsFolder: path.join(__dirname, 'screenshots'),
  downloadsFolder: path.join(__dirname, 'downloads'),
  fixturesFolder: false,
  e2e: {
    specPattern: path.join(__dirname, 'e2e', '*.cy.ts'),
    supportFile: path.join(__dirname, 'support', 'e2e.ts'),
    async setupNodeEvents(on, config) {
      config.env.pages = `http://127.0.0.1:${await serve()}`;
      on('task', { filedrawerState, apiNames });
      return config;
    }
  }
});
