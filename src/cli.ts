#!/usr/bin/env node
// groundwork CLI
//   ingest <owner/repo> [--prs 1500] [--issues 2000] [--refresh]  build the graph from GitHub (needs a token)
//   ingest --from examples/honojs__hono.json.gz                    build it from a snapshot (no token)
//   jira <site> <PROJECT> --repo owner/repo                        add Jira tickets to an ingested repo (optional)
//   plan <owner/repo> <ticket | "free text"> [--json]               the ticket's groundwork: files, people, risks, why
//   check <owner/repo> <ticket | "text"> [--staged] [--base main] [--files a,b] [--strict]
//                                                                   compare your diff with what the ticket predicts
//   eval <owner/repo> [--limit 200] [--fast] [--json]               backtest on real tickets, with baselines
//   similar <owner/repo> "text"                                     hybrid search over tickets and PRs
//   stats                                                           what is in the graph
//   serve [--port 7474]                                             web view
//   mcp                                                             MCP server on stdio, for coding agents
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fetchRepo } from './github.js';
import { readSnapshot, targetOf } from './util.js';
import { ingest } from './ingest.js';
import { planTicket, similar, toMarkdown } from './analyze.js';
import { checkChange, checkMarkdown, gitChangedFiles } from './check.js';
import { backtest, evalMarkdown } from './eval.js';
import { HOME, num, openStore } from './store.js';

const [cmd, ...rest] = process.argv.slice(2);
const BOOL = new Set(['json', 'refresh', 'staged', 'strict', 'fast']);
const flag = (k: string, d?: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const has = (k: string) => rest.includes(`--${k}`);
const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !BOOL.has(rest[i - 1].slice(2))));
const log = (s: string) => process.stderr.write(s + '\n');
async function main() {
  switch (cmd) {
    case 'ingest': {
      const from = flag('from');
      const data = from ? readSnapshot(from) : await (async () => {
        const repo = pos[0];
        if (!repo) throw new Error('Usage: groundwork ingest owner/repo   or   groundwork ingest --from snapshot.json.gz');
        return fetchRepo(repo, { prs: Number(flag('prs', '1500')), issues: Number(flag('issues', '2000')), refresh: has('refresh'), log });
      })();
      const store = openStore();
      const r = await ingest(store, data, log);
      log(`Graph ready in ${store.path}: ${r.nodes} nodes, ${r.rels} relationships.`);
      return;
    }
    case 'jira': {
      const [site, project] = pos;
      const repo = flag('repo');
      if (!site || !project || !repo) throw new Error('Usage: groundwork jira <your-site.atlassian.net | export.json> <PROJECT> --repo owner/repo');
      const { fetchJira, ingestJira } = await import('./jira.js');
      const tickets = await fetchJira(site, project, { max: Number(flag('max', '1000')), log });
      const r = await ingestJira(openStore(), repo, tickets, log);
      log(`Added ${r.tickets} Jira tickets, ${r.fixes} linked to pull requests by key.`);
      return;
    }
    case 'plan':
    case 'blast': {
      const [repo, what] = pos;
      if (!repo || !what) throw new Error('Usage: groundwork plan owner/repo <ticket-number | "describe the change">');
      const r = await planTicket(openStore(), repo, targetOf(what), { files: Number(flag('files', '12')) });
      console.log(has('json') ? JSON.stringify(r, null, 2) : toMarkdown(r));
      return;
    }
    case 'check': {
      const [repo, what] = pos;
      if (!repo || !what) throw new Error('Usage: groundwork check owner/repo <ticket | "text"> [--staged] [--base main] [--files a,b] [--cwd path]');
      const files = flag('files')?.split(',').map((x) => x.trim()).filter(Boolean)
        ?? gitChangedFiles({ cwd: flag('cwd'), staged: has('staged'), base: flag('base') });
      if (!files.length) throw new Error('No changed files: pass --files, or run it inside a clone with changes.');
      const r = await checkChange(openStore(), repo, targetOf(what), files, { threshold: Number(flag('threshold', '0.5')) });
      console.log(has('json') ? JSON.stringify({ ...r, plan: undefined, target: r.plan.target }, null, 2) : checkMarkdown(r));
      if (has('strict') && !r.ok) process.exitCode = 1;
      return;
    }
    case 'eval': {
      const repo = pos[0];
      if (!repo) throw new Error('Usage: groundwork eval owner/repo [--limit 200] [--fast]');
      const r = await backtest(openStore(), repo, { limit: Number(flag('limit', '0')) || undefined, ablations: !has('fast'), split: flag('split') as 'older' | 'newer' | undefined, log });
      mkdirSync(path.join(HOME, 'eval'), { recursive: true });
      const out = path.join(HOME, 'eval', `${repo.replace('/', '__')}${flag('split') ? '.' + flag('split') : ''}.json`);
      writeFileSync(out, JSON.stringify(r, null, 2));
      console.log(has('json') ? JSON.stringify(r, null, 2) : evalMarkdown(r));
      log(`Saved ${out} (the web view shows it).`);
      return;
    }
    case 'similar': {
      const [repo, text] = pos;
      if (!repo || !text) throw new Error('Usage: groundwork similar owner/repo "text"');
      for (const x of await similar(openStore(), repo, text)) console.log(`${x.kind === 'pr' ? 'PR    ' : 'Ticket'} #${x.number}  ${x.sim.toFixed(3)}  ${x.title}`);
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
      console.log(`groundwork: the connected context of a ticket, before the first line of code.

  ingest owner/repo | ingest --from snapshot.json.gz     build the Relate graph
  plan   owner/repo <ticket | "text">                     files, people, risks, and the graph path behind each
  check  owner/repo <ticket | "text"> [--staged]          is your diff missing what similar fixes changed?
  eval   owner/repo                                       backtest on real tickets, with baselines
  similar | stats | serve | mcp | jira                    see README.md`);
  }
}

main().catch((e) => { log(`Error: ${(e as Error).message}`); process.exit(1); });
