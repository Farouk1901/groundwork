// Node.js only: grep a local clone for the ticket's words and fuse that ranking with the graph's (Hit@5 on hono 77% to 82%).
import { execFileSync } from 'node:child_process';
import { NOISE, fuseWrrf, keywords, type FileHit, type Plan } from './analyze.js';
import { moduleOf } from './ingest.js';
import type { Store } from './core.js';

/** Grep the code as it was at `before` for the ticket's words; rank files by summed IDF, then by path length. */
export function grepRank(clone: string, before: string, text: string, k: number, hits?: Map<string, string[]>): string[] {
  const git = (...a: string[]) => { try { return execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return (e as { stdout?: string }).stdout ?? ''; } };
  const commit = git('rev-list', '-1', `--before=${before}`, 'HEAD').trim();
  if (!commit) return [];
  const words = keywords(text, 8).split(' ').filter(Boolean);
  if (!words.length) return [];
  const total = Math.max(1, git('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean).length);
  const score = new Map<string, number>();
  for (const w of words) {
    const files = git('grep', '-I', '-i', '-l', '-F', '-e', w, commit, '--').split('\n').filter(Boolean).map((l) => l.slice(commit.length + 1));
    if (!files.length) continue;
    const idf = Math.log(total / files.length);
    for (const f of files) { score.set(f, (score.get(f) ?? 0) + idf); hits?.set(f, [...(hits.get(f) ?? []), w]); }
  }
  return [...score].filter(([f]) => !NOISE.test(f)).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, k).map(([f]) => f);
}

/**
 * Weighted RRF (k=10) of the graph and grep rankings. The graph's weight goes from 0.35 at bestSim <= 0.74 to 0.65 at
 * bestSim >= 0.86, linear in between. Tuned on the `--split older` half only.
 */
export function fuseWithGrep(graphPaths: string[], grepPaths: string[], bestSim: number, k = 12) {
  const alpha = Math.max(0, Math.min(1, (bestSim - 0.74) / (0.86 - 0.74)));
  const wGraph = 0.35 + 0.30 * alpha;
  return fuseWrrf(
    [
      [graphPaths.map((key) => ({ key })), wGraph],
      [grepPaths.map((key) => ({ key })), 1 - wGraph],
    ],
    k,
    10,
  );
}

/** Fuse a plan with grep over a local clone (at HEAD): same files list shape, grep-only files say which words matched. */
export function withCode(store: Store, plan: Plan, codeDir: string, k = 12): Plan {
  const text = plan.target.kind === 'text' ? plan.target.text
    : String(store.query('MATCH (i:Issue {key: $k}) RETURN i.title AS t, i.body AS b', { k: `${plan.repo}#${plan.target.kind === 'issue' && plan.target.ref.startsWith('#') ? plan.target.number : plan.target.kind === 'issue' ? plan.target.ref : ''}` })
      .map((r) => `${r.t}. ${r.b}`)[0] ?? plan.target.title);
  const hits = new Map<string, string[]>();
  const grep = grepRank(codeDir, new Date().toISOString(), text, k, hits);
  if (!grep.length) return plan;
  const byPath = new Map(plan.files.map((f) => [f.path, f]));
  const bestSim = plan.similar.length ? Math.max(...plan.similar.map((s) => s.sim)) : 0;
  const fused = fuseWithGrep(plan.files.map((f) => f.path), grep, bestSim, k);
  const max = Math.max(1e-9, ...fused.map((r) => Number(r.score)));
  const files: FileHit[] = fused.map((r) => {
    const path = String(r.key);
    const f = byPath.get(path) ?? { path, module: moduleOf(path), score: 0, reasons: [] };
    const words = hits.get(path);
    const reasons = words && !f.reasons.some((x) => x.kind === 'grep')
      ? [...f.reasons, { kind: 'grep' as const, text: `the code contains the ticket's words: ${words.slice(0, 4).join(', ')}`, score: 0.1 }] : f.reasons;
    return { ...f, score: Math.round((Number(r.score) / max) * 100) / 100, reasons: byPath.has(path) ? reasons : reasons.slice(-1) };
  });
  return { ...plan, files };
}
