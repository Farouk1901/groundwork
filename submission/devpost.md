# Devpost submission: Groundwork

## Project name
Groundwork

## Tagline (max 200 characters)
Ticket-first blast radius: Relate hybrid search and Cypher paths predict the files, experts and risks of a ticket before any code exists. Checked on 703 held-out cases and 617 sealed forecasts.

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
a ticket, finding that file *is* the work. Groundwork starts there.

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

It works as a CLI, a **GitHub Action** (`action.yml`) that comments the ranked files, experts and risks on newly opened issues, an **MCP server** for Claude Code / Cursor / Codex (`plan_ticket`, `check_diff`, `similar_work`, `who_knows`, read-only `graph_query`), a **Claude Code skill**, a pre-commit / CI gate (`check --strict`), a local web view, a **single-file Relate store committed in the repo** (`examples/relatedb__relate.rl`, 3,581 nodes and 15,469 relationships of `relatedb/relate` itself), and a **live browser demo** on `hono`, `vitest` and `relatedb/relate`. The demo opens in `133 ms` median (`npm run bench:instant`, zero `> 200 ms` main-thread long tasks) with pre-baked Replay samples, while **Relate WebAssembly runs live in a Web Worker**.

**Does it work? We measured it on three repositories (703 held-out cases).** `eval` replays history: for each closed ticket that a merged PR fixed, it rebuilds the graph *as of the moment the ticket was opened* (the fix and everything later hidden), predicts the files from the ticket alone, and compares them with the real fix. It runs two baselines on the same cases: `grep` (what coding agents do today) and the most-changed files. All numbers below come from the same held-out `--split newer` run (`docs/data/*.eval.json`):

| Repository | Cases | Groundwork Hit@5 | `grep` alone Hit@5 | **Groundwork + grep Hit@5** | Baseline Hit@5 | Fused MRR (vs `grep`) |
|---|---:|---:|---:|---:|---:|---:|
| honojs/hono, newer half | 200 tickets | **78.0%** | 58.5% | **79.5%** | 15.5% | **0.654** (vs 0.390) |
| vitest-dev/vitest, newer half (never tuned on) | 220 tickets | **62.7%** | 33.6% | **62.7%** | 16.8% | **0.442** (vs 0.244) |
| relatedb/relate itself, newer half, **PR title alone** | 283 PRs | **50.9%** | 60.4% | **68.2%** | 18.4% | **0.531** (vs 0.418) |
| **Weighted total (all 3 repos)** | **703 cases** | **62.3%** | **51.5%** | **69.7%** | **17.1%** | **0.538** (vs 0.356) |

Hit@5: a file the real fix changed is among the first five suggestions (**2.8× to 5.0×** the file-first baseline on its own; **3.7× to 5.1×** fused with `grep`). Coding agents already use `grep`, and fusing Groundwork with it (`--code`, confidence-weighted WRRF tuned on `--split older` only) beats `grep` alone on every repository: **79.5%** vs 58.5% on `hono`, **62.7%** vs 33.6% on `vitest`, and **68.2%** vs 60.4% on `relatedb/relate` (MRR **0.531** vs 0.418).

Why Relate's own repository looks different: it has only 19 tickets, so each merged PR's title alone stands in for a ticket, and those titles often quote exact code symbols. That is where `grep` is strongest (60.4% vs 50.9% for Groundwork alone), and it is why the fused mode is the default we recommend: the graph adds the files a literal match cannot see, and the two together reach 68.2%.

**What each part of the graph adds** (ablation on the same held-out cases, Hit@5):

| Variant | hono (200) | vitest (220) | relatedb/relate (283) |
|---|---:|---:|---:|
| Groundwork (full: vector + full-text WRRF, then graph hops) | **78.0%** | **62.7%** | 50.9% |
| without the hop through similar PRs to the files they changed | 68.5% | 50.0% | 3.5% |
| vector only (no full-text index) | 74.0% | 56.4% | 43.1% |
| full-text only (no vector index) | 79.0% | 60.5% | 52.3% |
| without similar tickets | 77.5% | 63.6% | 56.9% |
| without co-change edges | 78.0% | 63.2% | 50.9% |

