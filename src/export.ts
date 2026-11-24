// Package a repository for the browser demo: the snapshot (bodies trimmed) plus the embeddings already in the
// graph, quantised to int8. The page rebuilds the graph from it with the same ingest code, inside Relate WASM.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import type { RepoData } from './github.js';
import { EMBED_DIM, type Store } from './core.js';

export function exportWeb(store: Store, data: RepoData, outDir: string, evalFile?: string) {
  const repo = data.repo;
  const keys = [...data.issues.map((i) => `${repo}#${i.number}`), ...data.prs.map((p) => `${repo}!${p.number}`)];
  const byKey = new Map<string, number[]>();
  for (const label of ['Issue', 'PR']) {
    for (const r of store.query(`MATCH (n:${label}) WHERE n.repo = $repo RETURN n.key AS k, n.embedding AS e`, { repo })) byKey.set(String(r.k), r.e as number[]);
  }
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length) throw new Error(`${missing.length} texts of ${repo} have no embedding in the graph: run "ingest" first.`);
  let maxAbs = 0;
  for (const k of keys) for (const x of byKey.get(k)!) maxAbs = Math.max(maxAbs, Math.abs(x));
  const scale = 127 / maxAbs;
  const bytes = new Int8Array(keys.length * EMBED_DIM);
  keys.forEach((k, i) => byKey.get(k)!.forEach((x, j) => { bytes[i * EMBED_DIM + j] = Math.round(x * scale); }));
  const trim = (s: string) => (s.length > 4000 ? s.slice(0, 4000) : s);
  const slim: RepoData = { ...data, issues: data.issues.map((i) => ({ ...i, body: trim(i.body) })), prs: data.prs.map((p) => ({ ...p, body: trim(p.body) })) };
  const payload = { data: slim, dim: EMBED_DIM, scale, vectors: Buffer.from(bytes.buffer).toString('base64') };
  mkdirSync(path.join(outDir, 'data'), { recursive: true });
  const base = repo.replace('/', '__');
  const file = path.join(outDir, 'data', `${base}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(payload), { level: 9 }));
  let evalRel: string | undefined;
  if (evalFile) { evalRel = `data/${base}.eval.json`; copyFileSync(evalFile, path.join(outDir, evalRel)); }
  return { name: repo, file: `data/${base}.json.gz`, eval: evalRel, issues: data.issues.length, prs: data.prs.length };
}
