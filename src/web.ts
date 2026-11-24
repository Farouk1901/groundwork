// A small local web view: pick a ticket (or describe one), see its groundwork as a ranked list and as the graph
// paths behind it, check a list of changed files against it, and see how well the method did in the backtest.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fixOf, planTicket } from './analyze.js';
import { checkChange } from './check.js';
import { HOME, num, openStore } from './store.js';
import { targetOf } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function serve(port = 7474) {
  const store = openStore();
  const page = () => readFileSync(path.join(here, '..', 'public', 'index.html'));
  const cyto = readFileSync(require.resolve('cytoscape/dist/cytoscape.min.js'));

  const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = (k: string) => (url.searchParams.get(k) ?? '').trim();
    try {
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page()); }
      if (url.pathname === '/vendor/cytoscape.min.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=86400' }); return res.end(cyto); }
      if (url.pathname.startsWith('/predictions/') && /^\/predictions\/[\w.-]+\.json$/.test(url.pathname)) {
        const f = path.join(here, '..', 'docs', url.pathname);
        if (!existsSync(f)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(f));
      }
      if (url.pathname === '/api/repos') {
        const repos = store.query(`MATCH (r:Repo) OPTIONAL MATCH (i:Issue {repo: r.name}) WITH r, count(i) AS issues
          OPTIONAL MATCH (x:PR {repo: r.name}) RETURN r.name AS name, issues, count(x) AS prs, r.fetchedAt AS fetchedAt ORDER BY name`)
          .map((r) => ({ name: String(r.name), issues: num(r.issues), prs: num(r.prs), fetchedAt: String(r.fetchedAt ?? '') }));
        const repo = p('repo') || repos[0]?.name;
        const open = repo ? store.query(`MATCH (i:Issue) WHERE i.repo = $repo AND i.state = 'OPEN' RETURN i.number AS number, i.title AS title ORDER BY i.number DESC LIMIT 8`, { repo })
          .map((r) => ({ number: num(r.number), title: String(r.title) })) : [];
        const counts = Object.fromEntries(store.query('MATCH (n) RETURN labels(n)[0] AS l, count(*) AS n').map((r) => [String(r.l), num(r.n)]));
        const rels = num(store.query('MATCH ()-[r]->() RETURN count(r) AS n')[0]?.n);
        return json(res, 200, { repos, examples: open, counts, rels });
      }
      if (url.pathname === '/api/plan' || url.pathname === '/api/blast') {
        if (!p('repo') || !p('q')) return json(res, 400, { error: 'repo and q are required' });
        const target = targetOf(p('q'));
        const fix = 'issue' in target ? fixOf(store, p('repo'), target.issue) : null;
        // Replay: the plan as of the day the ticket was opened (its fix hidden), with the files the fix really changed.
        if (p('replay') && fix) return json(res, 200, { ...(await planTicket(store, p('repo'), target, { files: 12, asOf: fix.createdAt })), replay: fix });
        return json(res, 200, { ...(await planTicket(store, p('repo'), target, { files: 12 })), canReplay: !!fix });
      }
      if (url.pathname === '/api/check') {
        const files = p('files').split(/[\s,]+/).filter(Boolean);
        if (!p('repo') || !p('q') || !files.length) return json(res, 400, { error: 'repo, q and files are required' });
        const r = await checkChange(store, p('repo'), targetOf(p('q')), files);
        return json(res, 200, { covered: r.covered, missing: r.missing, unexpected: r.unexpected, ok: r.ok });
      }
      if (url.pathname === '/api/eval') {
        // Your own run first; else the result shipped with the example snapshot.
        // The held-out half (never used to choose a default) is the honest headline; fall back to the full run.
        const base = p('repo').replace('/', '__');
        const f = [...[`${base}.newer.json`, `${base}.json`, `${base}.prs.newer.json`, `${base}.prs.json`].map((n) => path.join(HOME, 'eval', n)),
          path.join(here, '..', 'docs', 'data', `${base}.eval.json`)].find((x) => existsSync(x));
        return json(res, 200, f ? JSON.parse(readFileSync(f, 'utf8')) : null);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  }).listen(port, '127.0.0.1', () => process.stderr.write(`Groundwork on http://127.0.0.1:${port}\n`));
}
