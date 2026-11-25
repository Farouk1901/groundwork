#!/usr/bin/env node
// Startup benchmark of docs/ in headless Chrome (DevTools Protocol): first paint, FCP, the hono#2550 Replay render
// time and main-thread long tasks.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('Chrome/Chromium executable not found. Set CHROME_PATH env var.');
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.gz': 'application/octet-stream',
  '.css': 'text/css',
};

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  const file = path.join(docsDir, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(docsDir)) { res.writeHead(403); return res.end(); }
  try {
    const b = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    return res.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/`;
const dbgPort = 9420 + Math.floor(Math.random() * 500);
const profileDir = mkdtempSync(path.join(tmpdir(), 'gw-bench-'));
const chrome = spawn(findChrome(), [
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${dbgPort}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

try {
  await waitHttp(`http://127.0.0.1:${dbgPort}/json/version`);
  const targets = await fetch(`http://127.0.0.1:${dbgPort}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__gwLongTasks = [];
      window.__gwPlanMs = null;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__gwLongTasks.push(Math.round(e.duration));
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
      const mo = new MutationObserver(() => {
        if (window.__gwPlanMs === null && document.querySelectorAll('#files li.file').length > 0) {
          window.__gwPlanMs = Math.round(performance.now());
          mo.disconnect();
        }
      });
      document.addEventListener('DOMContentLoaded', () => {
        if (document.querySelectorAll('#files li.file').length > 0) window.__gwPlanMs = Math.round(performance.now());
        else mo.observe(document.documentElement, { childList: true, subtree: true });
      });
    `,
  });

  const runs = Number(process.env.RUNS || 3);
  const samples = [];
  for (let i = 0; i < runs; i++) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(150);
    await cdp.send('Page.navigate', { url: baseUrl });
    for (let t = 0; t < 50; t++) {
      const done = await cdp.eval(`window.__gwPlanMs !== null`);
      if (done) break;
      await sleep(100);
    }
    // Let the graph layout and worker warmup settle, so their long tasks are counted.
    await sleep(600);
    const m = await cdp.eval(`(() => {
      const paints = performance.getEntriesByType('paint');
      const fp = paints.find((p) => p.name === 'first-paint')?.startTime;
      const fcp = paints.find((p) => p.name === 'first-contentful-paint')?.startTime;
      const topFile = document.querySelector('#files li.file .path')?.textContent?.trim() || '';
      const tasks = window.__gwLongTasks || [];
      return {
        firstPaintMs: fp ? Math.round(fp) : null,
        fcpMs: fcp ? Math.round(fcp) : null,
        instantPlanRenderedMs: window.__gwPlanMs,
        maxLongTaskMs: tasks.length ? Math.max(...tasks) : 0,
        longTasksOver200ms: tasks.filter((d) => d > 200),
        topFile,
      };
    })()`);
    samples.push(m);
  }
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const summary = {
    runs,
    medianFirstPaintMs: median(samples.map((s) => s.firstPaintMs ?? 0)),
    medianFcpMs: median(samples.map((s) => s.fcpMs ?? 0)),
    medianInstantPlanMs: median(samples.map((s) => s.instantPlanRenderedMs ?? 0)),
    maxLongTaskMs: Math.max(...samples.map((s) => s.maxLongTaskMs)),
    anyLongTaskOver200ms: samples.some((s) => s.longTasksOver200ms.length > 0),
    topFile: samples[0]?.topFile,
    samples,
  };
  console.log(JSON.stringify(summary, null, 2));
  cdp.close();
} finally {
  try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
  server.close();
  await sleep(300);
  rmSync(profileDir, { recursive: true, force: true });
}
