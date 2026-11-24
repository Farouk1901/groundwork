// The questions a developer (or a coding agent) asks before touching a ticket, answered from the graph.
//
// planTicket: which files, modules and people will this ticket reach, and why?
//   1. seeds   files the ticket names, files its own fix touched (when there is one), and files touched by the
//              fixes of similar past tickets and similar pull requests (hybrid search inside Relate: vector +
//              full-text fused with WRRF)
//   2. expand  files that historically change together with the seeds (co-change)
//   3. people  who authored the most changes to those files
//   4. risks   open tickets and recent bug fixes in the same files
// Every score keeps the graph paths that produced it, so the answer can be explained and drawn.
//
// `asOf` replays the graph as it was at a moment in time (only PRs merged and tickets fixed before it); the
// backtest in eval.ts uses it to predict a ticket's files without peeking at the fix.
import { embedOne, cleanText } from './embed.js';
import { num, type Row, type Store } from './store.js';

export type Reason = { kind: 'fixed-by' | 'named' | 'similar-issue' | 'similar-pr' | 'co-change'; text: string; via?: string; score: number };
export type FileHit = { path: string; module: string; score: number; reasons: Reason[] };
export type Expert = { login: string; changes: number; files: string[]; last: string };
export type Risk = { kind: 'open-issue' | 'recent-bug-fix'; number: number; title: string; url: string; why: string };
export type Similar = { kind: 'issue' | 'pr'; number: number; title: string; url: string; score: number; sim: number; state?: string };
export type GraphView = { nodes: { id: string; label: string; type: string; score?: number }[]; edges: { from: string; to: string; type: string }[] };
export type Plan = {
  repo: string;
  target: { kind: 'issue'; number: number; ref: string; title: string; url: string; state: string } | { kind: 'text'; text: string };
  files: FileHit[]; modules: { module: string; score: number; files: number }[];
  experts: Expert[]; risks: Risk[]; similar: Similar[]; graph: GraphView; tookMs: number;
};
export type PlanOptions = {
  files?: number;
  similar?: number;
  /** Hide files whose relative score is below this (default 0.05). The backtest passes 0 to rank everything. */
  minScore?: number;
  /** Replay the graph as it was at this ISO time: no fix of the target, nothing merged or fixed later. */
  asOf?: string;
  /** Switch parts off, for ablations in the backtest. */
  use?: Partial<Record<'named' | 'issues' | 'prs' | 'coChange' | 'fulltext' | 'vector', boolean>>;
};

const STOP = new Set('a an the and or of to in on for with is are was were be been it this that when after before from by as at not no do does did can cannot should would could i we you they my our your their issue bug error fix fails failing failed add support use using via into out up new'.split(' '));

/** A safe full-text query: lowercase alphanumeric terms, stop words removed (Relate tokenizes the same way). */
export function keywords(text: string, max = 8): string {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) {
    if (!STOP.has(w)) seen.add(w);
    if (seen.size >= max) break;
  }
  return [...seen].join(' ');
}

// Files that change in almost every PR (manifests, lockfiles, changelogs) say little about a specific change.
export const NOISE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|jsr\.json|deno\.json|CHANGELOG[^/]*|\.changeset\/[^/]+)$/i;

export const TEST = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$/i;

const s = (v: unknown) => (v == null ? '' : String(v));

// Relate's cosine is rebounded to [0, 1] ((1 + cos) / 2). Below this, a match is noise: about cos 0.3.
const MIN_SIM = 0.65;
const MAX_PR_FILES = 40;

/** Weights. Defaults were chosen on the older half of the hono backtest and reported on the newer half (see eval). */
export const WEIGHTS = {
  vector: Number(process.env.GW_W_VECTOR ?? 0.5),
  coChange: Number(process.env.GW_W_COCHANGE ?? 0.05),
};

type Hit = { node: Row; score: number; sim: number };

