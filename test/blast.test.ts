import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywords, blastRadius } from '../src/analyze.ts';
import { ingest, mentionedIssues, moduleOf, namedFiles } from '../src/ingest.ts';
import { openStore } from '../src/store.ts';
import { readOnlyCypher } from '../src/mcp.ts';
import type { RepoData } from '../src/github.ts';

test('helpers: modules, named files, mentions, keywords', () => {
  assert.equal(moduleOf('src/middleware/cors/index.ts'), 'src/middleware');
  assert.equal(moduleOf('README.md'), '(root)');
  assert.equal(moduleOf('docs/guide.md'), 'docs');
  const files = ['src/utils/cookie.ts', 'src/utils/cookie.test.ts', 'src/a/index.ts', 'src/b/index.ts'];
  assert.deepEqual(namedFiles('The bug is in cookie.ts when parsing', files), ['src/utils/cookie.ts']);
  assert.deepEqual(namedFiles('see index.ts', files), []); // ambiguous name
  assert.deepEqual(namedFiles('look at src/b/index.ts please', files), ['src/b/index.ts']);
  assert.deepEqual(mentionedIssues('dup of #12, related (#30) and #7', 7), [12, 30]);
  assert.equal(keywords('The CORS middleware fails when origin is a function!'), 'cors middleware origin function');
});

const data: RepoData = {
  repo: 'acme/shop', fetchedAt: '2026-11-14T00:00:00Z',
  issues: [
    { number: 1, title: 'Cookie parser drops values with equals sign', body: 'cookie.ts splits on =', state: 'CLOSED', url: 'u1', createdAt: '2026-01-01', closedAt: '2026-01-03', author: 'ann', labels: ['bug'] },
    { number: 2, title: 'Cart total wrong with discount codes', body: 'checkout shows the old total', state: 'CLOSED', url: 'u2', createdAt: '2026-02-01', closedAt: '2026-02-04', author: 'bob', labels: ['bug'] },
    { number: 3, title: 'Cookie with equals in value breaks session', body: 'Session cookie value contains = and gets cut', state: 'OPEN', url: 'u3', createdAt: '2026-03-01', closedAt: null, author: 'cy', labels: [] },
    { number: 4, title: 'Session expires too early', body: 'related to #3, see session.ts', state: 'OPEN', url: 'u4', createdAt: '2026-03-02', closedAt: null, author: 'dee', labels: [] },
  ],
  prs: [
    { number: 10, title: 'fix(cookie): keep = in cookie values', body: 'Fixes #1', url: 'p10', mergedAt: '2026-01-03', author: 'ann', labels: [], closes: [1],
      files: [{ path: 'src/http/cookie.ts', additions: 4, deletions: 1 }, { path: 'src/http/cookie.test.ts', additions: 20, deletions: 0 }, { path: 'src/http/session.ts', additions: 1, deletions: 1 }] },
    { number: 11, title: 'cookie: support quoted values', body: '', url: 'p11', mergedAt: '2026-01-20', author: 'ann', labels: [], closes: [],
      files: [{ path: 'src/http/cookie.ts', additions: 6, deletions: 2 }, { path: 'src/http/cookie.test.ts', additions: 10, deletions: 0 }] },
    { number: 12, title: 'fix(cart): apply discount before tax', body: 'closes #2', url: 'p12', mergedAt: '2026-02-04', author: 'bob', labels: [], closes: [],
      files: [{ path: 'src/cart/total.ts', additions: 5, deletions: 5 }, { path: 'package.json', additions: 1, deletions: 1 }] },
  ],
};

test('ingest + blast radius on a small graph', async () => {
  const store = openStore(':memory:');
  const r = await ingest(store, data);
  assert.equal(r.issues, 4);
  assert.equal(r.fixes, 2); // closingIssuesReferences + "closes #2" in the body
  assert.equal(r.coChange, 1); // cookie.ts + cookie.test.ts changed together twice

  const b = await blastRadius(store, 'acme/shop', { issue: 3 });
  assert.equal(b.files[0].path, 'src/http/cookie.ts');
  assert.ok(b.files.some((f) => f.path === 'src/http/cookie.test.ts'));
  assert.ok(!b.files.slice(0, 2).some((f) => f.path.startsWith('src/cart')));
  assert.ok(b.files[0].reasons.some((x) => x.kind === 'similar-issue' && x.text.includes('#1')));
  assert.equal(b.experts[0].login, 'ann');
  assert.ok(b.similar.some((s) => s.kind === 'issue' && s.number === 1));
  assert.ok(b.graph.nodes.some((n) => n.type === 'target') && b.graph.edges.length > 0);

  const t = await blastRadius(store, 'acme/shop', { text: 'discount total is wrong at checkout' });
  assert.equal(t.files[0].path, 'src/cart/total.ts');
  assert.ok(!t.files.slice(0, 1).some((f) => f.path === 'package.json'));

  await assert.rejects(blastRadius(store, 'acme/shop', { issue: 999 }), /not in the graph/);
});

test('agents get read-only Cypher', () => {
  const store = openStore(':memory:');
  assert.throws(() => readOnlyCypher(store, 'MATCH (n) DETACH DELETE n'), /read queries/);
  assert.throws(() => readOnlyCypher(store, "CREATE (:X)"), /read queries/);
  assert.equal(JSON.parse(readOnlyCypher(store, 'RETURN 1 + 1 AS two'))[0].two, 2);
});
