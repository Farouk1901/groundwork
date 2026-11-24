// Serve docs/ locally, the way GitHub Pages will: `node scripts/serve-site.mjs` then open http://127.0.0.1:8080
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.gz': 'application/gzip', '.css': 'text/css' };
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const b = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Groundwork demo on http://127.0.0.1:${port}`));