/**
 * Hybrid retrieval: Relate fuses the vector and full-text rankings with WRRF (the order), and we also read the
 * cosine similarity, because fused rank scores are nearly flat and say nothing about how close a match really is.
 */
function hybrid(store: Store, label: 'Issue' | 'PR', repo: string, vec: number[], text: string, limit: number,
  opts: { asOf?: string; fulltext?: boolean; vector?: boolean } = {}): Hit[] {
  const idx = label === 'Issue' ? ['issue_embed', 'issue_text'] : ['pr_embed', 'pr_text'];
  const kw = opts.fulltext === false ? '' : keywords(text);
  const useVec = opts.vector !== false;
  // When replaying the past, ask for more and drop what did not exist yet.
  const k = opts.asOf ? limit * 6 : limit;
  const ret = `RETURN n.key AS key, n.number AS number, n.title AS title, n.url AS url, n.state AS state, n.repo AS repo,
       n.createdAt AS createdAt, n.mergedAt AS mergedAt, score, vector.similarity.cosine(n.embedding, $vec) AS cos`;
  let cypher: string;
  if (kw && useVec) cypher = `MATCH (n:${label}) SEARCH n IN (COMBINE (
         VECTOR INDEX ${idx[0]} FOR $vec WHERE n.repo = $repo LIMIT $k WEIGHT $wv,
         FULLTEXT INDEX ${idx[1]} FOR $kw LIMIT $k WEIGHT $wf) USING WRRF WITH CONSTANT 60 LIMIT $k) SCORE AS score ${ret}`;
  else if (useVec) cypher = `MATCH (n:${label}) SEARCH n IN (VECTOR INDEX ${idx[0]} FOR $vec WHERE n.repo = $repo LIMIT $k) SCORE AS score ${ret}`;
  else if (kw) cypher = `MATCH (n:${label}) SEARCH n IN (FULLTEXT INDEX ${idx[1]} FOR $kw LIMIT $k) SCORE AS score ${ret}`;
  else return [];
  let rows = store.query(cypher, { vec, kw, repo, k, wv: WEIGHTS.vector, wf: 1 - WEIGHTS.vector }).filter((r) => r.repo === repo);
  if (opts.asOf) rows = rows.filter((r) => s(label === 'PR' ? r.mergedAt : r.createdAt) < opts.asOf!);
  return rows.slice(0, limit).map((r) => ({ node: r, score: num(r.score), sim: num(r.cos) }));
}

export async function similar(store: Store, repo: string, text: string, limit = 8, exclude?: string): Promise<Similar[]> {
  const vec = await embedOne(cleanText(text));
  const issues = hybrid(store, 'Issue', repo, vec, text, limit + 1).filter((h) => h.node.key !== exclude)
    .map((h) => ({ kind: 'issue' as const, number: num(h.node.number), title: s(h.node.title), url: s(h.node.url), state: s(h.node.state), score: h.score, sim: h.sim }));
  const prs = hybrid(store, 'PR', repo, vec, text, limit)
    .map((h) => ({ kind: 'pr' as const, number: num(h.node.number), title: s(h.node.title), url: s(h.node.url), score: h.score, sim: h.sim }));
  return [...issues, ...prs].sort((a, b) => b.sim - a.sim).slice(0, limit * 2);
}

/** Load a ticket from the graph: its text and stored embedding. */
function loadIssue(store: Store, repo: string, n: number | string) {
  const r = store.query('MATCH (i:Issue {key: $k}) RETURN i.title AS title, i.body AS body, i.url AS url, i.state AS state, i.createdAt AS createdAt, i.number AS number, i.ticket AS ticket, i.embedding AS embedding', { k: `${repo}#${n}` })[0];
  if (!r) throw new Error(`Ticket ${typeof n === 'number' ? '#' : ''}${n} is not in the graph for ${repo}. Run "ingest" first, or describe the change in text.`);
  return r;
}

