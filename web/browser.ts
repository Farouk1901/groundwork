// Groundwork in the browser: Relate compiled to WebAssembly, the graph built in the page from a snapshot of the
// repository (with its embeddings precomputed), and the very same planTicket / checkChange code as the CLI.
// It answers the same /api/* calls as the local server, so public/index.html works unchanged on top of it.
import init, { RelateDb } from '@relate/relate-wasm';
import { SCHEMA, type Row, type Store, num } from '../src/core.js';
import { ingest } from '../src/ingest.js';
import { fixOf, planTicket } from '../src/analyze.js';
import { checkChange } from '../src/check.js';
import { targetOf } from '../src/target.js';
import { decodeVectors } from '../src/vectors.js';
import type { RepoData } from '../src/github.js';

export type DemoRepo = { name: string; file: string; eval?: string; issues: number; prs: number; note?: string };
type Snapshot = { data: RepoData; dim: number; vectors: string; scale: number };

let store: Store | null = null;
let manifest: DemoRepo[] = [];
const loaded = new Map<string, Promise<void>>();
let status: (s: string) => void = () => {};

export function wasmStore(db: RelateDb): Store {
  const query = (cypher: string, params?: Record<string, unknown>): Row[] => {
    const p = params && Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const r = JSON.parse(db.execute(cypher, p ? JSON.stringify(p) : null)) as { rows: Row[]; error: unknown };
    if (r.error) throw new Error(typeof r.error === 'string' ? r.error : (r.error as { message?: string }).message ?? JSON.stringify(r.error));
    return r.rows;
  };
  for (const s of SCHEMA) query(s);
  return { query, close: () => db.free(), path: 'relate-wasm (in this tab)', nativeHybrid: false };
}

async function gunzipJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = url.endsWith('.gz') ? res.body!.pipeThrough(new DecompressionStream('gzip')) : res.body!;
  return JSON.parse(await new Response(body).text()) as T;
}

async function loadRepo(name: string) {
  if (!loaded.has(name)) loaded.set(name, (async () => {
    const r = manifest.find((x) => x.name === name);
    if (!r) throw new Error(`No demo data for ${name}`);
    status(`Downloading ${name} (${r.issues.toLocaleString('en-US')} tickets, ${r.prs.toLocaleString('en-US')} PRs)…`);
    const snap = await gunzipJson<Snapshot>(r.file);
    const vectors = decodeVectors(snap.vectors, snap.dim, snap.scale);
    status(`Building the Relate graph for ${name} in this tab…`);
    await new Promise((ok) => setTimeout(ok, 30));
    const t0 = performance.now();
    await ingest(store!, snap.data, (s) => status(s.trim()), { vectors });
    status(`Graph for ${name} built in ${((performance.now() - t0) / 1000).toFixed(1)} s, all in this browser tab.`);
  })());
  return loaded.get(name)!;
}

export async function ready(onStatus: (s: string) => void) {
  status = onStatus;
  status('Starting Relate (WebAssembly)…');
  await init({ module_or_path: new URL('./relate_bg.wasm', import.meta.url) });
  store = wasmStore(new RelateDb());
  manifest = await (await fetch('data/index.json')).json();
  await loadRepo(manifest[0].name);
}

export async function api(path: string): Promise<unknown> {
  const url = new URL(path, location.href);
  const p = (k: string) => (url.searchParams.get(k) ?? '').trim();
  try {
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
      await loadRepo(p('repo'));
      const target = targetOf(p('q'));
      const fix = 'issue' in target ? fixOf(store!, p('repo'), target.issue) : null;
      if (p('replay') && fix) return { ...(await planTicket(store!, p('repo'), target, { files: 12, asOf: fix.createdAt })), replay: fix };
      return { ...(await planTicket(store!, p('repo'), target, { files: 12 })), canReplay: !!fix };
    }
    if (url.pathname.endsWith('/api/check')) {
      await loadRepo(p('repo'));
      const r = await checkChange(store!, p('repo'), targetOf(p('q')), p('files').split(/[\s,]+/).filter(Boolean));
      return { covered: r.covered, missing: r.missing, unexpected: r.unexpected, ok: r.ok };
    }
    if (url.pathname.endsWith('/api/eval')) {
      const r = manifest.find((x) => x.name === p('repo'));
      return r?.eval ? await (await fetch(r.eval)).json() : null;
    }
    return { error: 'not found' };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
