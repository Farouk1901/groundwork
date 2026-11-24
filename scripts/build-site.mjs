// Builds the static, in-browser demo into docs/ (served by GitHub Pages): the same page as `serve`, the same
// analysis code, Relate compiled to WebAssembly. Data comes from `groundwork export-web … --out docs`.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs');
const require = createRequire(import.meta.url);
mkdirSync(path.join(out, 'vendor'), { recursive: true });

// The browser has its own embedding module (Transformers.js from a CDN, loaded only for free-text questions).
const browserEmbed = {
  name: 'browser-embed',
  setup(b) {
    b.onResolve({ filter: /(^|\/)embed\.js$/ }, (a) => (a.importer.includes(`${path.sep}src${path.sep}`) ? { path: path.join(root, 'web', 'embed-browser.ts') } : undefined));
  },
};

await build({
  entryPoints: [path.join(root, 'web', 'browser.ts')],
  bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: true, sourcemap: false,
  outfile: path.join(out, 'app.js'), plugins: [browserEmbed], external: ['https://*'], logLevel: 'warning',
});
copyFileSync(require.resolve('@relate/relate-wasm/relate_bg.wasm'), path.join(out, 'relate_bg.wasm'));
copyFileSync(require.resolve('cytoscape/dist/cytoscape.min.js'), path.join(out, 'vendor', 'cytoscape.min.js'));
const page = readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  .replace('<head>', '<head>\n<script>window.GW_STATIC = true;</script>');
writeFileSync(path.join(out, 'index.html'), page);
writeFileSync(path.join(out, '.nojekyll'), '');
console.log('docs/ ready: index.html, app.js, relate_bg.wasm, vendor/, data/');
