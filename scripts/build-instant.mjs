#!/usr/bin/env node
// Builds docs/data/instant.json from the real graph, so the demo shows hono#2550 (Replay) and samples from vitest and
// relatedb/relate in < 200 ms while the worker loads Relate WASM.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, openStore } from '../src/store.js';
import { fixOf, planTicket } from '../src/analyze.js';
import { targetOf } from '../src/target.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'docs', 'data', 'index.json'), 'utf8'));
const store = openStore();

const reposOut = {};
const plansOut = {};

async function cachePlan(repo, q, replay = false) {
  const target = targetOf(q);
  const fix = 'issue' in target ? fixOf(store, repo, target.issue) : null;
  const key = `${repo}|${q}|${replay ? '1' : '0'}`;
  if (replay && fix) {
    plansOut[key] = { ...(await planTicket(store, repo, target, { files: 12, asOf: fix.createdAt })), replay: fix };
  } else {
    plansOut[key] = { ...(await planTicket(store, repo, target, { files: 12 })), canReplay: !!fix };
  }
}

for (const m of manifest) {
  const repo = m.name;
  const examples = store.query(
    `MATCH (i:Issue) WHERE i.repo = $repo AND i.state = 'OPEN' RETURN i.number AS number, i.title AS title ORDER BY i.number DESC LIMIT 8`,
    { repo },
  ).map((r) => ({ number: num(r.number), title: String(r.title) }));

  // Per-repo counts match what the WASM worker reports when that repo is loaded.
  const counts = {
    Issue: num(store.query('MATCH (i:Issue) WHERE i.repo = $repo RETURN count(i) AS n', { repo })[0]?.n),
    PR: num(store.query('MATCH (p:PR) WHERE p.repo = $repo RETURN count(p) AS n', { repo })[0]?.n),
    File: num(store.query('MATCH (f:File) WHERE f.repo = $repo RETURN count(f) AS n', { repo })[0]?.n),
    Person: num(store.query('MATCH (p:Person)-[:AUTHORED]->(x:PR) WHERE x.repo = $repo RETURN count(DISTINCT p) AS n', { repo })[0]?.n),
  };
  const rels = num(store.query('MATCH (a)-[r]->(b) WHERE a.repo = $repo OR b.repo = $repo RETURN count(r) AS n', { repo })[0]?.n);

  reposOut[repo] = {
    repos: manifest.map((x) => ({ name: x.name, issues: x.issues, prs: x.prs, fetchedAt: '' })),
    examples,
    counts,
    rels,
    inBrowser: true,
  };

  // The first open example of every repo.
  if (examples[0]) await cachePlan(repo, String(examples[0].number), false);
}

await cachePlan('honojs/hono', '2550', true);
await cachePlan('honojs/hono', '2550', false);
await cachePlan('honojs/hono', '5601', false);

// The newest small vitest fix, replayed and live.
const vitestClosed = store.query(
  `MATCH (p:PR)-[:FIXES]->(i:Issue) WHERE i.repo = 'vitest-dev/vitest' AND p.fileCount <= 10 RETURN i.number AS n ORDER BY i.createdAt DESC LIMIT 1`,
)[0];
if (vitestClosed) {
  await cachePlan('vitest-dev/vitest', String(num(vitestClosed.n)), true);
  await cachePlan('vitest-dev/vitest', String(num(vitestClosed.n)), false);
}
await cachePlan('vitest-dev/vitest', 'Coverage report is missing files that are only imported inside worker threads', false);

await cachePlan('relatedb/relate', 'Full-text index ignores accented characters when matching words', false);

const out = {
  generatedAt: new Date().toISOString(),
  defaultView: { repo: 'honojs/hono', q: '2550', replay: true },
  repos: reposOut,
  plans: plansOut,
};

const outPath = path.join(root, 'docs', 'data', 'instant.json');
writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${path.relative(root, outPath)} (${Object.keys(plansOut).length} pre-baked plans, ${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1)} KB)`);
