import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keywords, planTicket, toMarkdown } from '../src/analyze.ts';
import { ingest, mentionedIssues, moduleOf, namedFiles } from '../src/ingest.ts';
import { openStore, type Store } from '../src/store.ts';
import { readOnlyCypher, whoKnows } from '../src/mcp.ts';
import { checkChange, checkMarkdown } from '../src/check.ts';
import { backtest, cases, evalMarkdown, prCases } from '../src/eval.ts';
import { adfText, fromJiraJson, ingestJira, jiraKeys } from '../src/jira.ts';
import { readSnapshot, targetOf } from '../src/util.ts';
import type { RepoData } from '../src/github.ts';

test('helpers: modules, named files, mentions, keywords, targets', () => {
  assert.equal(moduleOf('src/middleware/cors/index.ts'), 'src/middleware');
  assert.equal(moduleOf('README.md'), '(root)');
  assert.equal(moduleOf('docs/guide.md'), 'docs');
  const files = ['src/utils/cookie.ts', 'src/utils/cookie.test.ts', 'src/a/index.ts', 'src/b/index.ts'];
  assert.deepEqual(namedFiles('The bug is in cookie.ts when parsing', files), ['src/utils/cookie.ts']);
  assert.deepEqual(namedFiles('see index.ts', files), []); // ambiguous name
  assert.deepEqual(namedFiles('look at src/b/index.ts please', files), ['src/b/index.ts']);
  assert.deepEqual(mentionedIssues('dup of #12, related (#30) and #7', 7), [12, 30]);
  assert.equal(keywords('The CORS middleware fails when origin is a function!'), 'cors middleware origin function');
  assert.deepEqual(targetOf('#42'), { issue: 42 });
  assert.deepEqual(targetOf('SHOP-7'), { issue: 'SHOP-7' });
  assert.deepEqual(targetOf('cookie values get cut'), { text: 'cookie values get cut' });
});

const iss = (number: number, title: string, body: string, state: 'OPEN' | 'CLOSED', createdAt: string, author: string, labels: string[] = []) =>
  ({ number, title, body, state, url: `https://github.com/acme/shop/issues/${number}`, createdAt, closedAt: state === 'CLOSED' ? createdAt : null, author, labels });
const pr = (number: number, title: string, body: string, mergedAt: string, author: string, files: string[], closes: number[] = []) =>
  ({ number, title, body, url: `https://github.com/acme/shop/pull/${number}`, mergedAt, author, labels: [], closes, files: files.map((path) => ({ path, additions: 3, deletions: 1 })) });

const data: RepoData = {
  repo: 'acme/shop', fetchedAt: '2026-11-14T00:00:00Z',
  issues: [
    iss(1, 'Cookie parser drops values with equals sign', 'cookie.ts splits on =', 'CLOSED', '2026-01-01T00:00:00Z', 'ann', ['bug']),
    iss(2, 'Cart total wrong with discount codes', 'checkout shows the old total', 'CLOSED', '2026-02-01T00:00:00Z', 'bob', ['bug']),
    iss(3, 'Cookie with equals in value breaks session', 'Session cookie value contains = and gets cut', 'OPEN', '2026-03-01T00:00:00Z', 'cy'),
    iss(4, 'Session expires too early', 'related to #3, see session.ts', 'OPEN', '2026-03-02T00:00:00Z', 'dee'),
    iss(5, 'Cookie value with equals sign is truncated again', 'A cookie value containing = is cut after the first =', 'CLOSED', '2026-04-01T00:00:00Z', 'eve', ['bug']),
  ],
  prs: [
    pr(10, 'fix(cookie): keep = in cookie values', 'Fixes #1', '2026-01-03T00:00:00Z', 'ann', ['src/http/cookie.ts', 'src/http/cookie.test.ts', 'src/http/session.ts'], [1]),
    pr(11, 'cookie: support quoted values', '', '2026-01-20T00:00:00Z', 'ann', ['src/http/cookie.ts', 'src/http/cookie.test.ts']),
    pr(12, 'fix(cart): apply discount before tax', 'closes #2', '2026-02-04T00:00:00Z', 'bob', ['src/cart/total.ts', 'package.json']),
    // The fix of #5 merged after #5 was opened: a replay of #5 must not see it.
    pr(13, 'fix: cookie values truncated at second equals', 'fixes #5', '2026-04-03T00:00:00Z', 'fay', ['src/http/cookie.ts', 'src/http/cookie.test.ts', 'src/http/parse-header.ts']),
  ],
};

