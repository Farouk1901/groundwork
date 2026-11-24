// Node.js only: when the code is at hand (an agent works inside the clone), search it for the ticket's words and fuse
// that ranking with the graph's. In the backtest this lifted Hit@5 on hono from 77% to 82%: the graph knows where
// similar work happened, grep knows where today's words are.
import { execFileSync } from 'node:child_process';
import { NOISE, fuseWrrf, keywords, type FileHit, type Plan } from './analyze.js';
import { moduleOf } from './ingest.js';
import type { Store } from './core.js';

/**
 * The baseline a coding agent already has: search the code, as it was that day, for the ticket's words. Files are
 * ranked by the summed IDF of the distinct words they contain (rare words count more), then by name length.
 */
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


/** Fuse a plan with grep over a local clone (at HEAD): same files list shape, grep-only files say which words matched. */
export function withCode(store: Store, plan: Plan, codeDir: string, k = 12): Plan {
  const text = plan.target.kind === 'text' ? plan.target.text
    : String(store.query('MATCH (i:Issue {key: $k}) RETURN i.title AS t, i.body AS b', { k: `${plan.repo}#${plan.target.kind === 'issue' && plan.target.ref.startsWith('#') ? plan.target.number : plan.target.kind === 'issue' ? plan.target.ref : ''}` })
      .map((r) => `${r.t}. ${r.b}`)[0] ?? plan.target.title);
  const hits = new Map<string, string[]>();
  const grep = grepRank(codeDir, new Date().toISOString(), text, k, hits);
  if (!grep.length) return plan;
  const byPath = new Map(plan.files.map((f) => [f.path, f]));
  const fused = fuseWrrf([[plan.files.map((f) => ({ key: f.path })), 0.6], [grep.map((key) => ({ key })), 0.4]], k);
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