export async function planTicket(store: Store, repo: string, target: { issue: number | string } | { text: string }, opts: PlanOptions = {}): Promise<Plan> {
  const t0 = Date.now();
  const q = store.query;
  const maxFiles = opts.files ?? 12;
  const k = opts.similar ?? 8;
  const use = { named: true, issues: true, prs: true, coChange: true, fulltext: true, vector: true, ...opts.use };
  const asOf = opts.asOf;

  let text: string;
  let selfKey: string | undefined;
  let tgt: Plan['target'];
  let vec: number[];
  if ('issue' in target) {
    selfKey = `${repo}#${target.issue}`;
    const r = loadIssue(store, repo, target.issue);
    text = `${s(r.title)}. ${s(r.body)}`;
    vec = (r.embedding as number[]) ?? (await embedOne(text));
    tgt = { kind: 'issue', number: num(r.number), ref: r.ticket ? s(r.ticket) : `#${num(r.number)}`, title: s(r.title), url: s(r.url), state: s(r.state) };
  } else {
    text = target.text;
    vec = await embedOne(cleanText(text));
    tgt = { kind: 'text', text };
  }

  const files = new Map<string, FileHit>();
  const add = (path: string, module: string, r: Reason) => {
    const f = files.get(path) ?? { path, module, score: 0, reasons: [] };
    f.score += NOISE.test(path) && r.kind !== 'named' ? r.score * 0.25 : r.score;
    f.reasons.push(r);
    files.set(path, f);
  };
  // In a replay, only pull requests merged before the moment count.
  const before = asOf ? 'AND x.mergedAt < $asOf' : '';

  // 1a. The ticket's own fix (never in a replay: that is the answer) and the files its text names.
  if (selfKey && !asOf) {
    for (const r of q(`MATCH (i:Issue {key: $k})<-[:FIXES]-(x:PR)-[:TOUCHES]->(f:File)-[:IN]->(m:Module)
                       RETURN f.path AS path, m.path AS module, x.number AS pr, x.title AS title`, { k: selfKey })) {
      add(s(r.path), s(r.module), { kind: 'fixed-by', text: `changed by PR #${num(r.pr)} that fixes this ticket`, via: `pr:${num(r.pr)}`, score: 1.2 });
    }
  }
  if (selfKey && use.named) {
    for (const r of q(`MATCH (i:Issue {key: $k})-[:NAMES]->(f:File)-[:IN]->(m:Module) RETURN f.path AS path, m.path AS module`, { k: selfKey })) {
      add(s(r.path), s(r.module), { kind: 'named', text: 'named in the ticket text', score: 1.0 });
    }
  }

  // 1b. Similar past tickets → the pull requests that fixed them → files.
  const hopts = { asOf, fulltext: use.fulltext, vector: use.vector };
  const simIssues = hybrid(store, 'Issue', repo, vec, text, k + 1, hopts).filter((h) => h.node.key !== selfKey).slice(0, k);
  const simPrs = hybrid(store, 'PR', repo, vec, text, k, hopts);
  // Weight each match by how similar it really is, relative to the best one; drop the noise.
  const weight = (sim: number, best: number) => (sim < MIN_SIM ? 0 : (sim - MIN_SIM) / Math.max(1e-6, best - MIN_SIM));
  const iBest = Math.max(0, ...simIssues.map((h) => h.sim)), pBest = Math.max(0, ...simPrs.map((h) => h.sim));
  if (use.issues) for (const h of simIssues) {
    const rel = weight(h.sim, iBest);
    if (rel <= 0) continue;
    for (const r of q(`MATCH (i:Issue {key: $k})<-[:FIXES]-(x:PR)-[:TOUCHES]->(f:File)-[:IN]->(m:Module)
                       WHERE x.fileCount <= ${MAX_PR_FILES} ${before} RETURN f.path AS path, m.path AS module, x.number AS pr`, { k: h.node.key, asOf })) {
      add(s(r.path), s(r.module), { kind: 'similar-issue', text: `similar ticket #${num(h.node.number)} "${s(h.node.title).slice(0, 70)}" was fixed by PR #${num(r.pr)}`, via: `issue:${num(h.node.number)}|pr:${num(r.pr)}`, score: 0.8 * rel });
    }
  }
  // 1c. Similar merged pull requests (many repos never link PRs to tickets) → files.
  if (use.prs) for (const h of simPrs) {
    const rel = weight(h.sim, pBest);
    if (rel <= 0) continue;
    for (const r of q(`MATCH (x:PR {key: $k})-[:TOUCHES]->(f:File)-[:IN]->(m:Module) WHERE x.fileCount <= ${MAX_PR_FILES}
                       RETURN f.path AS path, m.path AS module`, { k: h.node.key })) {
      add(s(r.path), s(r.module), { kind: 'similar-pr', text: `similar PR #${num(h.node.number)} "${s(h.node.title).slice(0, 70)}" changed it`, via: `pr:${num(h.node.number)}`, score: 0.6 * rel });
    }
  }

  // 2. Expand along co-change: files that historically move together with the strongest seeds.
  //    Live, this reads the precomputed CO_CHANGED edges; in a replay it counts only the PRs merged before asOf.
  if (use.coChange) {
    const seeds = [...files.values()].sort((a, b) => b.score - a.score).slice(0, 10);
    for (const sd of seeds) {
      const rows = asOf
        ? q(`MATCH (a:File {key: $k})<-[:TOUCHES]-(x:PR)-[:TOUCHES]->(b:File)-[:IN]->(m:Module)
             WHERE b.key <> $k AND x.mergedAt < $asOf AND x.fileCount >= 2 AND x.fileCount <= 30
             WITH b, m, count(DISTINCT x) AS c WHERE c >= 2 RETURN b.path AS path, m.path AS module, c ORDER BY c DESC LIMIT 6`,
            { k: `${repo}:${sd.path}`, asOf })
        : q(`MATCH (a:File {key: $k})-[e:CO_CHANGED]-(b:File)-[:IN]->(m:Module) RETURN b.path AS path, m.path AS module, e.count AS c ORDER BY c DESC LIMIT 6`,
            { k: `${repo}:${sd.path}` });
      for (const r of rows) {
        const c = num(r.c);
        add(s(r.path), s(r.module), { kind: 'co-change', text: `changed together with ${sd.path} in ${c} PRs`, via: `file:${sd.path}`, score: WEIGHTS.coChange * Math.min(1, c / 4) * Math.min(1, sd.score) });
      }
    }
  }

  // Tests usually follow the source they cover: rank the source file first when the evidence is the same.
  for (const f of files.values()) if (TEST.test(f.path)) f.score *= 0.92;
  const ranked = [...files.values()].sort((a, b) => b.score - a.score).slice(0, maxFiles);
  const max = Math.max(1e-9, ...ranked.map((f) => f.score));
  for (const f of ranked) {
    f.score = Math.round((f.score / max) * 100) / 100;
    f.reasons = f.reasons.sort((a, b) => b.score - a.score).slice(0, 4);
  }
  const cut = opts.minScore ?? 0.05;
  for (let i = ranked.length - 1; i >= 0; i--) if (ranked[i].score < cut) ranked.splice(i, 1);

  const modMap = new Map<string, { module: string; score: number; files: number }>();
  for (const f of ranked) {
    const m = modMap.get(f.module) ?? { module: f.module, score: 0, files: 0 };
    m.score += f.score; m.files++;
    modMap.set(f.module, m);
  }
  const modules = [...modMap.values()].sort((a, b) => b.score - a.score);

  // 3. People who changed these files the most.
  const keys = ranked.map((f) => `${repo}:${f.path}`);
  const experts: Expert[] = q(`MATCH (p:Person)-[:AUTHORED]->(x:PR)-[:TOUCHES]->(f:File) WHERE f.key IN $keys ${before}
      RETURN p.login AS login, count(DISTINCT x) AS changes, collect(DISTINCT f.path) AS files, max(x.mergedAt) AS last
      ORDER BY changes DESC LIMIT 6`, { keys, asOf })
    .map((r) => ({ login: s(r.login), changes: num(r.changes), files: (r.files as string[]).slice(0, 5), last: s(r.last).slice(0, 10) }))
    .filter((e) => !/\[bot\]$|^dependabot|^renovate/i.test(e.login)).slice(0, 5);

  // 4. Risks: open tickets that name these files or look alike, and recent bug fixes in the same files.
  const risks: Risk[] = [];
  for (const r of q(`MATCH (i:Issue)-[:NAMES]->(f:File) WHERE f.key IN $keys AND i.state = 'OPEN' AND i.key <> $self
      RETURN DISTINCT i.number AS number, i.title AS title, i.url AS url, f.path AS path LIMIT 5`, { keys, self: selfKey ?? '' })) {
    if (!risks.some((x) => x.number === num(r.number))) risks.push({ kind: 'open-issue', number: num(r.number), title: s(r.title), url: s(r.url), why: `open ticket that names ${s(r.path)}` });
  }
  for (const h of simIssues.filter((x) => x.node.state === 'OPEN' && x.sim >= MIN_SIM).slice(0, 3)) {
    if (!risks.some((x) => x.number === num(h.node.number))) risks.push({ kind: 'open-issue', number: num(h.node.number), title: s(h.node.title), url: s(h.node.url), why: 'open ticket about the same thing (hybrid search)' });
  }
  for (const r of q(`MATCH (x:PR)-[:FIXES]->(i:Issue)-[:LABELED]->(l:Label), (x)-[:TOUCHES]->(f:File)
      WHERE f.key IN $keys AND toLower(l.name) CONTAINS 'bug' AND i.key <> $self ${before}
      RETURN DISTINCT i.number AS number, i.title AS title, i.url AS url, x.number AS pr, x.mergedAt AS at, f.path AS path
      ORDER BY at DESC LIMIT 8`, { keys, self: selfKey ?? '', asOf })) {
    // One line per ticket, even when its fix touched several of the files.
    const prev = risks.find((x) => x.kind === 'recent-bug-fix' && x.number === num(r.number));
    if (prev) { if (!prev.why.includes(s(r.path))) prev.why = prev.why.replace(/: check for regressions$/, `, ${s(r.path)}: check for regressions`); continue; }
    risks.push({ kind: 'recent-bug-fix', number: num(r.number), title: s(r.title), url: s(r.url), why: `bug fixed by PR #${num(r.pr)} on ${s(r.at).slice(0, 10)} in ${s(r.path)}: check for regressions` });
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  const sim: Similar[] = [
    ...simIssues.map((h) => ({ kind: 'issue' as const, number: num(h.node.number), title: s(h.node.title), url: s(h.node.url), state: s(h.node.state), score: round(h.score), sim: round(h.sim) })),
    ...simPrs.map((h) => ({ kind: 'pr' as const, number: num(h.node.number), title: s(h.node.title), url: s(h.node.url), score: round(h.score), sim: round(h.sim) })),
  ].sort((a, b) => b.sim - a.sim);

  return { repo, target: tgt, files: ranked, modules, experts, risks, similar: sim, graph: toGraph(tgt, ranked, experts), tookMs: Date.now() - t0 };
}

/** The explanation as a small graph: target → (similar ticket / PR) → file → module, plus experts. */
export function toGraph(tgt: Plan['target'], files: FileHit[], experts: Expert[]): GraphView {
  const nodes = new Map<string, GraphView['nodes'][number]>();
  const edges: GraphView['edges'] = [];
  const root = tgt.kind === 'issue' ? `issue:${tgt.number}` : 'query';
  nodes.set(root, { id: root, label: tgt.kind === 'issue' ? tgt.ref : 'your ticket', type: 'target' });
  const node = (id: string, label: string, type: string, score?: number) => { if (!nodes.has(id)) nodes.set(id, { id, label, type, score }); };
  const edge = (from: string, to: string, type: string) => { if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, type }); };
  for (const f of files) {
    const fid = `file:${f.path}`;
    node(fid, f.path.split('/').pop()!, 'file', f.score);
    node(`module:${f.module}`, f.module, 'module');
    edge(fid, `module:${f.module}`, 'IN');
    for (const r of f.reasons.slice(0, 2)) {
      if (r.kind === 'named' || r.kind === 'fixed-by') { if (r.via) { node(r.via, `PR #${r.via.split(':')[1]}`, 'pr'); edge(root, r.via, 'FIXED_BY'); edge(r.via, fid, 'TOUCHES'); } else edge(root, fid, 'NAMES'); }
      else if (r.kind === 'similar-issue' && r.via) {
        const [iss, pr] = r.via.split('|');
        node(iss, `#${iss.split(':')[1]}`, 'issue'); node(pr, `PR #${pr.split(':')[1]}`, 'pr');
        edge(root, iss, 'SIMILAR'); edge(pr, iss, 'FIXES'); edge(pr, fid, 'TOUCHES');
      } else if (r.kind === 'similar-pr' && r.via) { node(r.via, `PR #${r.via.split(':')[1]}`, 'pr'); edge(root, r.via, 'SIMILAR'); edge(r.via, fid, 'TOUCHES'); }
      else if (r.kind === 'co-change' && r.via) { const src = `file:${r.via.slice(5)}`; if (nodes.has(src)) edge(src, fid, 'CO_CHANGED'); }
    }
  }
  for (const e of experts.slice(0, 4)) {
    node(`person:${e.login}`, `@${e.login}`, 'person');
    for (const p of e.files.slice(0, 3)) if (nodes.has(`file:${p}`)) edge(`person:${e.login}`, `file:${p}`, 'CHANGED');
  }
  return { nodes: [...nodes.values()], edges };
}

