// Picks every STEP-th held-out case (newer split) and records its pre-fix commit and the real fix's files.
// Usage: npx tsx bench/agent-ab/select.ts <owner/repo> <local clone> <limit> <start> <step> <count> <out.json>
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openStore } from '../../src/store.ts';
import { cases } from '../../src/eval.ts';
const [repo, CLONE, LIMIT, START, STEP, N, OUT] = process.argv.slice(2).map((x, i) => (i >= 2 && i <= 5 ? Number(x) : x)) as any;
const s = openStore();
const { cases: all } = cases(s, repo, { split: 'newer', limit: LIMIT });
const git = (...a: string[]) => execFileSync('git', ['-C', CLONE, ...a], { encoding: 'utf8' }).trim();
const out = [];
for (let i = START; i < all.length && out.length < N; i += STEP) {
  const c = all[i];
  const i0 = s.query('MATCH (i:Issue {key:$k}) RETURN i.body AS body, i.url AS url', { k: `${repo}#${c.issue}` })[0];
  const prs = s.query('MATCH (x:PR)-[:FIXES]->(i:Issue {key:$k}) WHERE x.mergedAt >= i.createdAt RETURN x.number AS n, x.mergedAt AS m ORDER BY m', { k: `${repo}#${c.issue}` })
    .map((r) => ({ number: Number(r.n), mergedAt: String(r.m) }));
  const first = prs[0];
  let fixCommit = '', how = '';
  for (const p of prs) { const h = git('log', 'main', '--format=%H', '-F', `--grep=(#${p.number})`); if (h) { fixCommit = h.split('\n').at(-1)!; how = `squash commit for PR #${p.number}`; break; } }
  if (!fixCommit) { fixCommit = ''; how = 'no commit on main found'; }
  const preFix = fixCommit ? git('rev-parse', `${fixCommit}^`) : git('rev-list', '-1', `--before=${first.mergedAt}`, 'main');
  out.push({ index: i, issue: c.issue, title: c.title, createdAt: c.createdAt, url: String(i0.url), body: String(i0.body ?? ''), fixPRs: prs, fixCommit, fixCommitHow: how,
    preFixCommit: preFix, preFixDate: git('show', '-s', '--format=%cI', preFix), truth: c.truth, truthTests: c.truth.filter((p) => /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[jt]sx?$/.test(p)), known: c.known });
}
s.close();
writeFileSync(OUT, JSON.stringify({ repo, source: `cases(store, repo, { split: "newer", limit: ${LIMIT} }) from src/eval.ts; every ${STEP}th case from index ${START}`, generatedAt: new Date().toISOString(), cases: out }, null, 2));
for (const c of out) console.log(c.index, c.issue, c.createdAt.slice(0,10), c.fixPRs.map(p=>p.number).join(','), c.fixCommitHow, c.preFixCommit.slice(0,8), c.truth.length, c.truthTests.length, c.title.slice(0,50));