let shared: Store | undefined;
async function graph() {
  if (!shared) { shared = openStore(':memory:'); await ingest(shared, data); }
  return shared;
}

test('ingest + groundwork on a small graph', async () => {
  const store = openStore(':memory:');
  const r = await ingest(store, data);
  assert.equal(r.issues, 5);
  assert.equal(r.fixes, 3); // closingIssuesReferences + "closes #2" / "fixes #5" in the body
  assert.equal(r.coChange, 1); // cookie.ts + cookie.test.ts changed together 3 times

  const b = await planTicket(store, 'acme/shop', { issue: 3 });
  assert.equal(b.files[0].path, 'src/http/cookie.ts');
  assert.ok(b.files.some((f) => f.path === 'src/http/cookie.test.ts'));
  assert.ok(!b.files.slice(0, 2).some((f) => f.path.startsWith('src/cart')));
  assert.ok(b.files[0].reasons.some((x) => x.kind === 'similar-issue' && x.text.includes('#1')));
  assert.ok(['ann', 'fay'].includes(b.experts[0].login));
  assert.ok(b.similar.some((s) => s.kind === 'issue' && s.number === 1));
  assert.equal(b.target.kind === 'issue' && b.target.ref, '#3');
  // The explanation is a real path: target -SIMILAR-> ticket <-FIXES- PR -TOUCHES-> file.
  const e = (from: string, to: string) => b.graph.edges.some((x) => x.from === from && x.to === to);
  assert.ok(e('issue:3', 'issue:1') && e('pr:10', 'issue:1') && e('pr:10', 'file:src/http/cookie.ts'));
  assert.match(toMarkdown(b), /Files most likely to change/);

  const t = await planTicket(store, 'acme/shop', { text: 'discount total is wrong at checkout' });
  assert.equal(t.files[0].path, 'src/cart/total.ts');
  assert.ok(!t.files.slice(0, 1).some((f) => f.path === 'package.json'));

  await assert.rejects(planTicket(store, 'acme/shop', { issue: 999 }), /not in the graph/);
});

test('a ticket with a fix reports it live, but a replay as of its creation cannot see it', async () => {
  const store = await graph();
  const live = await planTicket(store, 'acme/shop', { issue: 5 });
  assert.ok(live.files.some((f) => f.reasons.some((r) => r.kind === 'fixed-by')));
  assert.ok(live.files.some((f) => f.path === 'src/http/parse-header.ts'));

  const replay = await planTicket(store, 'acme/shop', { issue: 5 }, { asOf: '2026-04-01T00:00:00Z' });
  assert.ok(!replay.files.some((f) => f.reasons.some((r) => r.kind === 'fixed-by')));
  assert.ok(!replay.files.some((f) => f.path === 'src/http/parse-header.ts'), 'only PR #13 ever touched it, and it merged later');
  assert.ok(!replay.experts.some((e) => e.login === 'fay'));
  assert.equal(replay.files[0].path, 'src/http/cookie.ts'); // still found, from the past fix of #1
});

test('ablations switch parts off', async () => {
  const store = await graph();
  const noCo = await planTicket(store, 'acme/shop', { issue: 3 }, { use: { coChange: false } });
  assert.ok(!noCo.files.some((f) => f.reasons.some((r) => r.kind === 'co-change')));
  const noIssues = await planTicket(store, 'acme/shop', { issue: 3 }, { use: { issues: false } });
  assert.ok(!noIssues.files.some((f) => f.reasons.some((r) => r.kind === 'similar-issue')));
  const ftOnly = await planTicket(store, 'acme/shop', { text: 'cookie equals value' }, { use: { vector: false } });
  assert.ok(ftOnly.similar.length > 0);
});