/** A readable Markdown brief, for the CLI and for agents. */
export function toMarkdown(r: Plan): string {
  const L: string[] = [];
  L.push(r.target.kind === 'issue' ? `# Groundwork for ${r.repo} ${r.target.ref}: ${r.target.title}` : `# Groundwork for: "${r.target.text.slice(0, 120)}"`);
  L.push('', '## Files most likely to change', '');
  r.files.forEach((f, i) => {
    L.push(`${i + 1}. \`${f.path}\` (${Math.round(f.score * 100)}%)`);
    for (const x of f.reasons.slice(0, 2)) L.push(`   - ${x.text}`);
  });
  if (!r.files.length) L.push('Nothing similar has been fixed before. Describe the change in more words, or this is new ground.');
  L.push('', '## Modules', '', ...r.modules.map((m) => `- ${m.module}: ${m.files} file(s)`));
  if (r.experts.length) L.push('', '## Who knows this code', '', ...r.experts.map((e) => `- @${e.login}: ${e.changes} merged PRs here (last ${e.last})`));
  if (r.risks.length) L.push('', '## Watch out for', '', ...r.risks.map((x) => `- #${x.number} ${x.title}: ${x.why}`));
  if (r.similar.length) L.push('', '## Similar past work', '', ...r.similar.slice(0, 8).map((x) => `- ${x.kind === 'pr' ? 'PR' : 'Ticket'} #${x.number} ${x.title}${x.state ? ` (${x.state.toLowerCase()})` : ''}`));
  L.push('', `_Answered from the Relate graph in ${r.tookMs} ms._`);
  return L.join('\n');
}
