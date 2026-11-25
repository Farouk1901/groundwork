// Sealed predictions: forecast the files of every open, unfixed ticket and commit them, so the date proves they came
// first; score() later checks them against the PRs merged after the seal.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  opts: { excludeIssues?: Map<string, Set<number>>; createdAfter?: string; linkedPrIssues?: Map<string, Set<number>> } = {},
): Promise<Sealed> {
  const out: SealedRepo[] = [];
  for (const repo of repos) {
    const seen = opts.excludeIssues?.get(repo);
    const linked = opts.linkedPrIssues?.get(repo);
    const open = store.query(`MATCH (i:Issue) WHERE i.repo = $repo AND i.state = 'OPEN' AND NOT EXISTS { MATCH (i)<-[:FIXES]-(:PR) }
        RETURN i.number AS n, i.title AS title, i.url AS url, i.createdAt AS at ORDER BY n DESC`, { repo })
      .filter((r) => {
        const n = num(r.n);
        if (seen?.has(n)) return false;
        if (linked?.has(n)) return false;
        if (opts.createdAfter && String(r.at) <= opts.createdAfter) return false;
        return true;
      });
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

/** Seal issues opened after the latest seal that are unfixed, unsealed and have no linked PR (its diff would be public). */
export async function sealDailyNewIssues(
  store: Store,
  repos: string[],
  existingSeals: Sealed[],
  opts: {
    date?: string;
    log?: (s: string) => void;
    createdAfter?: string;
    linkedPrIssues?: Map<string, Set<number>>;
    findLinkedPrs?: (repo: string, since: string) => Promise<Set<number>>;
  } = {},
): Promise<{ daily: DailySeal; json: string; sha256: string; count: number }> {
  const excludeIssues = new Map<string, Set<number>>();
  let lastSealedAt = '';
  for (const s of existingSeals) {
    if (s.sealedAt && s.sealedAt > lastSealedAt) lastSealedAt = s.sealedAt;
    for (const r of s.repos) {
      let set = excludeIssues.get(r.repo);
      if (!set) { set = new Set<number>(); excludeIssues.set(r.repo, set); }
      for (const f of r.forecasts) set.add(f.issue);
    }
  }
  const createdAfter = opts.createdAfter ?? (lastSealedAt || undefined);
  const linkedPrIssues = new Map<string, Set<number>>(opts.linkedPrIssues ?? []);
  if (opts.findLinkedPrs) {
    for (const repo of repos) {
      const found = await opts.findLinkedPrs(repo, createdAfter ?? '');
      const prev = linkedPrIssues.get(repo) ?? new Set<number>();
      for (const n of found) prev.add(n);
      linkedPrIssues.set(repo, prev);
    }
  }
  const base = await seal(store, repos, opts.log ?? (() => {}), { excludeIssues, createdAfter, linkedPrIssues });
  const date = opts.date ?? base.sealedAt.slice(0, 10);
  const daily: DailySeal = {
    date,
    sealedAt: base.sealedAt,
    weights: base.weights,
    note: `Daily seal (${date}) for newly opened, unfixed issues created after ${createdAfter ?? 'start'} with no linked PRs. Append-only; never seals open PRs.`,
    repos: base.repos,
  };
  const json = JSON.stringify(daily, null, 1) + '\n';
  const sha256 = sha256Hex(json);
  const count = daily.repos.reduce((a, r) => a + r.forecasts.length, 0);
  return { daily, json, sha256, count };
}

/** Refuses to overwrite an existing day, so a sealed forecast cannot be replaced later. */
export function writeDailySealFile(dir: string, date: string, json: string, sha256: string): { jsonPath: string; shaPath: string } {
  const dailyDir = path.join(dir, 'daily');
  const fileName = `${date}.json`;
  const jsonPath = path.join(dailyDir, fileName);
  const shaPath = path.join(dailyDir, `${date}.sha256`);
  if (existsSync(jsonPath)) {
    throw new Error(`Daily seal ${fileName} already exists (append-only: refusing to overwrite existing forecasts).`);
  }
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(jsonPath, json, { flag: 'wx' });
  writeFileSync(shaPath, `${sha256}  ${fileName}\n`, { flag: 'wx' });
  return { jsonPath, shaPath };
}

/** sealed.json, then daily/*.json in date order. */
export function loadAllSeals(dir: string): Sealed[] {
  const seals: Sealed[] = [];
  const baseFile = path.join(dir, 'sealed.json');
  if (existsSync(baseFile)) seals.push(JSON.parse(readFileSync(baseFile, 'utf8')) as Sealed);
  const dailyDir = path.join(dir, 'daily');
  if (existsSync(dailyDir)) {
    for (const f of readdirSync(dailyDir).filter((n) => n.endsWith('.json')).sort()) {
      seals.push(JSON.parse(readFileSync(path.join(dailyDir, f), 'utf8')) as Sealed);
    }
  }
  return seals;
}

/** After `until`, one last pass writes `frozen: true`; every run after that is skipped. */
export function shouldSkipFrozenScore(existingScore: { frozen?: boolean } | null, until: string | undefined, now: Date = new Date()): boolean {
  if (!until) return false;
  return now > new Date(until) && existingScore?.frozen === true;
}

export type FixSeen = { repo: string; issue: number; pr: number; mergedAt: string; files: string[] };
export type ScoredCase = { repo: string; issue: number; title: string; url: string; pr: number; mergedAt: string; sealedAt?: string; truth: string[]; top5: string[]; hit5: boolean; hit10: boolean; baselineHit5: boolean };
export type Score = {
  scoredAt: string; sealedAt: string; frozen: boolean; dailySeals?: number;
  totals: { forecasts: number; fixed: number; hit5: number; hit10: number; baselineHit5: number };
  repos: { repo: string; forecasts: number; fixed: number; hit5: number; hit10: number; baselineHit5: number }[];
  cases: ScoredCase[];
};

/** Score sealed forecasts against fixes merged after each issue's own seal. The caller reads GitHub. */
export function score(sealedOrList: Sealed | Sealed[], fixes: FixSeen[], opts: { scoredAt?: string; frozen?: boolean } = {}): Score {
  const seals = (Array.isArray(sealedOrList) ? sealedOrList : [sealedOrList])
    .slice()
    .sort((a, b) => a.sealedAt.localeCompare(b.sealedAt));
  const earliestSealedAt = seals[0]?.sealedAt ?? new Date().toISOString();

  // The first seal of an issue wins, with its own sealedAt and popular baseline.
  const repoOrder: string[] = [];
  const byRepo = new Map<string, Map<number, { forecast: Forecast; sealedAt: string; popular: string[] }>>();
  for (const s of seals) {
    for (const r of s.repos) {
      if (!byRepo.has(r.repo)) { byRepo.set(r.repo, new Map()); repoOrder.push(r.repo); }
      const map = byRepo.get(r.repo)!;
      for (const f of r.forecasts) {
        if (!map.has(f.issue)) map.set(f.issue, { forecast: f, sealedAt: s.sealedAt, popular: r.popular });
      }
    }
  }

  const cases: ScoredCase[] = [];
  for (const repo of repoOrder) {
    const byIssue = byRepo.get(repo)!;
    // A ticket may be closed by several PRs: their files together are the truth. Only fixes merged after its seal count.
    const truth = new Map<number, { pr: number; mergedAt: string; files: Set<string> }>();
    for (const x of fixes) {
      if (x.repo !== repo) continue;
      const entry = byIssue.get(x.issue);
      if (!entry || x.mergedAt <= entry.sealedAt) continue;
      const t = truth.get(x.issue) ?? { pr: x.pr, mergedAt: x.mergedAt, files: new Set<string>() };
      for (const f of x.files) if (!NOISE.test(f)) t.files.add(f);
      truth.set(x.issue, t);
    }
    for (const [issue, t] of truth) {
      if (!t.files.size) continue;
      const { forecast: f, sealedAt, popular } = byIssue.get(issue)!;
      const top = f.files.map((x) => x.path);
      cases.push({ repo, issue, title: f.title, url: f.url, pr: t.pr, mergedAt: t.mergedAt, sealedAt, truth: [...t.files],
        top5: top.slice(0, 5), hit5: top.slice(0, 5).some((p) => t.files.has(p)), hit10: top.some((p) => t.files.has(p)),
        baselineHit5: popular.slice(0, 5).some((p) => t.files.has(p)) });
    }
  }
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const sum = (cs: ScoredCase[], forecasts: number) => ({ forecasts, fixed: cs.length, hit5: pct(cs.filter((c) => c.hit5).length, cs.length),
    hit10: pct(cs.filter((c) => c.hit10).length, cs.length), baselineHit5: pct(cs.filter((c) => c.baselineHit5).length, cs.length) });
  const totalForecasts = repoOrder.reduce((a, r) => a + byRepo.get(r)!.size, 0);
  return {
    scoredAt: opts.scoredAt ?? new Date().toISOString(),
    sealedAt: earliestSealedAt,
    frozen: !!opts.frozen,
    dailySeals: Math.max(0, seals.length - 1),
    totals: sum(cases, totalForecasts),
    repos: repoOrder.map((repo) => ({ repo, ...sum(cases.filter((c) => c.repo === repo), byRepo.get(repo)!.size) })),
    cases: cases.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)),
  };
}
