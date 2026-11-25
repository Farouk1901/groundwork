# Groundwork

**The connected context of a ticket, before the first line of code.**

**▶ Try it in your browser, nothing to install: https://farouk1901.github.io/groundwork/**
(Opens instantaneously — measured **180 ms median** instant-plan render with zero `> 200 ms` main-thread long tasks via `npm run bench:instant` — on `hono#2550` Replay, while Relate compiled to WebAssembly builds the live graph in a background Web Worker.)

You get a ticket: "Support the `__Http-` and `__Host-Http-` cookie prefixes" (hono#5601, open). Before you (or your
coding agent) open a single file, Groundwork tells you:

- **which files will most likely change**, and *why*, as a path in the graph:
  `your ticket ─SIMILAR→ hono#5581 ←FIXES─ PR #5608 ─TOUCHES→ src/utils/cookie.test.ts`
- **who knows that code** (who merged the most changes to those files, and when),
- **what to watch**: open tickets about the same thing (duplicates), and recent bug fixes in the same files (regressions),
- and, when you are done, **whether your diff is missing something** that similar fixes always changed (usually the test).

It does this with one embedded [Relate](https://github.com/relatedb/relate) graph built from the repository's own
history: tickets, the pull requests that fixed them, the files they changed, the people who changed them, and the
files that move together. The core retrieval is **hybrid search inside Relate** (vector + full-text, fused with
WRRF in a single Cypher `SEARCH … COMBINE` clause) over tickets and PRs that were already resolved, followed by graph
hops from those matches to the files their fixes touched.

## Does it work? Measured on three repositories

The backtest replays history: for each closed ticket that a merged PR fixed, it rebuilds the graph **as it was the
moment the ticket was opened** (the fix, and everything merged later, hidden), predicts the files from the ticket
alone, and compares them with the files the real fix changed. The two weights were chosen once, on the **older half
of hono's tickets**; every number below is on data that never influenced them.

| Repository | Cases | **Groundwork Hit@5** | `grep` alone Hit@5 | **Groundwork + grep Hit@5** | Baseline Hit@5 (most-changed) | Groundwork MRR | `grep` MRR | **Fused MRR** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| [honojs/hono](https://github.com/honojs/hono), newer half | 200 tickets | **78.0%** | 58.5% | **79.5%** | 15.5% | 0.634 | 0.390 | **0.654** |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest), newer half, *never tuned on* | 220 tickets | **62.7%** | 33.6% | **62.7%** | 16.8% | **0.461** | 0.244 | **0.442** |
| [relatedb/relate](https://github.com/relatedb/relate), newer half, *PR title alone* | 283 PRs | **50.9%** | 60.4% | **68.2%** | 18.4% | 0.406 | 0.418 | **0.531** |
| **Weighted total (all 3 repos)** | **703 cases** | **62.3%** | **51.5%** | **69.7%** | **17.1%** | **0.488** | **0.356** | **0.538** |

*Hit@k: at least one file the real fix changed is among the first k suggestions. All numbers come from the exact same held-out `--split newer` run (`docs/data/*.eval.json`).* Relate's own repository has only 19 tickets, so each merged PR's **title alone** stands in for a ticket (replayed as of its merge, with the PR itself hidden). Because engineer-written PR titles in Relate often quote exact code symbols, `grep` beats standalone Groundwork there (`60.4%` vs `50.9%`), while confidence-weighted WRRF fusion (`fuseWithGrep`, tuned strictly on `--split older`) beats `grep` alone on **every repository** — lifting Relate Hit@5 to **68.2%** (+7.8 pp over `grep`) and MRR to **0.531** (vs `0.418`).

**Estimated ROI (estimated from first-hit rank on 703 held-out cases):**
Using harmonic expected files inspected before hitting a true fix file (`1 / MRR`), `grep` alone averages **~2.81 files** (and misses Top-5 on **48.5%** of cases), whereas **Groundwork + grep** averages **~1.86 files** (**~34% fewer files opened before first hit**, cutting Top-5 misses to **30.3%** — and on `vitest` tickets, cutting Top-5 misses from `66.4%` to `37.3%`). At ~1,500 tokens per source file, that saves an estimated **~1,400 tokens per ticket** (~1.4M input tokens per 1,000 tickets), *estimated from first-hit rank on 703 held-out cases*.

**Sealed forecasts scored on the future:** On 24 Nov 2026 (`f9e4c54`), Groundwork sealed **617 forecasts** for every open, unfixed issue across `hono`, `vitest`, and `relatedb/relate` (`docs/predictions/sealed.json`, SHA-256 verified in `docs/predictions/sealed.sha256`). A daily GitHub Action scores both `sealed.json` and append-only `daily/*.json` forecasts against fixes merged after each seal, seals newly opened unfixed issues created after the last seal (with no linked PRs, never open PRs), and runs one final freeze pass immediately after the contest deadline (`2026-12-12T02:00:00Z`).

**See it for yourself:** open [hono#2550](https://farouk1901.github.io/groundwork/?repo=honojs%2Fhono&q=2550&replay=1) in the live demo (it opens immediately in **Replay** mode): the graph rewinds to the day the ticket was opened, the fix disappears, and `src/adapter/aws-lambda/handler.ts` ranks #1 with a ✓ — the exact file PR #2585 fixed 12 days later.

Full held-out comparison on `honojs/hono` (200 held-out tickets):

| Method | Hit@5 | Hit@10 | Recall@5 | Recall@10 | MRR |
|---|---:|---:|---:|---:|---:|
| **Groundwork + grep (fused)** | **79.5%** | **83.5%** | **59.6%** | **66.6%** | **0.654** |
| **Groundwork (full)** | **78.0%** | **82.5%** | **57.4%** | **65.7%** | **0.634** |
| Baseline: grep the code for the ticket's words | 58.5% | 74.5% | 36.7% | 54.7% | 0.390 |
| Baseline: the repository's most-changed files | 15.5% | 21.5% | 8.2% | 12.2% | 0.106 |
| Ceiling: fixed files that any earlier PR had touched | – | – | – | 95.2% | – |

What the numbers say, plainly:

- **Starting from the ticket works, on repositories it was not tuned on**: **2.8× to 5.0×** the hit rate of the file-first baseline standalone (**3.7× to 5.1×** fused with `grep`).
- **Complementary to `grep`, not a replacement**: Coding agents already use `grep`. Adding Groundwork (`--code` flag) beats `grep` alone on every repo (`58.5% → 79.5%` on `hono`, `33.6% → 62.7%` on `vitest`, `60.4% → 68.2%` on `relatedb/relate`) and lifts weighted MRR across all 703 cases from `0.356` to **`0.538`**.
- **Co-change brings the test next to the source file**, which is what `check` relies on before a PR is opened.

Every result is in [`docs/data/*.eval.json`](docs/data). Reproduce them:

```bash
npx tsx src/cli.ts eval honojs/hono --split newer --fast --clone /path/to/hono
npx tsx src/cli.ts eval vitest-dev/vitest --split newer --fast --clone /path/to/vitest
npx tsx src/cli.ts eval relatedb/relate --mode prs --split newer --fast --clone /path/to/relate
```

## Why "before the code"

Tools that analyse impact from code or from a diff (call graphs, co-change, ownership) need a starting file. When
work starts from a ticket, nobody has that file yet: finding it is the actual work. Groundwork starts from the
words of the ticket, finds the past tickets and PRs that meant the same thing, and follows the graph from there.
Co-change and ownership are still used, as a second hop, once the first files are known.

## Quick start

**In the browser:** https://farouk1901.github.io/groundwork/ (hono, vitest and Relate itself, no install).

**Locally** (Node.js 20 or newer, no GitHub token needed):

```bash
git clone https://github.com/Farouk1901/groundwork && cd groundwork
npm install
npm run demo          # builds the hono graph from docs/data (about 30 s), then serves http://127.0.0.1:7474
```

The snapshots in `docs/data/` are the public histories of the three repositories, with their embeddings, so building
a graph needs no token and no model. Then, from another terminal (stop `serve` first: a Relate store is opened by one
process at a time):

```bash
npx tsx src/cli.ts plan honojs/hono 5601                    # an open ticket: cookie prefixes
npx tsx src/cli.ts plan honojs/hono "JWT middleware should read the token from a cookie with a custom name"
npx tsx src/cli.ts check honojs/hono 5601 --files src/utils/cookie.ts      # forgot the test?
npx tsx src/cli.ts ingest --from docs/data/vitest-dev__vitest.json.gz      # add another repository
npm test                                                    # 20 tests, on in-memory Relate stores (native and WebAssembly)
```

The first question written in words downloads the embedding model (all-MiniLM-L6-v2, about 25 MB) once.

## Your own repository

```bash
export GITHUB_TOKEN=...          # any token with public read access, or just be logged in with `gh`
npx tsx src/cli.ts ingest your-org/your-repo --prs 1500 --issues 2000
npx tsx src/cli.ts plan your-org/your-repo 123
npx tsx src/cli.ts eval your-org/your-repo                  # how well it works on your history
```

Raw GitHub responses are cached in `.groundwork/cache/`, so a re-run, or a demo on a plane, works offline.

### Jira (optional)

Teams that track work in Jira usually put the ticket key in the PR title or body (`SHOP-142: keep = in cookies`).
Groundwork links each Jira ticket to the PRs that mention its key, and from there to files and people:

```bash
export JIRA_EMAIL=you@example.com JIRA_API_TOKEN=...   # read-only search
npx tsx src/cli.ts jira your-site.atlassian.net SHOP --repo your-org/your-repo
npx tsx src/cli.ts plan your-org/your-repo SHOP-142
```

A JSON export of `/rest/api/3/search` results works too: `npx tsx src/cli.ts jira export.json SHOP --repo …`.

## For coding agents

### MCP server

```bash
claude mcp add groundwork -- npx tsx /path/to/groundwork/src/cli.ts mcp
```

| Tool | What it answers |
|---|---|
| `plan_ticket` | Files and modules most likely to change, the reasons (graph paths), experts, risks, similar past work |
| `check_diff` | Given the ticket and the changed files: covered, probably missing, outside the usual footprint |
| `similar_work` | Hybrid search over past tickets and merged PRs |
| `who_knows` | People who merged the most changes to a file or folder |
| `graph_query` | Read-only Cypher over the graph, with the schema in its description; writes are rejected |

### Claude Code skill

[`skill/SKILL.md`](skill/SKILL.md) tells Claude Code (or Cursor, or Codex) to call `plan_ticket` before opening files
for a ticket and `check_diff` before committing. Copy the folder to `~/.claude/skills/groundwork/`.

### GitHub Action (auto-comment on new issues)

[`action.yml`](action.yml) comments Groundwork's ranked files, experts, and risks directly on every newly opened GitHub issue, caching the Relate graph across runs.

### Pre-commit or CI

```bash
npx tsx src/cli.ts check your-org/your-repo 123 --staged --strict    # exit code 1 when likely files are missing
```

## The graph

```
(Person)-[:AUTHORED]->(PR)-[:FIXES]->(Issue)<-[:OPENED]-(Person)
(PR)-[:TOUCHES {additions, deletions}]->(File)-[:IN]->(Module)
(File)-[:CO_CHANGED {count}]->(File)      (Issue)-[:NAMES]->(File)
(Issue)-[:MENTIONS]->(Issue)              (Issue)-[:LABELED]->(Label)
```

Every Issue and PR also stores its text and a 384-dimension embedding. Four Relate indexes sit on top:
`issue_text` and `pr_text` (full-text), `issue_embed` and `pr_embed` (vector, filtered by repository).

`FIXES` comes from GitHub's closing references *and* from "fixes #12" written in the PR body (GitHub links only
those that target the default branch). `NAMES` comes from file paths or unique file names written in the ticket.
`CO_CHANGED` counts PRs (with at most 30 files) that changed both files at least twice.

## How a plan is computed

1. **Seeds.** Files the ticket names. Then hybrid search over past tickets and over merged PRs:

   ```cypher
   MATCH (n:Issue) SEARCH n IN (COMBINE (
       VECTOR INDEX issue_embed FOR $vec WHERE n.repo = $repo LIMIT $k WEIGHT 0.5,
       FULLTEXT INDEX issue_text FOR $kw LIMIT $k WEIGHT 0.5) USING WRRF WITH CONSTANT 60 LIMIT $k) SCORE AS score
   RETURN n.key, n.title, score, vector.similarity.cosine(n.embedding, $vec) AS cos
   ```

   WRRF gives the order; the cosine similarity gives the weight, because fused rank scores are almost flat and say
   nothing about how close a match really is. Matches below cosine 0.3 are dropped. Each similar ticket is followed
   through `(Issue)<-[:FIXES]-(PR)-[:TOUCHES]->(File)`, each similar PR through `(PR)-[:TOUCHES]->(File)`.
2. **Expand** along `CO_CHANGED` from the strongest seeds: the test next to the source, the sibling adapter.
3. **Rank.** Lockfiles, manifests and changelogs are damped; a test ranks just below the source file it covers.
4. **People and risks** come from the same graph: `AUTHORED` PRs that touch the ranked files; open tickets that
   name them or look alike; bug-labelled tickets recently fixed in them.

Every score keeps the reasons that produced it, so the CLI prints them, the web view draws them (click a file to
light up its path), and an agent can quote them.

## The same code in the browser (instant boot + Web Worker)

The online demo opens in **180 ms median** (measured locally via `npm run bench:instant` with Chrome DevTools Protocol: 132 ms FCP, 180 ms instant plan render, zero `> 200 ms` main-thread long tasks) with a pre-baked view of `hono#2550` (Replay) plus samples from `vitest` and `relatedb/relate` (`docs/data/instant.json`), while **`docs/worker.js`** runs `@relate/relate-wasm` (`1.2.0`) in a **dedicated Web Worker** completely off the main thread. Once warm, every ticket lookup, diff check, and free-text query executes live Cypher inside the browser tab. One difference from native `@relate/relate` (`1.0.1`): the WebAssembly build cannot toggle the `hybrid-search` preview via environment variables, so the worker runs the vector and full-text indexes separately and fuses them in TypeScript with identical WRRF. A unit test (`test/blast.test.ts`) runs both `@relate/relate` and `@relate/relate-wasm` in Node.js and verifies matching plans with no version conflict.

Build it yourself: `npm run site` (builds `docs/` and serves it on http://127.0.0.1:8080).

## The backtest, and why it is honest

- **No leakage.** `planTicket(…, { asOf })` filters every hop by merge date: the fixing PR, every PR merged later and
  every ticket opened later are invisible, and co-change is recounted from earlier PRs only. A test pins this.
- **Tuned on one half, reported on the other.** The two weights (vector vs. full-text, and co-change) were picked
  from nine combinations on hono's older half; hono's newer half, vitest and Relate never influenced them.
- **Truth** is the files the fix changed, without manifests and changelogs. **Baseline** ranks the files changed most
  often before that moment: the best any file-first tool can do when there is only a ticket. **Ceiling** is the
  share of fixed files that any earlier PR had touched: a brand-new file cannot be predicted from history.

## Project layout

| Path | |
|---|---|
| `src/github.ts` | GitHub GraphQL: merged PRs with files and closing references, tickets; cached on disk |
| `src/ingest.ts` | Builds the Relate graph (embeddings computed locally, or taken from a snapshot) |
| `src/analyze.ts` | `planTicket`: hybrid search, graph hops, ranking, people, risks, explanation graph; `asOf` replay |
| `src/check.ts` | Diff vs. ticket |
| `src/eval.ts` | Backtest (tickets or PR titles), ablations, baselines, older/newer split |
| `src/jira.ts` | Optional Jira import |
| `src/mcp.ts` | MCP server |
| `src/web.ts`, `public/index.html` | Local web view (Cytoscape.js) |
| `web/`, `scripts/build-site.mjs`, `docs/` | The in-browser demo on Relate WebAssembly, and its data |
| `skill/SKILL.md` | Claude Code skill |

## Built with

TypeScript on Node.js, **Relate** (`@relate/relate` 1.0.1 embedded, with the `hybrid-search` preview;
`@relate/relate-wasm` 1.2.0 in the browser), Transformers.js (all-MiniLM-L6-v2, local), the MCP TypeScript SDK,
Cytoscape.js, esbuild, and the GitHub GraphQL API.

Developed with the help of an AI coding assistant (Claude Code). The design decisions, testing and final review are
the author's.

## Licence

MIT. The snapshots in `docs/data/` contain public data from github.com/honojs/hono (MIT), github.com/vitest-dev/vitest
(MIT) and github.com/relatedb/relate (Apache-2.0), used to demonstrate and evaluate the tool.
