// Builds the static, in-browser demo into docs/ (served by GitHub Pages):
// - docs/app.js: lightweight main-thread loader (instant pre-baked boot < 200 ms)
// - docs/worker.js: dedicated Web Worker running Relate WebAssembly off the main thread
// - docs/relate_bg.wasm, docs/vendor/cytoscape.min.js, docs/index.html
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs');
const require = createRequire(import.meta.url);
mkdirSync(path.join(out, 'vendor'), { recursive: true });

// The browser worker has its own embedding module (Transformers.js from a CDN, loaded only for free-text questions).
const browserEmbed = {
  name: 'browser-embed',
  setup(b) {
    b.onResolve({ filter: /(^|\/)embed\.js$/ }, (a) => (a.importer.includes(`${path.sep}src${path.sep}`) ? { path: path.join(root, 'web', 'embed-browser.ts') } : undefined));
  },
};

await Promise.all([
  build({
    entryPoints: [path.join(root, 'web', 'browser.ts')],
    bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: true, sourcemap: false,
    outfile: path.join(out, 'app.js'), logLevel: 'warning',
  }),
  build({
    entryPoints: [path.join(root, 'web', 'worker.ts')],
    bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: true, sourcemap: false,
    outfile: path.join(out, 'worker.js'), plugins: [browserEmbed], external: ['https://*'], logLevel: 'warning',
  }),
]);

copyFileSync(require.resolve('@relate/relate-wasm/relate_bg.wasm'), path.join(out, 'relate_bg.wasm'));
copyFileSync(require.resolve('cytoscape/dist/cytoscape.min.js'), path.join(out, 'vendor', 'cytoscape.min.js'));
// Keep docs/data/index.json clean (referencing only the canonical .json.gz snapshots, no duplicate binaries).
const idxPath = path.join(out, 'data', 'index.json');
const idx = JSON.parse(readFileSync(idxPath, 'utf8')).map(({ browserFile: _drop, ...entry }) => entry);
writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n');
const page = readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  .replace('<head>', '<head>\n<script>window.GW_STATIC = true;</script>');
writeFileSync(path.join(out, 'index.html'), page);
writeFileSync(path.join(out, '.nojekyll'), '');
console.log('docs/ ready: index.html, app.js, worker.js, relate_bg.wasm, vendor/, data/');
