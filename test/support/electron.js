// A stand-in for Electron in the unit tests, which run in plain Node. Once
// this is loaded, a module that requires 'electron' gets it instead.
// app.getPath('appData') answers with the temp folder from the last
// tempAppData().
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const paths = {};
const made = [];

const app = {
  getPath: (name) => {
    if (!paths[name]) throw new Error(`no test path for ${name}, call tempAppData() first`);
    return paths[name];
  }
};

// Named by a path of its own, so the tests run without Electron installed.
const id = path.join(__dirname, 'electron-stand-in.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? id : resolve.call(this, request, ...rest);
};
const stub = new Module(id);
stub.filename = id;
stub.loaded = true;
stub.exports = { app };
require.cache[id] = stub;

// A new empty folder to stand in for ~/Library/Application Support.
function tempAppData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filedrawer-test-'));
  made.push(dir);
  paths.appData = dir;
  return dir;
}

process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A new empty folder for a test to work in, gone when the tests end.
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filedrawer-test-'));
  made.push(dir);
  return dir;
}

module.exports = { app, tempAppData, tempDir };
