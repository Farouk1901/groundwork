#!/usr/bin/env node
// blast-radius CLI
//   ingest <owner/repo> [--prs 400] [--issues 800] [--refresh]   build the graph from GitHub
//   blast <owner/repo> <issue-number | "free text"> [--json]       what will this change touch?
//   similar <owner/repo> "text"                                     hybrid search over issues and PRs
//   stats                                                            what is in the graph
//   serve [--port 7474]                                              web view
//   mcp                                                              MCP server on stdio, for coding agents
import { fetchRepo } from './github.js';
import { ingest } from './ingest.js';
import { blastRadius, similar, toMarkdown } from './analyze.js';
import { num, openStore } from './store.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const has = (k: string) => rest.includes(`--${k}`);
const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !['--json', '--refresh'].includes(rest[i - 1])));
const log = (s: string) => process.stderr.write(s + '\n');

async function main() {
  switch (cmd) {
    case 'ingest': {
      const repo = pos[0];
      if (!repo) throw new Error('Usage: blast-radius ingest owner/repo');
      const data = await fetchRepo(repo, { prs: Number(flag('prs', '400')), issues: Number(flag('issues', '800')), refresh: has('refresh'), log });
      const store = openStore();
      const r = await ingest(store, data, log);
      log(`Graph ready in ${store.path}: ${r.nodes} nodes, ${r.rels} relationships.`);
      return;
    }
    case 'blast': {
      const [repo, what] = pos;
      if (!repo || !what) throw new Error('Usage: blast-radius blast owner/repo <issue-number | "text">');
      const store = openStore();
      const target = /^#?\d+$/.test(what) ? { issue: Number(what.replace('#', '')) } : { text: what };
      const r = await blastRadius(store, repo, target, { files: Number(flag('files', '12')) });
      console.log(has('json') ? JSON.stringify(r, null, 2) : toMarkdown(r));
      return;
    }
    case 'similar': {
      const [repo, text] = pos;
      const store = openStore();
      for (const x of await similar(store, repo, text)) console.log(`${x.kind === 'pr' ? 'PR   ' : 'Issue'} #${x.number}  ${x.score.toFixed(3)}  ${x.title}`);
      return;
    }
    case 'stats': {
      const store = openStore();
      for (const r of store.query('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC')) console.log(`${String(r.label).padEnd(8)} ${num(r.n)}`);
      for (const r of store.query('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY n DESC')) console.log(`${String(r.type).padEnd(12)} ${num(r.n)}`);
      return;
    }
    case 'serve': {
      const { serve } = await import('./web.js');
      serve(Number(flag('port', '7474')));
      return;
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      await runMcp();
      return;
    }
    default:
      console.log('blast-radius: ingest | blast | similar | stats | serve | mcp   (see README)');
  }
}

main().catch((e) => { log(`Error: ${(e as Error).message}`); process.exit(1); });
