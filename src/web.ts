// A small local web view: ask about an issue or a planned change, see the blast radius as a ranked list and a graph.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { blastRadius, similar } from './analyze.js';
import { num, openStore } from './store.js';

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
    try {
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page()); }
      if (url.pathname === '/vendor/cytoscape.min.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=86400' }); return res.end(cyto); }
      if (url.pathname === '/api/repos') {
        const repos = store.query(`MATCH (r:Repo) OPTIONAL MATCH (i:Issue {repo: r.name}) WITH r, count(i) AS issues
          OPTIONAL MATCH (x:PR {repo: r.name}) RETURN r.name AS name, issues, count(x) AS prs, r.fetchedAt AS fetchedAt ORDER BY name`)
          .map((r) => ({ name: String(r.name), issues: num(r.issues), prs: num(r.prs), fetchedAt: String(r.fetchedAt ?? '') }));
        const open = repos.length ? store.query(`MATCH (i:Issue) WHERE i.repo = $repo AND i.state = 'OPEN' RETURN i.number AS number, i.title AS title ORDER BY i.number DESC LIMIT 12`, { repo: repos[0].name })
          .map((r) => ({ number: num(r.number), title: String(r.title) })) : [];
        return json(res, 200, { repos, examples: open });
      }
      if (url.pathname === '/api/blast') {
        const repo = url.searchParams.get('repo') ?? '';
        const q = (url.searchParams.get('q') ?? '').trim();
        if (!repo || !q) return json(res, 400, { error: 'repo and q are required' });
        const target = /^#?\d+$/.test(q) ? { issue: Number(q.replace('#', '')) } : { text: q.slice(0, 2000) };
        return json(res, 200, await blastRadius(store, repo, target, { files: 12 }));
      }
      if (url.pathname === '/api/similar') {
        return json(res, 200, await similar(store, url.searchParams.get('repo') ?? '', url.searchParams.get('q') ?? ''));
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  }).listen(port, '127.0.0.1', () => process.stderr.write(`Blast Radius on http://127.0.0.1:${port}\n`));
}
