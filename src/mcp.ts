// MCP server (stdio): gives a coding agent the connected context of a ticket before it edits code,
// and a check of its diff against that context before it opens the PR.
// Add to Claude Code:  claude mcp add groundwork -- npx tsx /path/to/groundwork/src/cli.ts mcp
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { planTicket, similar, toMarkdown } from './analyze.js';
import { checkChange, checkMarkdown } from './check.js';
import { withCode } from './code.js';
import { num, openStore, type Store } from './store.js';

const WRITE = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD|CALL\s+db\.|FOREACH)\b/i;

/** Read-only Cypher for agents: rejects anything that could change the graph, caps the rows. */
export function readOnlyCypher(store: Store, cypher: string, params: Record<string, unknown> = {}, maxRows = 50) {
  if (WRITE.test(cypher)) throw new Error('Only read queries (MATCH … RETURN) are allowed.');
  const rows = store.query(cypher, params).slice(0, maxRows);
  return JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : Array.isArray(v) && v.length > 64 && typeof v[0] === 'number' ? `[vector ${v.length}]` : v), 2);
}

export function whoKnows(store: Store, repo: string, path: string) {
  return store.query(`MATCH (p:Person)-[:AUTHORED]->(x:PR)-[:TOUCHES]->(f:File)
      WHERE f.repo = $repo AND (f.path = $path OR f.path STARTS WITH $prefix)
      RETURN p.login AS login, count(DISTINCT x) AS changes, max(x.mergedAt) AS last, collect(DISTINCT x.number)[0..5] AS prs
      ORDER BY changes DESC LIMIT 8`, { repo, path, prefix: path.endsWith('/') ? path : `${path}/` })
    .filter((r) => !/\[bot\]$/.test(String(r.login)))
    .map((r) => `- @${r.login}: ${num(r.changes)} merged PRs (last ${String(r.last).slice(0, 10)}; e.g. ${(r.prs as unknown[]).map((n) => `#${num(n)}`).join(', ')})`)
    .join('\n') || 'No merged pull requests touch that path in the graph.';
}

/**
 * GROUNDWORK_AS_OF (an ISO date) freezes the graph for plan_ticket: only PRs merged and tickets opened before it count,
 * so an agent evaluated on a past ticket never sees that ticket's fix or anything later.
 */
export function asOfFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.GROUNDWORK_AS_OF?.trim();
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`GROUNDWORK_AS_OF is not a date: ${v}`);
  return d.toISOString();
}

export async function planTicketTool(store: Store, args: { repo: string; issue?: number; text?: string; files?: number; code_dir?: string },
  env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { repo, issue, text: t, files, code_dir } = args;
  let r = await planTicket(store, repo, issue ? { issue } : { text: t! }, { files, asOf: asOfFromEnv(env) });
  const dir = code_dir ?? env.GROUNDWORK_CODE;
  if (dir) r = withCode(store, r, dir, files ?? 12);
  return toMarkdown(r);
}

const SCHEMA_TEXT = `Nodes: Repo{name} Issue{key,repo,number,title,body,state,url,labels} PR{key,repo,number,title,body,url,mergedAt,fileCount}
File{key,repo,path} Module{key,repo,path} Person{login} Label{key,name}
Relationships: (Person)-[:OPENED]->(Issue) (Person)-[:AUTHORED]->(PR) (PR)-[:FIXES]->(Issue) (PR)-[:TOUCHES {additions,deletions}]->(File)
(File)-[:IN]->(Module) (File)-[:CO_CHANGED {count}]->(File) (Issue)-[:NAMES]->(File) (Issue)-[:MENTIONS]->(Issue) (Issue)-[:LABELED]->(Label)`;

export async function runMcp() {
  asOfFromEnv(); // fail at start on a bad GROUNDWORK_AS_OF, not at the first call
  const store = openStore();
  const server = new McpServer({ name: 'groundwork', version: '1.0.0' });
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  server.registerTool('plan_ticket', {
    title: 'Groundwork for a ticket, before writing code',
    description: 'Call this first when you are given a ticket or a change to make. Returns the files and modules most likely to change, why (graph paths through the fixes of similar past tickets and PRs, files the ticket names, co-change history), who knows that code, and open tickets or recent bug fixes to watch. Pass a ticket number, or describe the change in text.',
    inputSchema: { repo: z.string().describe('owner/name, already ingested'), issue: z.number().int().optional(), text: z.string().optional(), files: z.number().int().min(3).max(30).optional(),
      code_dir: z.string().optional().describe('path of the local clone you are working in: also searches the code for the ticket’s words and fuses both rankings (more accurate)') },
  }, async ({ repo, issue, text: t, files, code_dir }) => {
    if (!issue && !t) return text('Pass either issue or text.');
    return text(await planTicketTool(store, { repo, issue, text: t, files, code_dir }));
  });

  server.registerTool('check_diff', {
    title: 'Check a change against its ticket',
    description: 'Before you commit or open a PR: pass the ticket and the files you changed. Returns which expected files are covered, which ones similar past fixes also changed but you did not (often a test or a sibling module), and which changed files are outside the ticket’s usual footprint.',
    inputSchema: { repo: z.string(), issue: z.number().int().optional(), text: z.string().optional(), changed: z.array(z.string()).min(1).describe('paths relative to the repository root') },
  }, async ({ repo, issue, text: t, changed }) => {
    if (!issue && !t) return text('Pass either issue or text.');
    return text(checkMarkdown(await checkChange(store, repo, issue ? { issue } : { text: t! }, changed)));
  });

  server.registerTool('similar_work', {
    title: 'Similar past tickets and pull requests',
    description: 'Hybrid search (local embeddings + full-text, fused with reciprocal rank fusion inside Relate) over the tickets and merged pull requests of a repository.',
    inputSchema: { repo: z.string(), text: z.string(), limit: z.number().int().min(1).max(20).optional() },
  }, async ({ repo, text: t, limit }) => {
    const xs = await similar(store, repo, t, limit ?? 8);
    return text(xs.map((x) => `- ${x.kind === 'pr' ? 'PR' : 'Issue'} #${x.number} ${x.title}${x.state ? ` (${x.state.toLowerCase()})` : ''} ${x.url}`).join('\n') || 'Nothing similar.');
  });

  server.registerTool('who_knows', {
    title: 'Who knows this code',
    description: 'People who authored the most merged pull requests touching a file or a folder.',
    inputSchema: { repo: z.string(), path: z.string().describe('a file path or a folder, e.g. src/middleware/cors') },
  }, async ({ repo, path }) => text(whoKnows(store, repo, path)));

  server.registerTool('graph_query', {
    title: 'Read-only Cypher over the repository graph',
    description: `Run a read-only Cypher query against the Relate graph for anything the other tools do not cover. ${SCHEMA_TEXT}`,
    inputSchema: { cypher: z.string(), params: z.record(z.string(), z.unknown()).optional() },
  }, async ({ cypher, params }) => {
    try { return text(readOnlyCypher(store, cypher, params ?? {})); } catch (e) { return text(`Error: ${(e as Error).message}`); }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`groundwork MCP server ready (graph: ${store.path})\n`);
}
