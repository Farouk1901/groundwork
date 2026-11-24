// Optional: add Jira tickets to a repository graph that is already ingested from GitHub.
// Teams that track work in Jira write the ticket key in the PR title, branch or body ("SHOP-142: keep = in cookies"),
// so a Jira ticket is linked to the PRs that mention its key, and from there to files, people and co-change.
//
// Source: Jira Cloud (JIRA_EMAIL + JIRA_API_TOKEN, read-only search) or a JSON export of /rest/api/3/search results.
import { readFileSync } from 'node:fs';
import { cleanText, embed } from './embed.js';
import { namedFiles } from './ingest.js';
import { num, type Store } from './store.js';

export type JiraTicket = {
  key: string; summary: string; description: string; status: 'OPEN' | 'CLOSED'; url: string;
  created: string; resolved: string | null; labels: string[]; reporter: string | null;
};

type AdfNode = { type?: string; text?: string; content?: AdfNode[] };
/** Jira Cloud v3 returns descriptions as Atlassian Document Format: keep the text. */
export function adfText(d: unknown): string {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  const out: string[] = [];
  const walk = (n: AdfNode) => {
    if (n.text) out.push(n.text);
    for (const c of n.content ?? []) walk(c);
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out.push('\n');
  };
  walk(d as AdfNode);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

type RawIssue = { key: string; fields: { summary?: string; description?: unknown; status?: { statusCategory?: { key?: string } ; name?: string };
  created?: string; resolutiondate?: string | null; labels?: string[]; reporter?: { displayName?: string } | null } };

export function fromJiraJson(raw: RawIssue[], site: string): JiraTicket[] {
  return raw.map((i) => ({
    key: i.key,
    summary: i.fields.summary ?? '',
    description: adfText(i.fields.description),
    status: i.fields.status?.statusCategory?.key === 'done' || i.fields.resolutiondate ? 'CLOSED' : 'OPEN',
    url: site ? `https://${site.replace(/^https?:\/\//, '').replace(/\/$/, '')}/browse/${i.key}` : '',
    created: i.fields.created ? new Date(i.fields.created).toISOString() : '',
    resolved: i.fields.resolutiondate ? new Date(i.fields.resolutiondate).toISOString() : null,
    labels: i.fields.labels ?? [],
    reporter: i.fields.reporter?.displayName ?? null,
  }));
}

export async function fetchJira(site: string, project: string, opts: { max?: number; log?: (s: string) => void } = {}): Promise<JiraTicket[]> {
  if (site.endsWith('.json')) {
    const j = JSON.parse(readFileSync(site, 'utf8')) as { issues?: RawIssue[]; site?: string } | RawIssue[];
    const issues = Array.isArray(j) ? j : j.issues ?? [];
    return fromJiraJson(issues.filter((i) => i.key.startsWith(`${project}-`)), Array.isArray(j) ? '' : j.site ?? '');
  }
  const email = process.env.JIRA_EMAIL, token = process.env.JIRA_API_TOKEN;
  if (!email || !token) throw new Error('Set JIRA_EMAIL and JIRA_API_TOKEN (an Atlassian API token with read access), or pass a JSON export.');
  const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const out: RawIssue[] = [];
  let next: string | undefined;
  do {
    const res = await fetch(`https://${host}/rest/api/3/search/jql`, {
      method: 'POST', headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql: `project = "${project}" ORDER BY updated DESC`, maxResults: 100, nextPageToken: next,
        fields: ['summary', 'description', 'status', 'created', 'resolutiondate', 'labels', 'reporter'] }),
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { issues: RawIssue[]; nextPageToken?: string };
    out.push(...j.issues);
    opts.log?.(`  jira: ${out.length}`);
    next = j.nextPageToken;
  } while (next && out.length < (opts.max ?? 1000));
  return fromJiraJson(out, host);
}

/** Ticket keys a PR mentions, e.g. "SHOP-142: keep = in cookie values". */
export function jiraKeys(text: string, project: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(`\\b${project}-(\\d+)\\b`, 'g'))].map((m) => `${project}-${m[1]}`))];
}

export async function ingestJira(store: Store, repo: string, tickets: JiraTicket[], log: (s: string) => void = () => {}) {
  const q = store.query;
  if (!tickets.length) return { tickets: 0, fixes: 0 };
  const project = tickets[0].key.split('-')[0];
  const text = tickets.map((t) => cleanText(`[${t.key}] ${t.summary}`, t.description));
  log(`Embedding ${tickets.length} Jira tickets locally…`);
  const vecs = await embed(text);
  const rows = tickets.map((t, k) => ({
    key: `${repo}#${t.key}`, number: Number(t.key.split('-')[1]), ticket: t.key, title: `[${t.key}] ${t.summary}`, body: text[k], state: t.status,
    url: t.url, createdAt: t.created, closedAt: t.resolved ?? '', labels: t.labels, embedding: vecs[k],
  }));
  q(`UNWIND $rows AS r MERGE (i:Issue {key: r.key})
     SET i.repo = $repo, i.number = r.number, i.ticket = r.ticket, i.source = 'jira', i.title = r.title, i.body = r.body, i.state = r.state,
         i.url = r.url, i.createdAt = r.createdAt, i.closedAt = r.closedAt, i.labels = r.labels, i.embedding = r.embedding`, { rows, repo });
  q(`UNWIND $rows AS r UNWIND r.labels AS l MERGE (lb:Label {key: $repo + ':' + l}) SET lb.name = l
     WITH lb, r MATCH (i:Issue {key: r.key}) MERGE (i)-[:LABELED]->(lb)`, { rows, repo });

  const prs = q('MATCH (x:PR) WHERE x.repo = $repo RETURN x.key AS key, x.title AS title, x.body AS body', { repo });
  const known = new Set(tickets.map((t) => t.key));
  const fixes = prs.flatMap((p) => jiraKeys(`${p.title}\n${p.body}`, project).filter((k) => known.has(k)).map((k) => ({ pr: String(p.key), issue: `${repo}#${k}` })));
  if (fixes.length) q('UNWIND $rows AS r MATCH (x:PR {key: r.pr}), (i:Issue {key: r.issue}) MERGE (x)-[:FIXES]->(i)', { rows: fixes });

  const files = q('MATCH (f:File) WHERE f.repo = $repo RETURN f.path AS p', { repo }).map((r) => String(r.p));
  const names = tickets.flatMap((t) => namedFiles(`${t.summary}\n${t.description}`, files).map((f) => ({ issue: `${repo}#${t.key}`, file: `${repo}:${f}` })));
  if (names.length) q('UNWIND $rows AS r MATCH (i:Issue {key: r.issue}), (f:File {key: r.file}) MERGE (i)-[:NAMES]->(f)', { rows: names });
  return { tickets: tickets.length, fixes: fixes.length, names: names.length, total: num(q('MATCH (i:Issue {source: "jira"}) RETURN count(i) AS n')[0]?.n) };
}
