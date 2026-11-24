// Backtest: does reading the ticket really tell you which files will change?
//
// For every closed ticket that a merged pull request fixed, replay the graph as it was the moment the ticket was
// opened (planTicket with asOf = ticket.createdAt: the fix, and everything merged or fixed later, is invisible),
// predict the files, and compare with the files the real fix changed. Same cases, same graph, for:
//   full         the whole pipeline
//   ablations    one part switched off at a time (similar tickets, similar PRs, co-change, full-text, vector)
//   popular      baseline: the files changed most often before that moment. This is the best a tool that has to
//                start from a file (co-change, ownership) can do when there is only a ticket and no code yet.
import { NOISE, planTicket, type PlanOptions } from './analyze.js';
import { num, type Store } from './store.js';

export type Case = { issue: number; title: string; createdAt: string; truth: string[]; known: string[] };
export type Score = { name: string; cases: number; hit5: number; hit10: number; recall5: number; recall10: number; mrr: number; ms: number };
export type EvalReport = { repo: string; at: string; split?: string; cases: number; skipped: number; k: number; results: Score[]; examples: { issue: number; title: string; truth: string[]; top: string[] }[] };

/** Closed tickets with a fixing PR, the source files that fix changed, and which of them already existed. */
export function cases(store: Store, repo: string, opts: { limit?: number; minHistory?: number; split?: 'older' | 'newer' } = {}): { cases: Case[]; skipped: number } {
  const rows = store.query(`MATCH (x:PR)-[:FIXES]->(i:Issue) WHERE i.repo = $repo AND x.fileCount >= 1 AND x.fileCount <= 40 AND x.mergedAt >= i.createdAt
      MATCH (x)-[:TOUCHES]->(f:File)
      RETURN i.number AS issue, i.title AS title, i.createdAt AS createdAt, collect(DISTINCT f.path) AS files
      ORDER BY createdAt DESC`, { repo });
  const out: Case[] = [];
  let skipped = 0;
  for (const r of rows) {
    const createdAt = String(r.createdAt);
    const history = num(store.query('MATCH (x:PR) WHERE x.repo = $repo AND x.mergedAt < $t RETURN count(x) AS n', { repo, t: createdAt })[0]?.n);
    const truth = (r.files as string[]).filter((p) => !NOISE.test(p));
    if (history < (opts.minHistory ?? 50) || !truth.length) { skipped++; continue; }
    // A file that no earlier PR ever touched cannot be predicted from history: report it, but separately.
    const known = store.query(`MATCH (x:PR)-[:TOUCHES]->(f:File) WHERE f.key IN $keys AND x.mergedAt < $t RETURN DISTINCT f.path AS p`,
      { keys: truth.map((p) => `${repo}:${p}`), t: createdAt }).map((x) => String(x.p));
    out.push({ issue: num(r.issue), title: String(r.title), createdAt, truth, known });
  }
  // Tune on the older half, report on the newer half: the newer tickets never influenced a default.
  const half = Math.ceil(out.length / 2);
  const picked = opts.split === 'newer' ? out.slice(0, half) : opts.split === 'older' ? out.slice(half) : out;
  return { cases: opts.limit ? picked.slice(0, opts.limit) : picked, skipped };
}

function popular(store: Store, repo: string, asOf: string, k: number): string[] {
  return store.query(`MATCH (x:PR)-[:TOUCHES]->(f:File) WHERE x.repo = $repo AND x.mergedAt < $asOf AND x.fileCount <= 40
      RETURN f.path AS p, count(x) AS n ORDER BY n DESC LIMIT $k`, { repo, asOf, k: k * 3 })
    .map((r) => String(r.p)).filter((p) => !NOISE.test(p)).slice(0, k);
}

