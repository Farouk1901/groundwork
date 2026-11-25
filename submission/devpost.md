# Devpost submission: Groundwork

## Project name
Groundwork

## Tagline (max 200 characters)
Before the first line of code: Groundwork reads a ticket, finds how similar tickets were fixed, and shows the files, people and risks, each with the Relate graph path behind it.

## Links
- **Live demo (runs in the browser, nothing to install):** https://farouk1901.github.io/groundwork/
- Repository: https://github.com/Farouk1901/groundwork  (topics: `relate`, `relate-neo4j-hackathon`)
- Video: (to add)

---

## Inspiration

Every change starts as a ticket. Before writing anything, a developer or a coding agent has to answer three
questions: *where in the code is this, who knows that code, and what has gone wrong there before?* The answers
already exist in the repository's history: someone fixed a ticket very like this one, in some files, and a reviewer
caught a missing test. But that knowledge is spread across closed tickets, merged pull requests and file diffs,
and grep cannot connect "cookie value gets cut at =" to the PR that fixed it last year.

Impact tools that start from code (call graphs, co-change, ownership) need a starting file. When work starts from
a ticket, finding that file *is* the work. That gap is where Groundwork lives.

## What it does

Give Groundwork a ticket (a GitHub issue number, a Jira key, or a sentence) and it returns, in well under a second:

- **The files most likely to change**, ranked, each with its reason as a graph path:
  *your ticket → similar ticket hono#5581 ← fixed by PR #5608 → `src/utils/cookie.test.ts`*
- **Who knows that code**: the people who merged the most changes to those files, and when.
- **What to watch**: open tickets about the same thing (likely duplicates) and recent bug fixes in the same files
  (regressions you must not reintroduce).
- **Similar past work**: the tickets and PRs to read before you design the fix.

And when the change is written, `check` compares the diff with the ticket: covered files, files that similar
fixes also changed but you did not (usually the test), and files outside the ticket's usual footprint.

It works as a CLI, a **GitHub Action** (`action.yml`) that automatically comments Groundwork's ranked files, experts and risks on newly opened issues, an **MCP server** for Claude Code / Cursor / Codex (`plan_ticket`, `check_diff`, `similar_work`, `who_knows`, read-only `graph_query`), a **Claude Code skill**, a pre-commit / CI gate (`check --strict`), a local web view, and a **live browser demo** that opens in `180 ms` median (measured via `npm run bench:instant`, zero `> 200 ms` main-thread long tasks) with pre-baked Replay samples while **Relate WebAssembly runs live in a background Web Worker** on `hono`, `vitest` and `relatedb/relate`.

**Does it work? We measured it, on three repositories (703 held-out cases).** `eval` replays history: for each closed ticket that a merged PR fixed, it rebuilds the graph *as of the moment the ticket was opened* (the fix and everything later hidden), predicts the files from the ticket alone, and compares them with the real fix — alongside both a `grep` baseline (what coding agents do today) and a most-changed-files baseline. All numbers below come from the exact same held-out `--split newer` run (`docs/data/*.eval.json`):

| Repository | Cases | Groundwork Hit@5 | `grep` alone Hit@5 | **Groundwork + grep Hit@5** | Baseline Hit@5 | Fused MRR (vs `grep`) |
|---|---:|---:|---:|---:|---:|---:|
| honojs/hono, newer half | 200 tickets | **78.0%** | 58.5% | **79.5%** | 15.5% | **0.654** (vs 0.390) |
| vitest-dev/vitest, newer half (never tuned on) | 220 tickets | **62.7%** | 33.6% | **62.7%** | 16.8% | **0.442** (vs 0.244) |
| relatedb/relate itself, newer half, **PR title alone** | 283 PRs | **50.9%** | 60.4% | **68.2%** | 18.4% | **0.531** (vs 0.418) |
| **Weighted total (all 3 repos)** | **703 cases** | **62.3%** | **51.5%** | **69.7%** | **17.1%** | **0.538** (vs 0.356) |