The graph hop from a similar PR to the files it touched carries most of the result: without it, Hit@5 drops by 9.5 to 47.4 points. The full-text index matters on every repository; the vector index helps on `vitest`, the repository we never tuned on, and is neutral elsewhere. Similar tickets and co-change edges are close to neutral at Hit@5, and we report that as it is (`docs/data/ablation.json`).

**Estimated ROI (from first-hit rank on 703 held-out cases):** taking `1 / MRR` as the files opened before reaching one the fix changed, `grep` alone opens ~2.81 files and misses the top 5 on 48.5% of cases. Groundwork + grep opens ~1.86 files (~34% fewer files opened before first hit) and misses on 30.3%, an estimated ~1,400 tokens saved per ticket.

**Does it help a coding agent? A/B test with Claude Code (70 tickets, 140 runs).** The same agent (Claude Sonnet, read-only tools including `grep` and `git log`) gets each ticket in a checkout from before the fix and lists the files it would change; with Groundwork, it also has `plan_ticket` over MCP, with the graph frozen at the moment the ticket was opened. On 30 tickets written the way users report bugs (symptoms only, no code names):

| | Agent alone | Agent + Groundwork |
|---|---:|---:|
| **Found the test file the real fix changed** (of 25) | 7 | **16** |
| **Listed every file of the real fix** in its top 5 | 7 | **13** |
| Share of the fix's files listed | 51.8% | **65.5%** |
| A fixed file in the top 5 / first | 28 / **26** | 28 / 23 |
| Precision of the listed files | **56.4%** | 46.0% |
| Cost and mean time per ticket | $0.059, 44 s | $0.065, 47 s |

The agent finds the main file on its own almost every time; Groundwork adds the rest of the change, the test and the sibling files the real fix also touched, at some cost in precision. On 40 tickets as filed on GitHub, the first pick is the same (37 vs 37) and Groundwork still adds the test file (18 vs 12 of 35). No run saw the fix; every run and score is in `docs/data/agent-ab.json` (method: `bench/agent-ab`).

**Sealed forecasts scored on the future:** on 24 Nov 2026 (`f9e4c54`), we sealed **617 forecasts** for open, unfixed issues with a SHA-256 digest (`docs/predictions/sealed.sha256`). Open PRs are never sealed, since their diffs are public. A daily GitHub Action scores `sealed.json` and the append-only `daily/*.json` seals against fixes merged after each seal, seals issues opened since the last seal that are unfixed and have no linked PR, and freezes the score with one last run right after the contest deadline (`2026-12-12T02:00:00Z` / Dec 11, 2026 6:00 PM PT).

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
- **Time travel for a fair evaluation**: `planTicket(…, { asOf })` filters every hop by merge date and recounts
  co-change from earlier PRs only, so the backtest never sees the answer.
- **Ingest** from the GitHub GraphQL API (merged PRs with files and closing references, tickets), cached on disk;
  optional **Jira** import links tickets to PRs that mention their key.
- **The same code in the browser.** The live demo opens on `hono#2550` Replay from a small pre-baked bundle (`docs/data/instant.json`; 133 ms median plan render and zero main-thread long tasks > 200 ms in `npm run bench:instant`), while `docs/worker.js` downloads the int8 snapshot and builds the live `@relate/relate-wasm` (`1.2.0`) graph in a Web Worker, off the main thread. The WASM build cannot switch on the `hybrid-search` preview through environment variables, so it queries the vector and full-text indexes separately in Relate and fuses them with the same WRRF.
- TypeScript on Node.js with tsx, the MCP TypeScript SDK, Cytoscape.js for the web view, esbuild for the browser and worker bundles, `node:test` for the tests (21 tests, including a native `@relate/relate 1.0.1` vs `@relate/relate-wasm 1.2.0` parity test, append-only daily new-issue sealing with SHA-256, multi-seal scoring, and post-deadline freeze verification).

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
