// Cypress loads each renderer page on its own, served from src/renderer by
// a small server started here, with the preload's window.filedrawer replaced
// by a fake (support/fake.js) that has a small made up home folder. Run with
// npm run test:pages.
const { defineConfig } = require('cypress');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'src', 'renderer');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// What the main process sends as state, with every setting at its default.
function filedrawerState() {
  require('../support/electron');
  const { DEFAULTS } = require('../../src/main/settings');
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
    startFolder: '/Users/test'
  };
}

// The functions the preload gives the pages, so the fake has the same ones.
function apiNames() {
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload.js'), 'utf8');
  return [...preload.matchAll(/^  (\w+): /gm)].map((m) => m[1]);
}

module.exports = defineConfig({
  video: false,
  screenshotsFolder: path.join(__dirname, 'screenshots'),
  downloadsFolder: path.join(__dirname, 'downloads'),
  fixturesFolder: false,
  e2e: {
    specPattern: path.join(__dirname, 'e2e', '*.cy.js'),
    supportFile: path.join(__dirname, 'support', 'e2e.js'),
    async setupNodeEvents(on, config) {
      config.env.pages = `http://127.0.0.1:${await serve()}`;
      on('task', { filedrawerState, apiNames });
      return config;
    }
  }
});