Hit@5: a file the real fix changed is among the first five suggestions (**2.8× to 5.0×** the file-first baseline standalone; **3.7× to 5.1×** fused with `grep`). Because coding agents already use `grep`, fusing Groundwork with `grep` (`--code`, confidence-weighted WRRF tuned strictly on `--split older`) beats `grep` alone on every single repository: **79.5%** vs 58.5% on `hono`, **62.7%** vs 33.6% on `vitest`, and **68.2%** vs 60.4% on `relatedb/relate` (MRR **0.531** vs 0.418).

**Estimated ROI (estimated from first-hit rank on 703 held-out cases):** Based on `1 / MRR` across the 703 held-out cases, `grep` alone inspects ~2.81 files before hitting a true fix file (missing Top-5 on 48.5% of cases), while Groundwork + grep inspects ~1.86 files (~34% fewer files opened before first hit, cutting Top-5 misses to 30.3% — an estimated ~1,400 tokens saved per ticket, *estimated from first-hit rank on 703 held-out cases*).

**Sealed forecasts scored on the future:** On 24 Nov 2026 (`f9e4c54`), we sealed **617 forecasts** for open, unfixed issues (never open PRs whose diffs are public) with a SHA-256 digest (`docs/predictions/sealed.sha256`). A daily GitHub Action scores both `sealed.json` and append-only `daily/*.json` seals against fixes merged after each seal, seals newly opened unfixed issues created after the last seal with no linked PRs, and runs one final freeze pass immediately after the contest deadline (`2026-12-12T02:00:00Z`).

**See it yourself:** in the live demo, open a closed ticket and press **Replay**. The graph rewinds to the day the
ticket was opened, the fix disappears, and every file the real fix changed gets a ✓. hono#2550, a Lambda header
regression: the first suggestion is `src/adapter/aws-lambda/handler.ts`, the file PR #2585 fixed 12 days later.

## How we built it

- **Relate, embedded** (`@relate/relate` 1.0.1) holds one graph per machine:
  `(Person)-[:AUTHORED]->(PR)-[:FIXES]->(Issue)`, `(PR)-[:TOUCHES]->(File)-[:IN]->(Module)`,
  `(File)-[:CO_CHANGED {count}]->(File)`, `(Issue)-[:NAMES]->(File)`, `(Issue)-[:MENTIONS]->(Issue)`, labels and authors.
- **Hybrid retrieval inside Relate.** Every ticket and PR stores its text and a local 384-d embedding
  (all-MiniLM-L6-v2 through Transformers.js: no API key, nothing leaves the machine). One Cypher statement fuses a
  vector index and a full-text index with WRRF: `SEARCH n IN (COMBINE (VECTOR INDEX … , FULLTEXT INDEX …) USING WRRF)`.
  We weight each match by its real cosine similarity, because fused rank scores are almost flat.
- **Graph hops do the rest**: each similar ticket is followed to the PR that fixed it and the files that PR touched;
  each similar PR to its files; then co-change edges bring in the test and the sibling module; then `AUTHORED` gives
  the people and labelled bug fixes give the risks. Every score keeps the path that produced it.
- **Time travel for honest evaluation**: `planTicket(…, { asOf })` filters every hop by merge date and recounts
  co-change from earlier PRs only, so the backtest never sees the answer.
- **Ingest** from the GitHub GraphQL API (merged PRs with files and closing references, tickets), cached on disk;
  optional **Jira** import links tickets to PRs that mention their key.
- **The same code in the browser (instant 180 ms median boot + Web Worker).** The live demo opens immediately on `hono#2550` Replay via a tiny pre-baked bundle (`docs/data/instant.json`, measured 180 ms median plan render & zero main-thread long tasks > 200 ms via `npm run bench:instant`), while `docs/worker.js` downloads the int8 snapshot and builds the live `@relate/relate-wasm` (`1.2.0`) graph in a dedicated Web Worker off the main thread. Because the WASM build cannot toggle the `hybrid-search` preview via environment variables, it runs vector and full-text indexes separately in Relate and fuses them with identical WRRF.
- TypeScript on Node.js with tsx, the MCP TypeScript SDK, Cytoscape.js for the web view, esbuild for the browser and worker bundles, `node:test` for the tests (20 tests, including a native `@relate/relate 1.0.1` vs `@relate/relate-wasm 1.2.0` parity test, append-only daily new-issue sealing with SHA-256, multi-seal scoring, and post-deadline freeze verification).