test('check: covered, missing and unexpected files', async () => {
  const store = await graph();
  const r = await checkChange(store, 'acme/shop', { issue: 3 }, ['src/http/cookie.ts', 'src/admin/new-page.ts']);
  assert.deepEqual(r.covered.map((f) => f.path), ['src/http/cookie.ts']);
  assert.ok(r.missing.some((f) => f.path === 'src/http/cookie.test.ts' && f.test));
  assert.deepEqual(r.unexpected, [{ path: 'src/admin/new-page.ts', seenBefore: false }]);
  assert.equal(r.ok, false);
  assert.match(checkMarkdown(r), /Probably missing/);

  const full = await checkChange(store, 'acme/shop', { issue: 3 }, ['src/http/cookie.ts', 'src/http/cookie.test.ts', 'src/http/session.ts', 'src/http/parse-header.ts']);
  assert.equal(full.ok, true);
});

test('backtest: cases only from tickets with history, scored against baselines', async () => {
  const store = await graph();
  const { cases: cs } = cases(store, 'acme/shop', { minHistory: 1 });
  // #5 (fixed by #13, after #10-#12) and #2 (after #10, #11) have history; nothing was merged before #1.
  assert.deepEqual(cs.map((c) => c.issue).sort(), [2, 5]);
  const five = cs.find((c) => c.issue === 5)!;
  assert.deepEqual(five.truth.sort(), ['src/http/cookie.test.ts', 'src/http/cookie.ts', 'src/http/parse-header.ts']);
  assert.deepEqual(five.known.sort(), ['src/http/cookie.test.ts', 'src/http/cookie.ts']);

  // Tune on the older half, report on the newer one: the two never overlap.
  assert.deepEqual(cases(store, 'acme/shop', { minHistory: 1, split: 'newer' }).cases.map((c) => c.issue), [5]);
  assert.deepEqual(cases(store, 'acme/shop', { minHistory: 1, split: 'older' }).cases.map((c) => c.issue), [2]);

  // PR mode: each merged PR predicted from its title, with itself and later PRs hidden; #10 has no history.
  const prs = prCases(store, 'acme/shop', { minHistory: 1 }).cases;
  assert.deepEqual(prs.map((c) => c.issue), [13, 12, 11]);
  assert.deepEqual(prs.find((c) => c.issue === 12)!.known, []); // total.ts was new in #12
  const pr = await backtest(store, 'acme/shop', { minHistory: 1, mode: 'prs', ablations: false });
  assert.equal(pr.mode, 'prs');
  assert.equal(pr.cases, 3);
  assert.ok(pr.results[0].hit5 > 0, 'cookie PRs are found from earlier cookie PRs');

  assert.equal((await backtest(store, 'acme/shop', { ablations: false })).cases, 0); // the default needs 50 earlier PRs
  const r = await backtest(store, 'acme/shop', { minHistory: 1 });
  assert.equal(r.cases, 2);
  const full = r.results.find((x) => x.name === 'Groundwork (full)')!;
  assert.equal(full.hit5, 50); // #5: cookie.ts found from the fix of #1; #2: total.ts was never touched before
  assert.ok(r.results.some((x) => x.name.startsWith('Baseline')));
  assert.equal(r.results.find((x) => x.name.startsWith('Ceiling'))!.recall10, 33.3); // (2/3 + 0/1) / 2
});

test('jira: ADF text, keys in PR titles, tickets linked to the PRs that name them', async () => {
  assert.equal(adfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cookie ' }, { type: 'text', text: 'cut at =' }] }] }), 'Cookie cut at =');
  assert.deepEqual(jiraKeys('SHOP-12: fix cookie (see SHOP-12, SHOP-3; not SHOPX-1)', 'SHOP'), ['SHOP-12', 'SHOP-3']);
  const tickets = fromJiraJson([
    { key: 'SHOP-12', fields: { summary: 'Cookie value cut at equals sign', description: 'in cookie.ts', status: { statusCategory: { key: 'done' } }, created: '2026-01-02T10:00:00.000+0000', resolutiondate: '2026-01-04T10:00:00.000+0000', labels: ['bug'] } },
    { key: 'SHOP-20', fields: { summary: 'Session cookie broken after login', description: null, status: { statusCategory: { key: 'indeterminate' } }, created: '2026-05-01T10:00:00.000+0000' } },
  ], 'acme.atlassian.net');
  assert.equal(tickets[0].status, 'CLOSED');
  assert.equal(tickets[1].status, 'OPEN');
  assert.equal(tickets[0].url, 'https://acme.atlassian.net/browse/SHOP-12');

  const store = openStore(':memory:');
  const d = structuredClone(data);
  d.prs[1].title = 'SHOP-12: cookie: support quoted values';
  await ingest(store, d);
  const r = await ingestJira(store, 'acme/shop', tickets);
  assert.equal(r.tickets, 2);
  assert.equal(r.fixes, 1);
  const p = await planTicket(store, 'acme/shop', { issue: 'SHOP-20' });
  assert.equal(p.target.kind === 'issue' && p.target.ref, 'SHOP-20');
  assert.ok(p.files.some((f) => f.path === 'src/http/cookie.ts'));
});

test('snapshots load plain or gzipped (judges need no GitHub token)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-'));
  writeFileSync(path.join(dir, 'a.json'), JSON.stringify(data));
  writeFileSync(path.join(dir, 'a.json.gz'), gzipSync(JSON.stringify(data)));
  assert.equal(readSnapshot(path.join(dir, 'a.json')).data.prs.length, 4);
  assert.equal(readSnapshot(path.join(dir, 'a.json.gz')).data.issues.length, 5);
});

