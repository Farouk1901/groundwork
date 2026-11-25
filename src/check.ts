// Compare a list of changed files with what the ticket predicts: covered, probably missing, or outside the usual footprint.
import { NOISE, TEST, planTicket, type Plan, type Reason } from './analyze.js';
import type { Store } from './core.js';

export type CheckReport = {
  plan: Plan;
  changed: string[];
  covered: { path: string; score: number }[];
  missing: { path: string; score: number; why: string; test: boolean }[];
  unexpected: { path: string; seenBefore: boolean }[];
  ok: boolean;
};

const best = (rs: Reason[]) => rs.slice().sort((a, b) => b.score - a.score)[0]?.text ?? '';

export async function checkChange(store: Store, repo: string, target: { issue: number | string } | { text: string }, changed: string[],
  opts: { threshold?: number; files?: number; refine?: (p: Plan) => Plan } = {}): Promise<CheckReport> {
  const threshold = opts.threshold ?? 0.5;
  // refine fuses in grep over a local clone (code.ts); the browser has no clone.
  const raw = await planTicket(store, repo, target, { files: opts.files ?? 15 });
  const plan = opts.refine ? opts.refine(raw) : raw;
  const ch = new Set(changed.map((p) => p.replace(/\\/g, '/')));
  const predicted = plan.files.filter((f) => !NOISE.test(f.path));
  const covered = predicted.filter((f) => ch.has(f.path)).map((f) => ({ path: f.path, score: f.score }));
  const missing = predicted.filter((f) => !ch.has(f.path) && f.score >= threshold)
    // Tests stay in: a forgotten sibling test is the most common miss.
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
