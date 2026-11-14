// MCP server (stdio): gives a coding agent the connected context of a repository before it edits code.
// Add to Claude Code:  claude mcp add blast-radius -- npx tsx /path/to/blast-radius/src/cli.ts mcp
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { blastRadius, similar, toMarkdown } from './analyze.js';
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

const SCHEMA_TEXT = `Nodes: Repo{name} Issue{key,repo,number,title,body,state,url,labels} PR{key,repo,number,title,body,url,mergedAt,fileCount}
File{key,repo,path} Module{key,repo,path} Person{login} Label{key,name}
Relationships: (Person)-[:OPENED]->(Issue) (Person)-[:AUTHORED]->(PR) (PR)-[:FIXES]->(Issue) (PR)-[:TOUCHES {additions,deletions}]->(File)
(File)-[:IN]->(Module) (File)-[:CO_CHANGED {count}]->(File) (Issue)-[:NAMES]->(File) (Issue)-[:MENTIONS]->(Issue) (Issue)-[:LABELED]->(Label)`;

export async function runMcp() {
  const store = openStore();
  const server = new McpServer({ name: 'blast-radius', version: '0.1.0' });
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  server.registerTool('blast_radius', {
    title: 'Blast radius of an issue or a planned change',
    description: 'Before editing code for an issue, call this. Returns the files and modules most likely to change, why (graph paths through similar past fixes, files named in the issue, co-change history), who knows that code, and open issues or recent bug fixes to watch. Pass an issue number, or describe the change in text.',
    inputSchema: { repo: z.string().describe('owner/name, already ingested'), issue: z.number().int().optional(), text: z.string().optional(), files: z.number().int().min(3).max(30).optional() },
  }, async ({ repo, issue, text: t, files }) => {
    if (!issue && !t) return text('Pass either issue or text.');
    const r = await blastRadius(store, repo, issue ? { issue } : { text: t! }, { files });
    return text(toMarkdown(r));
  });

  server.registerTool('similar_work', {
    title: 'Similar past issues and pull requests',
    description: 'Hybrid search (local embeddings + full-text, fused with reciprocal rank fusion inside Relate) over the issues and merged pull requests of a repository.',
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
  process.stderr.write(`blast-radius MCP server ready (graph: ${store.path})\n`);
}
