// Web Worker for Relate WebAssembly: snapshot download, graph ingest and Cypher queries stay off the main thread.
import init, { RelateDb } from '@relate/relate-wasm';
import { type Store, num } from '../src/core.js';
import { wasmStore } from './wasm-store.js';
import { ingest } from '../src/ingest.js';
import { fixOf, planTicket } from '../src/analyze.js';
import { checkChange } from '../src/check.js';
import { targetOf } from '../src/target.js';
import { decodeVectors } from '../src/vectors.js';
import type { RepoData } from '../src/github.js';

type DemoRepo = { name: string; file: string; eval?: string; issues: number; prs: number; note?: string };
type Snapshot = { data: RepoData; dim: number; vectors: string; scale: number };

let store: Store | null = null;
let manifest: DemoRepo[] = [];
const loaded = new Map<string, Promise<void>>();
let initPromise: Promise<void> | null = null;

function postStatus(text: string, state: 'loading' | 'ready' | 'error' = 'loading', repo?: string) {
  self.postMessage({ type: 'status', text, state, repo });
}

async function fetchStep(label: string, url: string): Promise<Response> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    throw new Error(`[${label}] ${url}: ${(e as Error).message}`);
  }
}

async function gunzipJson<T>(url: string): Promise<T> {
  let res = await fetchStep('snap-fetch', url);
  // Local dev only: some Windows download managers answer local .gz URLs with HTTP 204; serve-site.mjs has an alias.
  const u = new URL(url);
  if (res.status === 204 && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname.endsWith('.json.gz')) {
    const stem = u.pathname.split('/').pop()!.replace(/\.json\.gz$/, '');
    res = await fetchStep('snap-fetch-local', new URL(`/local-snap/${stem}`, u.origin).href);
  }
  if (res.status === 204) throw new Error(`[snap-204] ${url} returned HTTP 204`);
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (e) {
    throw new Error(`[snap-buf] ${url}: ${(e as Error).message}`);
  }
  if (!buf.byteLength) throw new Error(`[snap-empty] ${url} returned 0 bytes`);
  try {
    const bytes = new Uint8Array(buf);
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    const stream = isGzip
      ? new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
      : new Blob([buf]).stream();
    const text = await new Response(stream).text();
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`[snap-gunzip] ${url} (${buf.byteLength} bytes): ${(e as Error).message}`);
  }
}

async function ensureInit() {
  initPromise ??= (async () => {
    let step = 'start';
    try {
      const base = self.location.href;
      postStatus('Starting Relate WebAssembly in Web Worker…', 'loading');
      step = 'fetch-wasm';
      const wasmUrl = new URL('./relate_bg.wasm', base).href;
      const wasmRes = await fetchStep('wasm', wasmUrl);
      step = 'wasm-buf';
      const wasmBuf = await wasmRes.arrayBuffer();
      step = 'wasm-init';
      await init({ module_or_path: wasmBuf });
      step = 'new-db';
      store = wasmStore(new RelateDb());
      step = 'fetch-index';
      const idxUrl = new URL('./data/index.json', base).href;
      const idxRes = await fetchStep('index', idxUrl);
      step = 'index-json';
      manifest = await idxRes.json();
    } catch (e) {
      initPromise = null;
      throw new Error(`ensureInit@${step}: ${(e as Error).message}`);
    }
  })();
  return initPromise;
}

async function loadRepo(name: string) {
  await ensureInit();
  if (!loaded.has(name)) {
    loaded.set(name, (async () => {
      let step = 'find-repo';
      try {
        const r = manifest.find((x) => x.name === name);
        if (!r) throw new Error(`No demo data for ${name}`);
        postStatus(`Building ${name} Relate graph in background worker…`, 'loading', name);
        step = 'fetch-snap';
        const snapUrl = new URL(r.file, self.location.href).href;
        const snap = await gunzipJson<Snapshot>(snapUrl);
        step = 'decode-vec';
        const vectors = decodeVectors(snap.vectors, snap.dim, snap.scale);
        step = 'ingest';
        const t0 = performance.now();
        await ingest(store!, snap.data, (s) => postStatus(`Worker (${name}): ${s.trim()}`, 'loading', name), { vectors });
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        postStatus(`Live Relate WASM ready for ${name} (${sec} s in Web Worker)`, 'ready', name);
      } catch (e) {
        loaded.delete(name);
        throw new Error(`loadRepo@${step}: ${(e as Error).message}`);
      }
    })());
  }
  return loaded.get(name)!;
}

async function handleApi(path: string): Promise<unknown> {
  await ensureInit();
  const url = new URL(path, self.location.href);
  const p = (k: string) => (url.searchParams.get(k) ?? '').trim();
  if (url.pathname.endsWith('/api/repos')) {
    const repo = p('repo') || manifest[0].name;
    await loadRepo(repo);
    const s = store!;
    const examples = s.query(`MATCH (i:Issue) WHERE i.repo = $repo AND i.state = 'OPEN' RETURN i.number AS number, i.title AS title ORDER BY i.number DESC LIMIT 8`, { repo })
      .map((r) => ({ number: num(r.number), title: String(r.title) }));
    const counts = Object.fromEntries(s.query('MATCH (n) RETURN labels(n)[0] AS l, count(*) AS n').map((r) => [String(r.l), num(r.n)]));
    const rels = num(s.query('MATCH ()-[r]->() RETURN count(r) AS n')[0]?.n);
    return { repos: manifest.map((m) => ({ name: m.name, issues: m.issues, prs: m.prs, fetchedAt: '' })), examples, counts, rels, inBrowser: true };
  }
  if (url.pathname.endsWith('/api/plan')) {
    const repo = p('repo') || manifest[0].name;
    await loadRepo(repo);
    const target = targetOf(p('q'));
    const fix = 'issue' in target ? fixOf(store!, repo, target.issue) : null;
    if (p('replay') && fix) return { ...(await planTicket(store!, repo, target, { files: 12, asOf: fix.createdAt })), replay: fix };
    return { ...(await planTicket(store!, repo, target, { files: 12 })), canReplay: !!fix };
  }
  if (url.pathname.endsWith('/api/check')) {
    const repo = p('repo') || manifest[0].name;
    await loadRepo(repo);
    const r = await checkChange(store!, repo, targetOf(p('q')), p('files').split(/[\s,]+/).filter(Boolean));
    return { covered: r.covered, missing: r.missing, unexpected: r.unexpected, ok: r.ok };
  }
  if (url.pathname.endsWith('/api/eval')) {
    const r = manifest.find((x) => x.name === p('repo'));
    return r?.eval ? await (await fetchStep('eval', new URL(r.eval, self.location.href).href)).json() : null;
  }
  return { error: 'not found' };
}

self.addEventListener('message', async (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; id?: number; path?: string; repo?: string };
  if (msg.type === 'warmup') {
    try {
      await ensureInit();
      await loadRepo(msg.repo || manifest[0].name);
    } catch (e) {
      const err = e as Error;
      postStatus(`WASM worker error: ${err.message} | ${String(err.stack || '').slice(0, 220)}`, 'error', msg.repo);
    }
    return;
  }
  if (msg.type === 'api' && msg.id != null && msg.path) {
    try {
      const data = await handleApi(msg.path);
      self.postMessage({ type: 'result', id: msg.id, data });
    } catch (e) {
      self.postMessage({ type: 'result', id: msg.id, data: { error: (e as Error).message } });
    }
  }
});
