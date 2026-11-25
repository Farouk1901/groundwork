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
import { fetchRepo, type RepoData } from './github.js';
import { readSnapshot, targetOf } from './util.js';
import { ingest } from './ingest.js';
import { planTicket, similar, toMarkdown } from './analyze.js';
import { checkChange, checkMarkdown } from './check.js';
import { gitChangedFiles } from './git.js';
import { backtest, evalMarkdown } from './eval.js';
import { HOME, num, openStore } from './store.js';

const [cmd, ...rest] = process.argv.slice(2);
const BOOL = new Set(['json', 'refresh', 'staged', 'strict', 'fast', 'dry-run']);
const flag = (k: string, d?: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const has = (k: string) => rest.includes(`--${k}`);
const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !BOOL.has(rest[i - 1].slice(2))));
const log = (s: string) => process.stderr.write(s + '\n');
async function main() {
  switch (cmd) {
    case 'ingest': {
      const from = flag('from');
      // --max-age 7: keep a graph that is less than 7 days old (the GitHub Action caches it between tickets).
      const store = openStore();
      if (flag('max-age') && pos[0]) {
        const at = String(store.query('MATCH (r:Repo {name: $repo}) RETURN r.fetchedAt AS at', { repo: pos[0] })[0]?.at ?? '');
        if (at && Date.now() - Date.parse(at) < Number(flag('max-age')) * 86_400_000) { log(`Graph for ${pos[0]} is from ${at.slice(0, 10)}: kept.`); return; }
      }
      const snap: { data: RepoData; vectors?: number[][] } = from ? readSnapshot(from) : await (async () => {
        const repo = pos[0];
        if (!repo) throw new Error('Usage: groundwork ingest owner/repo   or   groundwork ingest --from snapshot.json.gz');
        return { data: await fetchRepo(repo, { prs: Number(flag('prs', '1500')), issues: Number(flag('issues', '2000')), refresh: has('refresh'), log }) };
      })();
      const r = await ingest(store, snap.data, log, { vectors: snap.vectors });
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
      const store = openStore();
      let r = await planTicket(store, repo, targetOf(what), { files: Number(flag('files', '12')) });
      // --code <clone>: also search the code for the ticket's words and fuse (Hit@5 77% → 82% on hono).
      const codeDir = flag('code') ?? process.env.GROUNDWORK_CODE;
      if (codeDir) r = (await import('./code.js')).withCode(store, r, codeDir, Number(flag('files', '12')));
      console.log(has('json') ? JSON.stringify(r, null, 2) : toMarkdown(r));
      return;
    }
    case 'check': {
      const [repo, what] = pos;
      if (!repo || !what) throw new Error('Usage: groundwork check owner/repo <ticket | "text"> [--staged] [--base main] [--files a,b] [--cwd path]');
      const files = flag('files')?.split(',').map((x) => x.trim()).filter(Boolean)
        ?? gitChangedFiles({ cwd: flag('cwd'), staged: has('staged'), base: flag('base') });
      if (!files.length) throw new Error('No changed files: pass --files, or run it inside a clone with changes.');
      const store = openStore();
      const codeDir = flag('code') ?? process.env.GROUNDWORK_CODE;
      const { withCode } = await import('./code.js');
      const r = await checkChange(store, repo, targetOf(what), files, { threshold: Number(flag('threshold', '0.5')),
        refine: codeDir ? (p) => withCode(store, p, codeDir, 15) : undefined });
      console.log(has('json') ? JSON.stringify({ ...r, plan: undefined, target: r.plan.target }, null, 2) : checkMarkdown(r));
      if (has('strict') && !r.ok) process.exitCode = 1;
      return;
    }
    case 'eval': {
      const repo = pos[0];
      if (!repo) throw new Error('Usage: groundwork eval owner/repo [--limit 200] [--fast]');
      const r = await backtest(openStore(), repo, { limit: Number(flag('limit', '0')) || undefined, ablations: !has('fast'), split: flag('split') as 'older' | 'newer' | undefined, mode: flag('mode') === 'prs' ? 'prs' : 'tickets', clone: flag('clone'), log });
      mkdirSync(path.join(HOME, 'eval'), { recursive: true });
      const out = path.join(HOME, 'eval', `${repo.replace('/', '__')}${flag('mode') === 'prs' ? '.prs' : ''}${flag('split') ? '.' + flag('split') : ''}${flag('clone') ? '.grep' : ''}.json`);
      writeFileSync(out, JSON.stringify(r, null, 2));
      console.log(has('json') ? JSON.stringify(r, null, 2) : evalMarkdown(r));
      log(`Saved ${out} (the web view shows it).`);
      return;
    }
    case 'predict': {
      // groundwork predict honojs/hono vitest-dev/vitest relatedb/relate --out docs/predictions
      if (!pos.length) throw new Error('Usage: groundwork predict owner/repo [owner/repo …] [--out docs/predictions]');
      const { seal, sha256Hex } = await import('./predict.js');
      const out = flag('out', 'docs/predictions')!;
      mkdirSync(out, { recursive: true });
      const sealed = await seal(openStore(), pos, log);
      const json = JSON.stringify(sealed, null, 1) + '\n';
      const hash = sha256Hex(json);
      writeFileSync(path.join(out, 'sealed.json'), json);
      writeFileSync(path.join(out, 'sealed.sha256'), `${hash}  sealed.json\n`);
      log(`Sealed ${sealed.repos.reduce((a, r) => a + r.forecasts.length, 0)} forecasts in ${path.join(out, 'sealed.json')} (sha256 ${hash}).`);
      return;
    }
    case 'seal-daily': {
      // groundwork seal-daily honojs/hono vitest-dev/vitest relatedb/relate [--dir docs/predictions] [--date YYYY-MM-DD] [--dry-run]
      const { existsSync } = await import('node:fs');
      const { loadAllSeals, sealDailyNewIssues, writeDailySealFile } = await import('./predict.js');
      const { githubToken, issuesWithLinkedPRs } = await import('./github.js');
      const repos = pos.length ? pos : ['honojs/hono', 'vitest-dev/vitest', 'relatedb/relate'];
      const dir = flag('dir', 'docs/predictions')!;
      const targetDate = flag('date') ?? new Date().toISOString().slice(0, 10);
      const targetFile = path.join(dir, 'daily', `${targetDate}.json`);
      if (!has('dry-run') && existsSync(targetFile)) {
        throw new Error(`Daily seal ${targetDate}.json already exists (append-only: refusing to overwrite existing forecasts).`);
      }
      const existing = loadAllSeals(dir);
      const hasToken = !!githubToken();
      const res = await sealDailyNewIssues(openStore(), repos, existing, {
        date: targetDate,
        log,
        findLinkedPrs: hasToken ? (repo, since) => issuesWithLinkedPRs(repo, since, log) : undefined,
      });
      if (has('dry-run')) {
        console.log(JSON.stringify({ date: res.daily.date, count: res.count, sha256: res.sha256, checkedLinkedPrs: hasToken, dryRun: true }, null, 2));
        return;
      }
      writeDailySealFile(dir, res.daily.date, res.json, res.sha256);
      log(`Daily seal ${res.daily.date}: ${res.count} new open issues, sha256 ${res.sha256}`);
      return;
    }
    case 'score-predictions': {
      // Reads GitHub (needs a token), not the graph. --until freezes the score at a date (the contest deadline).
      const { readFileSync, existsSync } = await import('node:fs');
      const { loadAllSeals, score, shouldSkipFrozenScore } = await import('./predict.js');
      const { fixesSince } = await import('./github.js');
      const dir = flag('dir', 'docs/predictions')!;
      const seals = loadAllSeals(dir);
      if (!seals.length) throw new Error(`No sealed forecasts found in ${dir}`);
      const until = flag('until');
      const scoreFile = path.join(dir, 'score.json');
      const existingScore = existsSync(scoreFile) ? JSON.parse(readFileSync(scoreFile, 'utf8')) : null;
      if (shouldSkipFrozenScore(existingScore, until)) {
        log(`Frozen since ${until}: score.json is final.`);
        return;
      }
      const earliestSealedAt = seals.map((s) => s.sealedAt).sort()[0];
      const uniqueRepos = [...new Set(seals.flatMap((s) => s.repos.map((r) => r.repo)))];
      const fixes = (await Promise.all(uniqueRepos.map((repo) => fixesSince(repo, earliestSealedAt, log)))).flat()
        .filter((x) => !until || x.mergedAt <= until);
      const s = score(seals, fixes, { frozen: !!until && new Date() > new Date(until) });
      writeFileSync(scoreFile, JSON.stringify(s, null, 1));
      console.log(`${s.totals.fixed} of ${s.totals.forecasts} forecast tickets fixed since ${s.sealedAt.slice(0, 10)} (base + ${s.dailySeals ?? 0} daily seals): Hit@5 ${s.totals.hit5}% (baseline ${s.totals.baselineHit5}%), Hit@10 ${s.totals.hit10}%${s.frozen ? ' [FROZEN]' : ''}`);
      return;
    }
    case 'export-web': {
      // groundwork export-web honojs/hono vitest-dev/vitest --out docs   (data for the in-browser demo)
      if (!pos.length) throw new Error('Usage: groundwork export-web owner/repo [owner/repo …] [--out docs]');
      const { exportWeb } = await import('./export.js');
      const { existsSync } = await import('node:fs');
      const out = flag('out', 'docs')!;
      const store = openStore();
      const manifest = [];
      for (const repo of pos) {
        const data = await fetchRepo(repo, { log });
        const base = repo.replace('/', '__');
        const evalFile = [`${base}.newer.json`, `${base}.json`, `${base}.prs.newer.json`, `${base}.prs.json`].map((n) => path.join(HOME, 'eval', n)).find((f) => existsSync(f));
        manifest.push(exportWeb(store, data, out, evalFile));
        log(`  ${repo}: exported${evalFile ? ' with ' + path.basename(evalFile) : ''}`);
      }
      writeFileSync(path.join(out, 'data', 'index.json'), JSON.stringify(manifest, null, 2));
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
