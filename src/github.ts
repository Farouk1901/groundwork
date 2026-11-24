// Reads a public (or private, with access) GitHub repository through the GraphQL API:
// merged pull requests with their changed files and the issues they close, plus issues (open and closed).
// Raw responses are cached on disk, so a re-run or a demo works offline.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOME } from './store.js';

export type GhIssue = {
  number: number; title: string; body: string; state: 'OPEN' | 'CLOSED'; url: string;
  createdAt: string; closedAt: string | null; author: string | null; labels: string[];
};
export type GhPR = {
  number: number; title: string; body: string; url: string; mergedAt: string; author: string | null;
  files: { path: string; additions: number; deletions: number }[];
  closes: number[]; labels: string[];
};
export type RepoData = { repo: string; fetchedAt: string; issues: GhIssue[]; prs: GhPR[] };

export function githubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

export async function gql<T>(token: string, query: string, variables: Record<string, unknown>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'groundwork' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (!res.ok || json.errors?.length) throw new Error(json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`);
      return json.data as T;
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const PRS = `query($owner:String!,$name:String!,$after:String,$n:Int!){repository(owner:$owner,name:$name){
  pullRequests(states:MERGED, first:$n, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number title body url mergedAt author{login}
      labels(first:10){nodes{name}}
      files(first:100){nodes{path additions deletions}}
      closingIssuesReferences(first:10){nodes{number repository{nameWithOwner}}}}}}}`;

const ISSUES = `query($owner:String!,$name:String!,$after:String,$n:Int!){repository(owner:$owner,name:$name){
  issues(first:$n, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number title body state url createdAt closedAt author{login} labels(first:10){nodes{name}}}}}}`;

type Page<N> = { repository: Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: N[] }> };

async function pages<N>(token: string, query: string, key: string, owner: string, name: string, limit: number, size: number, log: (s: string) => void) {
  const out: N[] = [];
  let after: string | null = null;
  while (out.length < limit) {
    const d: Page<N> = await gql<Page<N>>(token, query, { owner, name, after, n: Math.min(size, limit - out.length) });
    const conn = d.repository[key];
    out.push(...conn.nodes);
    log(`  ${key}: ${out.length}`);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

export async function fetchRepo(repo: string, opts: { prs?: number; issues?: number; cacheDir?: string; refresh?: boolean; log?: (s: string) => void } = {}): Promise<RepoData> {
  const log = opts.log ?? (() => {});
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('Repository must look like owner/name');
  const cacheDir = opts.cacheDir ?? path.join(HOME, 'cache');
  const file = path.join(cacheDir, `${owner}__${name}.json`);
  if (!opts.refresh && existsSync(file)) {
    log(`Using cached ${file}`);
    return JSON.parse(readFileSync(file, 'utf8')) as RepoData;
  }
  const token = githubToken();
  if (!token) throw new Error('Set GITHUB_TOKEN (any token with public read access) or sign in with `gh auth login`.');

  type RawPR = { number: number; title: string; body: string; url: string; mergedAt: string; author: { login: string } | null;
    labels: { nodes: { name: string }[] }; files: { nodes: { path: string; additions: number; deletions: number }[] } | null;
    closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] } };
  type RawIssue = { number: number; title: string; body: string; state: 'OPEN' | 'CLOSED'; url: string; createdAt: string; closedAt: string | null;
    author: { login: string } | null; labels: { nodes: { name: string }[] } };

  log(`Fetching ${repo} from GitHub…`);
  const rawPrs = await pages<RawPR>(token, PRS, 'pullRequests', owner, name, opts.prs ?? 400, 25, log);
  const rawIssues = await pages<RawIssue>(token, ISSUES, 'issues', owner, name, opts.issues ?? 800, 100, log);

  const data: RepoData = {
    repo, fetchedAt: new Date().toISOString(),
    prs: rawPrs.map((p) => ({
      number: p.number, title: p.title, body: p.body ?? '', url: p.url, mergedAt: p.mergedAt, author: p.author?.login ?? null,
      labels: p.labels.nodes.map((l) => l.name),
      files: (p.files?.nodes ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      closes: p.closingIssuesReferences.nodes.filter((r) => r.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()).map((r) => r.number),
    })),
    issues: rawIssues.map((i) => ({
      number: i.number, title: i.title, body: i.body ?? '', state: i.state, url: i.url, createdAt: i.createdAt, closedAt: i.closedAt,
      author: i.author?.login ?? null, labels: i.labels.nodes.map((l) => l.name),
    })),
  };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}

const RECENT = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  pullRequests(states:MERGED, first:50, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number title body mergedAt updatedAt files(first:100){nodes{path}}
      closingIssuesReferences(first:10){nodes{number repository{nameWithOwner}}}}}}}`;

/** Pull requests merged after `since` and the tickets of the same repository they close (links or "fixes #12"). */
export async function fixesSince(repo: string, since: string, log: (s: string) => void = () => {}) {
  const token = githubToken();
  if (!token) throw new Error('Set GITHUB_TOKEN or sign in with `gh auth login`.');
  const [owner, name] = repo.split('/');
  type N = { number: number; title: string; body: string; mergedAt: string; updatedAt: string; files: { nodes: { path: string }[] } | null;
    closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] } };
  const out: { repo: string; issue: number; pr: number; mergedAt: string; files: string[] }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const d: { repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: N[] } } } =
      await gql(token, RECENT, { owner, name, after });
    const conn = d.repository.pullRequests;
    for (const p of conn.nodes) {
      if (p.mergedAt <= since) continue;
      const closes = new Set(p.closingIssuesReferences.nodes.filter((r) => r.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()).map((r) => r.number));
      for (const m of `${p.title}\n${p.body ?? ''}`.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) closes.add(Number(m[1]));
      for (const issue of closes) out.push({ repo, issue, pr: p.number, mergedAt: p.mergedAt, files: (p.files?.nodes ?? []).map((f) => f.path) });
    }
    // Ordered by last update: once a page is entirely older than the seal, nothing later can be newer.
    if (!conn.pageInfo.hasNextPage || conn.nodes.every((p) => p.updatedAt <= since)) break;
    after = conn.pageInfo.endCursor;
  }
  log(`  ${repo}: ${out.length} ticket fixes merged since ${since.slice(0, 10)}`);
  return out;
}
