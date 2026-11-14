// Turns GitHub data into a connected graph in Relate:
//   (Person)-[:AUTHORED]->(PR)-[:FIXES]->(Issue)<-[:OPENED]-(Person)
//   (PR)-[:TOUCHES]->(File)-[:IN]->(Module)      (File)-[:CO_CHANGED {count}]->(File)
//   (Issue)-[:NAMES]->(File)   (Issue)-[:MENTIONS]->(Issue)   (Issue)-[:LABELED]->(Label)
// Text and a local embedding are stored on every Issue and PR for hybrid search.
import type { RepoData } from './github.js';
import { cleanText, embed } from './embed.js';
import { ensureSearchIndexes, num, type Store } from './store.js';

const MAX_FILES_FOR_COCHANGE = 30; // huge PRs (renames, formatting) say little about which files belong together

export function moduleOf(file: string): string {
  const parts = file.split('/');
  if (parts.length <= 1) return '(root)';
  const deep = ['packages', 'apps', 'libs', 'src', 'lib', 'services', 'crates', 'modules'];
  return deep.includes(parts[0]) && parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
}

/** Paths (or unique file names) of known files that an issue's text mentions. */
export function namedFiles(text: string, files: string[]): string[] {
  const found = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const n = f.split('/').pop()!;
    byName.set(n, [...(byName.get(n) ?? []), f]);
  }
  const lower = text.toLowerCase();
  for (const f of files) if (f.includes('/') && lower.includes(f.toLowerCase())) found.add(f);
  for (const m of text.matchAll(/\b([\w.-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|swift|vue|svelte|css|scss|md|json|yml|yaml|toml))\b/g)) {
    const hits = byName.get(m[1]);
    if (hits?.length === 1) found.add(hits[0]);
  }
  return [...found];
}

