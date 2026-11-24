// Sealed predictions: a forecast on the future, not a backtest on the past.
//
// seal()  runs planTicket on every ticket that is still open and has no fix yet, and writes the top files per ticket
//         to a JSON file committed to the repository: the commit date proves the forecast came first.
// score() later reads the pull requests merged *after* the seal that close one of those tickets, and checks the
//         forecast against the files they really changed. Nothing in the forecast can have seen those fixes.
import { createHash } from 'node:crypto';
import { NOISE, planTicket, WEIGHTS } from './analyze.js';
import { num, type Store } from './core.js';

export type Forecast = { issue: number; title: string; url: string; createdAt: string; files: { path: string; score: number }[] };
export type SealedRepo = { repo: string; graphFetchedAt: string; popular: string[]; forecasts: Forecast[] };
export type Sealed = { sealedAt: string; weights: typeof WEIGHTS; note: string; repos: SealedRepo[] };
export type DailySeal = { date: string; sealedAt: string; sha256?: string; weights: typeof WEIGHTS; note: string; repos: SealedRepo[] };

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function seal(
  store: Store,
  repos: string[],
  log: (s: string) => void = () => {},
  opts: { excludeIssues?: Map<string, Set<number>> } = {},
): Promise<Sealed> {
  const out: SealedRepo[] = [];
  for (const repo of repos) {
    const seen = opts.excludeIssues?.get(repo);
    const open = store.query(`MATCH (i:Issue) WHERE i.repo = $repo AND i.state = 'OPEN' AND NOT EXISTS { MATCH (i)<-[:FIXES]-(:PR) }
        RETURN i.number AS n, i.title AS title, i.url AS url, i.createdAt AS at ORDER BY n DESC`, { repo })
      .filter((r) => !seen?.has(num(r.n)));
    const fetched = String(store.query('MATCH (r:Repo {name: $repo}) RETURN r.fetchedAt AS at', { repo })[0]?.at ?? '');
    // The baseline, frozen too: the files changed most often so far.
    const popular = store.query(`MATCH (x:PR)-[:TOUCHES]->(f:File) WHERE x.repo = $repo AND x.fileCount <= 40
        RETURN f.path AS p, count(x) AS n ORDER BY n DESC LIMIT 30`, { repo }).map((r) => String(r.p)).filter((p) => !NOISE.test(p)).slice(0, 10);
    const forecasts: Forecast[] = [];
    for (const r of open) {
      const p = await planTicket(store, repo, { issue: num(r.n) }, { files: 10, minScore: 0 });
      forecasts.push({ issue: num(r.n), title: String(r.title), url: String(r.url), createdAt: String(r.at),
        files: p.files.filter((f) => !NOISE.test(f.path)).slice(0, 10).map((f) => ({ path: f.path, score: f.score })) });
    }
    log(`  ${repo}: ${forecasts.length} open tickets forecast`);
    out.push({ repo, graphFetchedAt: fetched, popular, forecasts });
  }
  return {
    sealedAt: new Date().toISOString(), weights: WEIGHTS,
    note: 'Forecasts for newly opened, unfixed issues only (never open PRs whose diffs are already public). Scored only against pull requests merged after sealedAt.',
    repos: out,
  };
}

/**
 * Seal ONLY newly opened, unfixed issues that have not been sealed in sealed.json or earlier daily files.
 * Never seals open PRs (their diffs are public at seal time, which would leak the answer).
 */
export async function sealDailyNewIssues(
  store: Store,
  repos: string[],
  existingSeals: Sealed[],
  opts: { date?: string; log?: (s: string) => void } = {},
): Promise<{ daily: DailySeal; json: string; sha256: string; count: number }> {
  const excludeIssues = new Map<string, Set<number>>();
  for (const s of existingSeals) {
    for (const r of s.repos) {
      let set = excludeIssues.get(r.repo);
      if (!set) { set = new Set<number>(); excludeIssues.set(r.repo, set); }
      for (const f of r.forecasts) set.add(f.issue);
    }
  }
  const base = await seal(store, repos, opts.log ?? (() => {}), { excludeIssues });
  const date = opts.date ?? base.sealedAt.slice(0, 10);
  const daily: DailySeal = {
    date,
    sealedAt: base.sealedAt,
    weights: base.weights,
    note: `Daily seal (${date}) for newly opened, unfixed issues only. Never seals open PRs.`,
    repos: base.repos,
  };
  const json = JSON.stringify(daily, null, 1) + '\n';
  const sha256 = sha256Hex(json);
  const count = daily.repos.reduce((a, r) => a + r.forecasts.length, 0);
  return { daily, json, sha256, count };
}

export type FixSeen = { repo: string; issue: number; pr: number; mergedAt: string; files: string[] };
export type ScoredCase = { repo: string; issue: number; title: string; url: string; pr: number; mergedAt: string; truth: string[]; top5: string[]; hit5: boolean; hit10: boolean; baselineHit5: boolean };
export type Score = {
  scoredAt: string; sealedAt: string; frozen: boolean;
  totals: { forecasts: number; fixed: number; hit5: number; hit10: number; baselineHit5: number };
  repos: { repo: string; forecasts: number; fixed: number; hit5: number; hit10: number; baselineHit5: number }[];
  cases: ScoredCase[];
};

/** Compare sealed forecasts with the fixes merged after the seal. Pure: the GitHub reading is done by the caller. */
export function score(sealed: Sealed, fixes: FixSeen[], opts: { scoredAt?: string; frozen?: boolean } = {}): Score {
  const cases: ScoredCase[] = [];
  for (const r of sealed.repos) {
    const byIssue = new Map(r.forecasts.map((f) => [f.issue, f]));
    // A ticket may be closed by several PRs: their files together are the truth.
    const truth = new Map<number, { pr: number; mergedAt: string; files: Set<string> }>();
    for (const x of fixes.filter((x) => x.repo === r.repo && x.mergedAt > sealed.sealedAt && byIssue.has(x.issue))) {
      const t = truth.get(x.issue) ?? { pr: x.pr, mergedAt: x.mergedAt, files: new Set<string>() };
      for (const f of x.files) if (!NOISE.test(f)) t.files.add(f);
      truth.set(x.issue, t);
    }
    for (const [issue, t] of truth) {
      if (!t.files.size) continue;
      const f = byIssue.get(issue)!;
      const top = f.files.map((x) => x.path);
      cases.push({ repo: r.repo, issue, title: f.title, url: f.url, pr: t.pr, mergedAt: t.mergedAt, truth: [...t.files],
        top5: top.slice(0, 5), hit5: top.slice(0, 5).some((p) => t.files.has(p)), hit10: top.some((p) => t.files.has(p)),
        baselineHit5: r.popular.slice(0, 5).some((p) => t.files.has(p)) });
    }
  }
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const sum = (cs: ScoredCase[], forecasts: number) => ({ forecasts, fixed: cs.length, hit5: pct(cs.filter((c) => c.hit5).length, cs.length),
    hit10: pct(cs.filter((c) => c.hit10).length, cs.length), baselineHit5: pct(cs.filter((c) => c.baselineHit5).length, cs.length) });
  return {
    scoredAt: opts.scoredAt ?? new Date().toISOString(), sealedAt: sealed.sealedAt, frozen: !!opts.frozen,
    totals: sum(cases, sealed.repos.reduce((a, r) => a + r.forecasts.length, 0)),
    repos: sealed.repos.map((r) => ({ repo: r.repo, ...sum(cases.filter((c) => c.repo === r.repo), r.forecasts.length) })),
    cases: cases.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)),
  };
}
