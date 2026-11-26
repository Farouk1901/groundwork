// Sequential A/B runner: the same agent with (B) and without (A) Groundwork, on the same tickets.
// Usage: node bench/agent-ab/run.mjs <cases.json> <outDir> [issue ...]
// Needs a logged-in `claude` CLI, and one checkout per ticket at its pre-fix commit: $GW_WORKTREES/<repo name>/<issue>.
// Never runs two conditions at once; skips runs that already have a result (no re-runs).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [casesFile, outDir, ...only] = process.argv.slice(2);
const BR = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\/]$/, '');
const CLI = process.env.CLAUDE_BIN ?? 'claude';
const WORKTREES = process.env.GW_WORKTREES ?? 'worktrees';
const BUDGET = 15;
// Run as a fresh CLI login, not as a child of the host session: drop the host's CLAUDE_*/ANTHROPIC_* variables.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));
const d = JSON.parse(readFileSync(casesFile, 'utf8'));
const WT = `${WORKTREES}/${d.repo.split('/')[1]}`;
const list = only.length ? d.cases.filter((c) => only.includes(String(c.issue))) : d.cases;
let spent = 0;
for (const f of ['A', 'B']) for (const c of d.cases) {
  const p = `${outDir}/${c.issue}-${f}.result.json`;
  if (existsSync(p)) { try { spent += JSON.parse(readFileSync(p, 'utf8')).total_cost_usd ?? 0; } catch { /* ignore */ } }
}
const prompt = (c) => `You are working in a clone of the GitHub repository ${d.repo} (TypeScript), checked out as it was while this ticket was open.

${d.vague ? 'Ticket' : `Ticket ${d.repo}#${c.issue}`}: ${c.title}

${c.body.trim()}

Find the files you would change to fix this. Do not edit anything. End your answer with a JSON line {"files": [up to 5 repo-relative paths, best first]}.`;
// B gets Groundwork's own Claude Code skill, as an installed user would.
const SKILL = readFileSync(`${BR}/skill/SKILL.md`, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
const BASE_ALLOW = ['Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git grep:*)'];
for (const c of list) for (const cond of ['A', 'B']) {
  const base = `${outDir}/${c.issue}-${cond}`;
  if (existsSync(`${base}.result.json`)) { console.log(`skip ${base} (already run)`); continue; }
  if (spent > BUDGET) { console.log(`BUDGET STOP at $${spent.toFixed(2)}`); process.exit(2); }
  const args = ['-p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--max-turns', '25', '--no-session-persistence',
    '--setting-sources', 'project', '--permission-prompts', 'none', '--strict-mcp-config', '--tools', 'Read,Grep,Glob,Bash'];
  const allow = [...BASE_ALLOW];
  const deny = ['WebFetch', 'WebSearch', 'Edit', 'Write'];
  if (cond === 'B') {
    const cfg = { mcpServers: { groundwork: { command: 'node', args: [`${BR}/node_modules/tsx/dist/cli.mjs`, `${BR}/src/cli.ts`, 'mcp'], env: { GROUNDWORK_AS_OF: c.createdAt } } } };
    writeFileSync(`${base}.mcp.json`, JSON.stringify(cfg, null, 2));
    args.push('--mcp-config', `${base}.mcp.json`, '--append-system-prompt', SKILL);
    allow.push('mcp__groundwork__plan_ticket');
    deny.push('mcp__groundwork__graph_query', 'mcp__groundwork__similar_work', 'mcp__groundwork__who_knows', 'mcp__groundwork__check_diff');
  }
  args.push('--allowedTools', allow.join(','), '--disallowedTools', deny.join(','));
  // B: the repository's CLAUDE.md asks agents to start from Groundwork, as a team that installed it would.
  const p = cond === 'B' ? `${prompt(c)}

This repository's CLAUDE.md says: start every ticket by calling plan_ticket (${d.vague ? `repo ${d.repo}, text: the ticket's title and description` : `repo ${d.repo}, issue ${c.issue}`}), then confirm in the code.` : prompt(c);
  writeFileSync(`${base}.prompt.txt`, p);
  const t0 = Date.now();
  const r = spawnSync(CLI, args, { cwd: `${WT}/${c.issue}`, input: p, env: CLEAN_ENV, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 15 * 60 * 1000 });
  const wall = (Date.now() - t0) / 1000;
  writeFileSync(`${base}.stream.jsonl`, r.stdout ?? '');
  writeFileSync(`${base}.stderr.txt`, `${r.stderr ?? ''}\nstatus=${r.status} signal=${r.signal} error=${r.error ?? ''}`);
  const lines = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = lines.findLast((l) => l.type === 'result') ?? { type: 'result', subtype: 'runner_error', is_error: true, total_cost_usd: 0 };
  res._wall_s = wall; res._args = args;
  writeFileSync(`${base}.result.json`, JSON.stringify(res, null, 2));
  spent += res.total_cost_usd ?? 0;
  console.log(`${c.issue} ${cond} ${res.subtype} turns=${res.num_turns} cost=$${(res.total_cost_usd ?? 0).toFixed(3)} wall=${wall.toFixed(0)}s total=$${spent.toFixed(2)}`);
}