export function mentionedIssues(text: string, self: number): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?:^|[\s(,])#(\d{1,7})\b/g)) {
    const n = Number(m[1]);
    if (n !== self) out.add(n);
  }
  return [...out];
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function ingest(store: Store, data: RepoData, log: (s: string) => void = () => {}) {
  const repo = data.repo;
  const q = store.query;
  q('MERGE (r:Repo {name: $repo}) SET r.fetchedAt = $at', { repo, at: data.fetchedAt });

  // ---------- text + embeddings ----------
  const issueText = data.issues.map((i) => cleanText(i.title, i.body));
  const prText = data.prs.map((p) => cleanText(p.title, p.body));
  log(`Embedding ${issueText.length + prText.length} issues and pull requests locally…`);
  const vectors = await embed([...issueText, ...prText], 32, (d) => { if (d % 256 === 0) log(`  ${d}`); });
  const iv = vectors.slice(0, issueText.length), pv = vectors.slice(issueText.length);

  // ---------- nodes ----------
  for (const batch of chunks(data.issues.map((i, k) => ({
    key: `${repo}#${i.number}`, number: i.number, title: i.title, body: issueText[k], state: i.state, url: i.url,
    createdAt: i.createdAt, closedAt: i.closedAt ?? '', author: i.author ?? '', labels: i.labels, embedding: iv[k],
  })), 200)) {
    q(`UNWIND $rows AS r MERGE (i:Issue {key: r.key})
       SET i.repo = $repo, i.number = r.number, i.title = r.title, i.body = r.body, i.state = r.state, i.url = r.url,
           i.createdAt = r.createdAt, i.closedAt = r.closedAt, i.labels = r.labels, i.embedding = r.embedding`, { rows: batch, repo });
    q(`UNWIND $rows AS r WITH r WHERE r.author <> '' MERGE (p:Person {login: r.author}) WITH p, r MATCH (i:Issue {key: r.key}) MERGE (p)-[:OPENED]->(i)`, { rows: batch });
    q(`UNWIND $rows AS r UNWIND r.labels AS l MERGE (lb:Label {key: $repo + ':' + l}) SET lb.name = l
       WITH lb, r MATCH (i:Issue {key: r.key}) MERGE (i)-[:LABELED]->(lb)`, { rows: batch, repo });
  }
  log(`  ${data.issues.length} issues`);

  for (const batch of chunks(data.prs.map((p, k) => ({
    key: `${repo}!${p.number}`, number: p.number, title: p.title, body: prText[k], url: p.url, mergedAt: p.mergedAt,
    author: p.author ?? '', fileCount: p.files.length, embedding: pv[k],
  })), 200)) {
    q(`UNWIND $rows AS r MERGE (x:PR {key: r.key})
       SET x.repo = $repo, x.number = r.number, x.title = r.title, x.body = r.body, x.url = r.url, x.mergedAt = r.mergedAt,
           x.fileCount = r.fileCount, x.embedding = r.embedding`, { rows: batch, repo });
    q(`UNWIND $rows AS r WITH r WHERE r.author <> '' MERGE (p:Person {login: r.author}) WITH p, r MATCH (x:PR {key: r.key}) MERGE (p)-[:AUTHORED]->(x)`, { rows: batch });
  }
  log(`  ${data.prs.length} pull requests`);

  // ---------- files, modules, touches ----------
  const allFiles = [...new Set(data.prs.flatMap((p) => p.files.map((f) => f.path)))];
  for (const batch of chunks(allFiles.map((f) => ({ key: `${repo}:${f}`, path: f, module: moduleOf(f) })), 500)) {
    q(`UNWIND $rows AS r MERGE (f:File {key: r.key}) SET f.repo = $repo, f.path = r.path
       MERGE (m:Module {key: $repo + ':' + r.module}) SET m.path = r.module, m.repo = $repo
       MERGE (f)-[:IN]->(m)`, { rows: batch, repo });
  }
  const touches = data.prs.flatMap((p) => p.files.map((f) => ({ pr: `${repo}!${p.number}`, file: `${repo}:${f.path}`, add: f.additions, del: f.deletions })));
  for (const batch of chunks(touches, 500)) {
    q(`UNWIND $rows AS r MATCH (x:PR {key: r.pr}), (f:File {key: r.file}) MERGE (x)-[t:TOUCHES]->(f) SET t.additions = r.add, t.deletions = r.del`, { rows: batch });
  }
  log(`  ${allFiles.length} files, ${touches.length} file changes`);

  // ---------- PR fixes issue ----------
  const issueNumbers = new Set(data.issues.map((i) => i.number));
  const fixes = data.prs.flatMap((p) => {
    const closes = new Set(p.closes);
    // Also "Fixes #12" written in the PR body, which GitHub links only for the default branch.
    for (const m of `${p.title}\n${p.body}`.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) closes.add(Number(m[1]));
    return [...closes].filter((n) => issueNumbers.has(n)).map((n) => ({ pr: `${repo}!${p.number}`, issue: `${repo}#${n}` }));
  });
  for (const batch of chunks(fixes, 500)) q(`UNWIND $rows AS r MATCH (x:PR {key: r.pr}), (i:Issue {key: r.issue}) MERGE (x)-[:FIXES]->(i)`, { rows: batch });
  log(`  ${fixes.length} pull request → issue fixes`);

  // ---------- issue text names files, mentions other issues ----------
  const names = data.issues.flatMap((i) => namedFiles(`${i.title}\n${i.body}`, allFiles).map((f) => ({ issue: `${repo}#${i.number}`, file: `${repo}:${f}` })));
  for (const batch of chunks(names, 500)) q(`UNWIND $rows AS r MATCH (i:Issue {key: r.issue}), (f:File {key: r.file}) MERGE (i)-[:NAMES]->(f)`, { rows: batch });
  const mentions = data.issues.flatMap((i) => mentionedIssues(i.body, i.number).filter((n) => issueNumbers.has(n)).map((n) => ({ a: `${repo}#${i.number}`, b: `${repo}#${n}` })));
  for (const batch of chunks(mentions, 500)) q(`UNWIND $rows AS r MATCH (a:Issue {key: r.a}), (b:Issue {key: r.b}) MERGE (a)-[:MENTIONS]->(b)`, { rows: batch });
  log(`  ${names.length} issue → file names, ${mentions.length} issue mentions`);

  // ---------- co-change ----------
  const pairs = new Map<string, number>();
  for (const p of data.prs) {
    const fs = [...new Set(p.files.map((f) => f.path))].sort();
    if (fs.length < 2 || fs.length > MAX_FILES_FOR_COCHANGE) continue;
    for (let a = 0; a < fs.length; a++) for (let b = a + 1; b < fs.length; b++) {
      const k = `${fs[a]}\u0000${fs[b]}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const co = [...pairs].filter(([, c]) => c >= 2).map(([k, c]) => { const [a, b] = k.split('\u0000'); return { a: `${repo}:${a}`, b: `${repo}:${b}`, c }; });
  for (const batch of chunks(co, 500)) q(`UNWIND $rows AS r MATCH (a:File {key: r.a}), (b:File {key: r.b}) MERGE (a)-[e:CO_CHANGED]->(b) SET e.count = r.c`, { rows: batch });
  log(`  ${co.length} co-change links (files changed together at least twice)`);

  ensureSearchIndexes(store);
  const counts = q('MATCH (n) RETURN count(n) AS nodes')[0];
  const rels = q('MATCH ()-[r]->() RETURN count(r) AS rels')[0];
  return { nodes: num(counts.nodes), rels: num(rels.rels), issues: data.issues.length, prs: data.prs.length, files: allFiles.length, fixes: fixes.length, coChange: co.length };
}