## Challenges we ran into

- **Fused scores are flat.** WRRF ranks well but its scores barely separate a near-duplicate from a loose match, so
  files from weak matches crowded the list. Reading `vector.similarity.cosine` next to the fused score, and weighting
  by it, fixed the ranking.
- **Leakage.** The first backtest was too good: the ticket's own fix was in the graph, and co-change edges were
  counted over all history. The `asOf` replay hides both, and a test pins it.
- **Noise files.** Lockfiles, manifests and changelogs change in every PR; they are damped, and huge PRs (renames,
  formatting) are left out of co-change.
- **Many repos never link PRs to tickets.** Searching merged PRs directly, not only tickets, covers them; Relate's
  own repository has 19 tickets, so there we evaluate from PR titles instead.
- **Hybrid search in the browser.** The WebAssembly build of Relate reads preview flags from an environment variable
  that does not exist in a browser. We run both indexes in Relate and fuse in the page, and measured that it matches.
- **Tuning honestly.** The first weights over-trusted co-change. We picked new ones on one half of one repository and
  report only on data that never influenced them, including two other repositories.

## Accomplishments that we're proud of

- Measured on three repositories, two of them never tuned on, with ablations that show which part of the graph earns
  its keep, all reproducible with one command each.
- A live demo with the real engine: Relate WebAssembly and the same analysis code, plus a Replay button that lets
  anyone check a prediction against the real fix.
- Every answer is explainable: click a suggested file and the path from the ticket to it lights up.
- No token, no model download and about 30 seconds to build a graph locally: the snapshots ship with their embeddings.

## What we learned

Retrieval finds the *meaning* (which old ticket is this one like?), and the graph turns meaning into *places and
people* (which files did that fix change, who changed them, what moves with them). Neither alone is enough: the
ablations show the drop when either is removed. An embedded graph makes this cheap enough to run before every ticket.

## What's next

Follow file renames, weight recent history higher, learn the hybrid weights per repository from the backtest, and add GitLab and Linear importers.

## Built with
relate, relate-wasm, neo4j, cypher, typescript, node.js, webassembly, transformers.js, mcp, cytoscape.js, esbuild, github-graphql-api, jira-rest-api, github-pages

## Relate capabilities used
Embedded use (`@relate/relate` in-process), Cypher (MERGE / UNWIND ingest, multi-hop MATCH, aggregation),
uniqueness constraints and property indexes, **vector indexes with a filter**, **full-text indexes**, **hybrid
retrieval with `SEARCH … COMBINE … USING WRRF`** (preview feature `hybrid-search`), `vector.similarity.cosine`,
single-file `.rl` stores, **`@relate/relate-wasm` in the browser** (the live demo builds and queries the graph in the
tab), and an MCP server that exposes the graph (including read-only Cypher) to coding agents.

## Third-party tools
GitHub GraphQL API, Jira Cloud REST API (optional), Transformers.js with the all-MiniLM-L6-v2 model, MCP TypeScript
SDK, Cytoscape.js, zod, tsx, esbuild, GitHub Pages. Demo and evaluation data: public histories of honojs/hono (MIT),
vitest-dev/vitest (MIT) and relatedb/relate (Apache-2.0).

## AI tools used in development
The code, tests and documentation were written with significant help from an AI coding assistant (Claude Code,
Anthropic). I directed the design (the ticket-first approach, the graph model, the backtest and its leakage
controls), reviewed and tested the code, and made the product decisions. The product itself calls no hosted AI
model: its embeddings are computed locally.