test('agents get read-only Cypher and who-knows', async () => {
  const store = await graph();
  assert.throws(() => readOnlyCypher(store, 'MATCH (n) DETACH DELETE n'), /read queries/);
  assert.throws(() => readOnlyCypher(store, 'CREATE (:X)'), /read queries/);
  assert.equal(JSON.parse(readOnlyCypher(store, 'RETURN 1 + 1 AS two'))[0].two, 2);
  assert.match(whoKnows(store, 'acme/shop', 'src/http'), /@ann: 2 merged PRs/);
});

test('eval markdown renders a table', () => {
  const md = evalMarkdown({ repo: 'a/b', at: '', cases: 1, skipped: 0, k: 10, examples: [],
    results: [{ name: 'Groundwork (full)', cases: 1, hit5: 100, hit10: 100, recall5: 50, recall10: 50, mrr: 1, ms: 3 },
      { name: 'Ceiling (files seen before)', cases: 1, hit5: NaN, hit10: NaN, recall5: NaN, recall10: 80, mrr: NaN, ms: 0 }] });
  assert.match(md, /\| Groundwork \(full\) \| 100% \| 100% \| 50% \| 50% \| 1 \| 3 \|/);
  assert.match(md, /\| Ceiling \(files seen before\) \| – \| – \| – \| 80% \| – \| – \|/);
});

test('client-side WRRF fusion (used by the WebAssembly build) matches the fused order', async () => {
  const { fuseWrrf } = await import('../src/analyze.ts');
  const r = fuseWrrf([[[{ key: 'a' }, { key: 'b' }, { key: 'c' }], 0.5], [[{ key: 'c' }, { key: 'a' }], 0.5]], 3);
  assert.deepEqual(r.map((x) => x.key), ['a', 'c', 'b']); // a: 1st + 2nd, c: 3rd + 1st, b: 2nd only
  const store = await graph();
  const client = { ...store, nativeHybrid: false };
  const a = await planTicket(store, 'acme/shop', { issue: 3 });
  const b = await planTicket(client, 'acme/shop', { issue: 3 });
  assert.deepEqual(b.files.map((f) => f.path), a.files.map((f) => f.path));
});

test('the in-browser build: Relate WebAssembly gives the same plan as the native library', async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const wasm = await import('@relate/relate-wasm');
  await wasm.default({ module_or_path: readFileSync(createRequire(import.meta.url).resolve('@relate/relate-wasm/relate_bg.wasm')) });
  const { wasmStore } = await import('../web/browser.ts');
  const w = wasmStore(new wasm.RelateDb());
  await ingest(w, data);
  const native = await planTicket(await graph(), 'acme/shop', { issue: 3 });
  const inBrowser = await planTicket(w, 'acme/shop', { issue: 3 });
  assert.equal(w.nativeHybrid, false);
  assert.deepEqual(inBrowser.files.map((f) => f.path), native.files.map((f) => f.path));
  assert.deepEqual(inBrowser.experts.map((e) => e.login), native.experts.map((e) => e.login));
  const chk = await checkChange(w, 'acme/shop', { issue: 3 }, ['src/http/cookie.ts']);
  assert.ok(chk.missing.some((f) => f.path === 'src/http/cookie.test.ts'));
});

