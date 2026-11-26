// Rewrites each ticket the way a user or support agent would report it: the symptom only, no code names.
// The rewriter sees the ticket alone (never the fix). Usage: node bench/agent-ab/rewrite.mjs <in.json> <out.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [inFile, outFile] = process.argv.slice(2);
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));
const CLI = process.env.CLAUDE_BIN ?? 'claude';
const d = JSON.parse(readFileSync(inFile, 'utf8'));
const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
const done = new Map((prev?.cases ?? []).filter((c) => c.origTitle).map((c) => [c.issue, c]));

const ask = (c) => `Rewrite this GitHub issue from the ${d.repo} project the way a user or a support agent would report it if they had never read the source code.

Rules:
- Describe only what the person did, what they saw and what they expected.
- Remove every file path, directory name, function, class, method, hook, type, variable, configuration option, CLI flag, package name of the project's own internals, code snippet, stack trace and internal error identifier.
- Name features in plain words (for example "the response compression feature", "the setting that controls caching").
- Do not guess the cause or where the fix belongs.
- Plain English, a title of at most 12 words, then 2 to 5 sentences.

Answer with JSON only: {"title": "...", "body": "..."}

Issue title: ${c.title}

Issue body:
${c.body.trim().slice(0, 6000)}`;

const out = [];
for (const c of d.cases) {
  if (done.has(c.issue)) { out.push(done.get(c.issue)); continue; }
  const r = spawnSync(CLI, ['-p', '--model', 'sonnet', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'project',
    '--strict-mcp-config', '--tools', '', '--max-turns', '1'], { input: ask(c), env: CLEAN_ENV, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 5 * 60 * 1000 });
  let res;
  try { res = JSON.parse(r.stdout).result; } catch { console.log(`${c.issue} FAILED ${r.stderr?.slice(0, 300)}`); continue; }
  const m = res.match(/\{[\s\S]*\}/);
  if (!m) { console.log(`${c.issue} NO JSON`); continue; }
  const v = JSON.parse(m[0]);
  out.push({ ...c, origTitle: c.title, origBody: c.body, title: v.title, body: v.body });
  console.log(`${c.issue} | ${v.title}`);
  writeFileSync(outFile, JSON.stringify({ ...d, vague: true, rewrite: 'symptom-only rewrite by Claude Sonnet from the ticket text alone; see scripts/rewrite.mjs', cases: out }, null, 2));
}
writeFileSync(outFile, JSON.stringify({ ...d, vague: true, rewrite: 'symptom-only rewrite by Claude Sonnet from the ticket text alone; see scripts/rewrite.mjs', cases: out }, null, 2));
console.log(`done ${out.length}/${d.cases.length}`);