function score(name: string, preds: { top: string[]; truth: string[] }[], ms: number): Score {
  const n = Math.max(1, preds.length);
  let hit5 = 0, hit10 = 0, r5 = 0, r10 = 0, mrr = 0;
  for (const { top, truth } of preds) {
    const t = new Set(truth);
    const in5 = top.slice(0, 5).filter((p) => t.has(p)).length, in10 = top.slice(0, 10).filter((p) => t.has(p)).length;
    hit5 += in5 > 0 ? 1 : 0; hit10 += in10 > 0 ? 1 : 0;
    r5 += in5 / t.size; r10 += in10 / t.size;
    const first = top.findIndex((p) => t.has(p));
    mrr += first >= 0 ? 1 / (first + 1) : 0;
  }
  const pct = (x: number) => Math.round((x / n) * 1000) / 10;
  return { name, cases: preds.length, hit5: pct(hit5), hit10: pct(hit10), recall5: pct(r5), recall10: pct(r10), mrr: Math.round((mrr / n) * 1000) / 1000, ms: Math.round(ms / n) };
}

export const VARIANTS: { name: string; use?: PlanOptions['use'] }[] = [
  { name: 'Groundwork (full)' },
  { name: '  without similar tickets', use: { issues: false } },
  { name: '  without similar PRs', use: { prs: false } },
  { name: '  without co-change', use: { coChange: false } },
  { name: '  vector only (no full-text)', use: { fulltext: false } },
  { name: '  full-text only (no vector)', use: { vector: false } },
];

export async function backtest(store: Store, repo: string, opts: { limit?: number; k?: number; ablations?: boolean; minHistory?: number; split?: 'older' | 'newer'; log?: (s: string) => void } = {}): Promise<EvalReport> {
  const k = opts.k ?? 10;
  const log = opts.log ?? (() => {});
  const { cases: cs, skipped } = cases(store, repo, { limit: opts.limit, minHistory: opts.minHistory, split: opts.split });
  log(`${cs.length} tickets with a known fix (${skipped} skipped: too little history before them, or only manifest changes)`);
  const results: Score[] = [];
  const examples: EvalReport['examples'] = [];
  const variants = opts.ablations === false ? VARIANTS.slice(0, 1) : VARIANTS;
  for (const v of variants) {
    const t0 = Date.now();
    const preds: { top: string[]; truth: string[] }[] = [];
    for (const c of cs) {
      const p = await planTicket(store, repo, { issue: c.issue }, { asOf: c.createdAt, files: k, use: v.use, minScore: 0 });
      const top = p.files.map((f) => f.path).filter((x) => !NOISE.test(x));
      preds.push({ top, truth: c.truth });
      if (v === VARIANTS[0] && examples.length < 12) examples.push({ issue: c.issue, title: c.title, truth: c.truth, top: top.slice(0, 5) });
    }
    results.push(score(v.name, preds, Date.now() - t0));
    log(`  ${v.name.trim()}: done`);
  }
  const t0 = Date.now();
  results.push(score('Baseline: most-changed files', cs.map((c) => ({ top: popular(store, repo, c.createdAt, k), truth: c.truth })), Date.now() - t0));
  // The ceiling of any history-based method: share of fixed files that some earlier PR had touched.
  const ceiling = cs.reduce((a, c) => a + c.known.length / c.truth.length, 0) / Math.max(1, cs.length);
  results.push({ name: 'Ceiling (files seen before)', cases: cs.length, hit5: NaN, hit10: NaN, recall5: NaN, recall10: Math.round(ceiling * 1000) / 10, mrr: NaN, ms: 0 });
  return { repo, at: new Date().toISOString(), split: opts.split, cases: cs.length, skipped, k, results, examples };
}

export function evalMarkdown(r: EvalReport): string {
  const f = (x: number, unit = '%') => (Number.isNaN(x) ? '–' : `${x}${unit}`);
  const L = [
    `### Backtest on ${r.repo}: ${r.cases} real tickets, predicted from the ticket text alone`, '',
    'Each ticket is replayed as of the moment it was opened: its fix and everything merged later are hidden.', '',
    '| Method | Hit@5 | Hit@10 | Recall@5 | Recall@10 | MRR | ms/ticket |', '|---|---:|---:|---:|---:|---:|---:|',
    ...r.results.map((x) => `| ${x.name.startsWith('  ') ? '&nbsp;&nbsp;' + x.name.trim() : x.name} | ${f(x.hit5)} | ${f(x.hit10)} | ${f(x.recall5)} | ${f(x.recall10)} | ${f(x.mrr, '')} | ${x.ms || '–'} |`),
    '', 'Hit@k: at least one file the real fix changed is in the top k. Recall@k: share of those files in the top k.',
  ];
  return L.join('\n');
}
