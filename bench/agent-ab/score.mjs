// Scores the A/B runs against the files the real fix changed and writes docs/data/agent-ab.json.
// Usage: node bench/agent-ab/score.mjs <runs root>   (expects <root>/<set>-<repo>/<issue>-<A|B>.result.json)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? 'runs';
const here = fileURLToPath(new URL('.', import.meta.url));
const TEST = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[jt]sx?$/;
const SETS = {
  symptom: 'Tickets rewritten as a user would report them: symptoms only, no file, function or option names, no ticket number',
  named: 'Tickets as filed on GitHub, which usually name the code involved',
};

function answer(text) {
  const m = [...(text ?? '').matchAll(/\{\s*"files"\s*:\s*\[[\s\S]*?\]\s*\}/g)].at(-1);
  return m ? JSON.parse(m[0]).files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')) : [];
}

function score(set, repoName) {
  const d = JSON.parse(readFileSync(`${here}/cases/${set}-${repoName}.json`, 'utf8'));
  const rows = [];
  for (const c of d.cases) for (const cond of ['A', 'B']) {
    const base = `${root}/${set}-${repoName}/${c.issue}-${cond}`;
    if (!existsSync(`${base}.result.json`)) throw new Error(`missing ${base}`);
    const r = JSON.parse(readFileSync(`${base}.result.json`, 'utf8'));
    const stream = readFileSync(`${base}.stream.jsonl`, 'utf8');
    const files = answer(r.result).slice(0, 5);
    const truth = new Set(c.truth);
    const rank = files.findIndex((f) => truth.has(f)) + 1;
    // Leakage guard: the fix PR's number or commit must never appear in what the agent saw or wrote.
    const leaked = c.fixPRs.some((p) => new RegExp(`#${p.number}\\b`).test(stream)) || stream.includes(c.fixCommit.slice(0, 10)) || stream.includes('git log --all');
    rows.push({ issue: c.issue, cond, files, truth: c.truth, rank: rank || null,
      testFile: files.some((f) => truth.has(f) && TEST.test(f)), needsTest: c.truth.some((f) => TEST.test(f)),
      wholeFix: c.truth.every((f) => files.includes(f)), covered: files.filter((f) => truth.has(f)).length / truth.size,
      precision: files.length ? files.filter((f) => truth.has(f)).length / files.length : 0,
      usedGroundwork: stream.includes('"name":"mcp__groundwork__plan_ticket"'),
      turns: r.num_turns, costUsd: r.total_cost_usd, seconds: Math.round(r._wall_s), leaked });
  }
  return rows;
}

const pct = (x) => Math.round(x * 1000) / 10;
function summary(rows) {
  const out = {};
  for (const cond of ['A', 'B']) {
    const R = rows.filter((x) => x.cond === cond), n = R.length, T = R.filter((x) => x.needsTest);
    out[cond === 'A' ? 'agentAlone' : 'agentWithGroundwork'] = {
      tickets: n, firstFileCorrect: R.filter((x) => x.rank === 1).length, hitAt5: R.filter((x) => x.rank).length,
      testFileFound: R.filter((x) => x.testFile).length, ticketsWhoseFixChangedATest: T.length,
      wholeFixInTop5: R.filter((x) => x.wholeFix).length,
      fixFilesCoveredPct: pct(R.reduce((a, x) => a + x.covered, 0) / n), precisionPct: pct(R.reduce((a, x) => a + x.precision, 0) / n),
      calledPlanTicket: R.filter((x) => x.usedGroundwork).length,
      costUsd: Math.round(R.reduce((a, x) => a + x.costUsd, 0) * 100) / 100, meanSeconds: Math.round(R.reduce((a, x) => a + x.seconds, 0) / n * 10) / 10,
      leaked: R.filter((x) => x.leaked).length };
  }
  return out;
}

const result = { generatedAt: new Date().toISOString(), model: 'Claude Sonnet (claude CLI -p, max 25 turns), tools: Read, Grep, Glob, read-only git and ls',
  conditions: { A: 'agent alone', B: "agent + Groundwork MCP plan_ticket, the repository's CLAUDE.md asking it to start there, graph frozen at the ticket's creation (GROUNDWORK_AS_OF)" },
  sets: {} };
for (const [set, about] of Object.entries(SETS)) {
  const hono = score(set, 'hono'), vitest = score(set, 'vitest');
  result.sets[set] = { about, total: summary([...hono, ...vitest]), hono: summary(hono), vitest: summary(vitest),
    runs: [...hono.map((x) => ({ repo: 'honojs/hono', ...x })), ...vitest.map((x) => ({ repo: 'vitest-dev/vitest', ...x }))] };
}
writeFileSync(`${here}/../../docs/data/agent-ab.json`, JSON.stringify(result, null, 1));
for (const [set, v] of Object.entries(result.sets)) console.log(set, JSON.stringify(v.total));
