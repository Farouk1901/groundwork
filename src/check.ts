// check: compare the change you are making with what the ticket predicts.
//   expected + changed   covered
//   expected, unchanged  missing: similar fixes in the past changed it too (a test, a sibling module, the docs)
//   changed, unexpected  outside the ticket's usual footprint: fine if intended, worth a second look if not
// Works on any list of files; gitChangedFiles reads them from a local clone.
import { execFileSync } from 'node:child_process';
import { NOISE, TEST, planTicket, type Plan, type Reason } from './analyze.js';
import type { Store } from './store.js';

export type CheckReport = {
  plan: Plan;
  changed: string[];
  covered: { path: string; score: number }[];
  missing: { path: string; score: number; why: string; test: boolean }[];
  unexpected: { path: string; seenBefore: boolean }[];
  ok: boolean;
};

export function gitChangedFiles(opts: { cwd?: string; staged?: boolean; base?: string } = {}): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((x) => x.trim()).filter(Boolean);
  if (opts.staged) return git('diff', '--cached', '--name-only');
  const out = new Set<string>();
  if (opts.base) for (const f of git('diff', '--name-only', `${opts.base}...HEAD`)) out.add(f);
  for (const f of git('diff', '--name-only', 'HEAD')) out.add(f);
  for (const f of git('ls-files', '--others', '--exclude-standard')) out.add(f);
  return [...out];
}

const best = (rs: Reason[]) => rs.slice().sort((a, b) => b.score - a.score)[0]?.text ?? '';

export async function checkChange(store: Store, repo: string, target: { issue: number | string } | { text: string }, changed: string[],
  opts: { threshold?: number; files?: number } = {}): Promise<CheckReport> {
  const threshold = opts.threshold ?? 0.5;
  const plan = await planTicket(store, repo, target, { files: opts.files ?? 15 });
  const ch = new Set(changed.map((p) => p.replace(/\\/g, '/')));
  const predicted = plan.files.filter((f) => !NOISE.test(f.path));
  const covered = predicted.filter((f) => ch.has(f.path)).map((f) => ({ path: f.path, score: f.score }));
  const missing = predicted.filter((f) => !ch.has(f.path) && f.score >= threshold)
    // When the change already touches a file's own fix, its sibling test is the classic miss: keep tests in.
    .map((f) => ({ path: f.path, score: f.score, why: best(f.reasons), test: TEST.test(f.path) }));
  const known = new Set(predicted.map((f) => f.path));
  const extra = [...ch].filter((p) => !known.has(p) && !NOISE.test(p));
  const seen = new Set(extra.length ? store.query('MATCH (x:PR)-[:TOUCHES]->(f:File) WHERE f.key IN $keys RETURN DISTINCT f.path AS p',
    { keys: extra.map((p) => `${repo}:${p}`) }).map((r) => String(r.p)) : []);
  const unexpected = extra.map((p) => ({ path: p, seenBefore: seen.has(p) }));
  return { plan, changed: [...ch], covered, missing, unexpected, ok: missing.length === 0 };
}

export function checkMarkdown(r: CheckReport): string {
  const t = r.plan.target;
  const L = [t.kind === 'issue' ? `# Check against ${r.plan.repo} ${t.ref}: ${t.title}` : `# Check against: "${t.text.slice(0, 100)}"`, ''];
  L.push(`${r.changed.length} changed file(s); ${r.covered.length} of them are where this ticket's history points.`, '');
  if (r.covered.length) L.push('## Covered', '', ...r.covered.map((f) => `- [x] \`${f.path}\` (${Math.round(f.score * 100)}%)`), '');
  if (r.missing.length) L.push('## Probably missing', '', ...r.missing.map((f) => `- [ ] \`${f.path}\` (${Math.round(f.score * 100)}%)${f.test ? ' (test)' : ''}: ${f.why}`), '');
  if (r.unexpected.length) L.push('## Outside the usual footprint', '', ...r.unexpected.map((f) => `- \`${f.path}\`${f.seenBefore ? '' : ' (no past PR touched it: new file?)'}`), '');
  L.push(r.ok ? 'Looks complete for this ticket.' : `Review the ${r.missing.length} file(s) above before you open the PR.`);
  return L.join('\n');
}
