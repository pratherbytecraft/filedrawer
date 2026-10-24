// Builds dist/, which is what the npm package ships: the main process, the
// preload, bin and scripts one file each as CommonJS, in the same layout as
// the source so their paths to assets, the helper and package.json hold,
// and the pages' scripts one file each next to their HTML and CSS. The
// window page's scripts share globals, so they stay plain scripts, loaded
// by the page in order. Checking the types is tsc's job (npm run
// typecheck); this only writes JavaScript.
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const SOURCE = /\.[jt]s$/;
const isSource = (f: string) => SOURCE.test(f) && !f.endsWith('.d.ts');

// esbuild's { in, out } for each source file in a folder, out being the
// output's path in dist/ without its extension.
function entries(dir: string, outDir: string, skip: string[] = []) {
  return fs.readdirSync(path.join(root, dir))
    .filter((f) => isSource(f) && !skip.includes(f))
    .map((f) => ({ in: path.join(root, dir, f), out: path.join(outDir, f.replace(SOURCE, '')) }));
}

// Every page script, in every folder under src/renderer.
function pageScripts(dir = 'src/renderer', outDir = 'renderer'): { in: string; out: string }[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => d.isDirectory()
    ? pageScripts(path.join(dir, d.name), path.join(outDir, d.name))
    : isSource(d.name) ? [{ in: path.join(root, dir, d.name), out: path.join(outDir, d.name.replace(SOURCE, '')) }] : []);
}

// The pages' HTML and CSS, as they are.
function copyPageFiles(from: string, to: string) {
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    if (d.isDirectory()) copyPageFiles(path.join(from, d.name), path.join(to, d.name));
    else if (/\.(html|css)$/.test(d.name)) {
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(path.join(from, d.name), path.join(to, d.name));
    }
  }
}

async function build() {
  fs.rmSync(dist, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [
      ...entries('src/main', 'main'),
      // The preload, the only file directly in src.
      ...entries('src', ''),
      ...entries('src/bin', 'bin'),
      ...entries('src/scripts', 'scripts')
    ],
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'warning'
  });
  await esbuild.build({
    entryPoints: pageScripts(),
    outdir: dist,
    platform: 'browser',
    // Electron 33's Chromium.
    target: 'chrome130',
    logLevel: 'warning'
  });
  copyPageFiles(path.join(root, 'src', 'renderer'), path.join(dist, 'renderer'));
  for (const f of fs.readdirSync(path.join(dist, 'bin'))) fs.chmodSync(path.join(dist, 'bin', f), 0o755);
}

build().catch(() => process.exit(1));