test('web export round trip: snapshot + int8 embeddings rebuild the same graph without computing embeddings', async () => {
  const { exportWeb } = await import('../src/export.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-web-'));
  const m = exportWeb(await graph(), data, dir);
  assert.equal(m.issues, 5);
  const snap = readSnapshot(path.join(dir, m.file));
  assert.equal(snap.vectors!.length, 9); // 5 tickets + 4 PRs
  const fresh = openStore(':memory:');
  await ingest(fresh, snap.data, () => {}, { vectors: snap.vectors });
  const a = await planTicket(await graph(), 'acme/shop', { issue: 3 });
  const b = await planTicket(fresh, 'acme/shop', { issue: 3 });
  assert.deepEqual(b.files.map((f) => f.path), a.files.map((f) => f.path));
});

test('replay: a closed ticket knows when it was opened and what its fix changed', async () => {
  const { fixOf } = await import('../src/analyze.ts');
  const store = await graph();
  const f = fixOf(store, 'acme/shop', 5)!;
  assert.deepEqual(f.prs, [13]);
  assert.equal(f.createdAt, '2026-04-01T00:00:00Z');
  assert.deepEqual(f.files.sort(), ['src/http/cookie.test.ts', 'src/http/cookie.ts', 'src/http/parse-header.ts']);
  assert.equal(fixOf(store, 'acme/shop', 3), null); // open, no fix
  assert.deepEqual(fixOf(store, 'acme/shop', 2)!.files, ['src/cart/total.ts']); // package.json is noise
});

test('sealed predictions: forecast open tickets, score only fixes merged after the seal', async () => {
  const { seal, score } = await import('../src/predict.ts');
  const store = await graph();
  const sealed = await seal(store, ['acme/shop']);
  // Open and unfixed at seal time: #3 and #4 (#1, #2, #5 are closed).
  assert.deepEqual(sealed.repos[0].forecasts.map((f) => f.issue), [4, 3]);
  assert.equal(sealed.repos[0].forecasts.find((f) => f.issue === 3)!.files[0].path, 'src/http/cookie.ts');
  const later = new Date(Date.parse(sealed.sealedAt) + 86_400_000).toISOString();
  const s = score(sealed, [
    { repo: 'acme/shop', issue: 3, pr: 20, mergedAt: later, files: ['src/http/cookie.ts', 'package.json'] },
    { repo: 'acme/shop', issue: 4, pr: 21, mergedAt: '2020-01-01T00:00:00Z', files: ['src/http/session.ts'] }, // before the seal: ignored
    { repo: 'acme/shop', issue: 99, pr: 22, mergedAt: later, files: ['x.ts'] }, // not forecast: ignored
  ]);
  assert.equal(s.totals.forecasts, 2);
  assert.equal(s.totals.fixed, 1);
  assert.equal(s.totals.hit5, 100);
  assert.deepEqual(s.cases[0].truth, ['src/http/cookie.ts']); // package.json is noise
});

test('with the code at hand: grep for the ticket words and fuse with the graph', async () => {
  const { execFileSync } = await import('node:child_process');
  const { withCode, grepRank } = await import('../src/code.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-code-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.join(dir, 'src', 'http'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'http', 'cookie.ts'), 'export function parse(value) { /* cookie value equals */ }');
  writeFileSync(path.join(dir, 'src', 'http', 'session-store.ts'), 'export const session = "cookie value session"');
  writeFileSync(path.join(dir, 'README.md'), 'nothing here');
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  const ranked = grepRank(dir, new Date(Date.now() + 60_000).toISOString(), 'Cookie with equals in value breaks session', 5);
  assert.ok(ranked.includes('src/http/session-store.ts') && ranked.includes('src/http/cookie.ts'));
  assert.ok(!ranked.includes('README.md'));
  const store = await graph();
  const plan = await planTicket(store, 'acme/shop', { issue: 3 });
  const fused = withCode(store, plan, dir);
  const extra = fused.files.find((f) => f.path === 'src/http/session-store.ts')!;
  assert.ok(extra, 'a file only grep found joins the list');
  assert.equal(extra.reasons[0].kind, 'grep');
  assert.equal(fused.files[0].path, 'src/http/cookie.ts'); // found by both: first
});
