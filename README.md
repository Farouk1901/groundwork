# Groundwork

**The connected context of a ticket, before the first line of code.**

You get a ticket: "Support the `__Http-` and `__Host-Http-` cookie prefixes" (hono#5601, open). Before you (or your coding agent)
open a single file, Groundwork tells you:

- **which files will most likely change**, and *why*, as a path in the graph:
  `your ticket ─SIMILAR→ hono#3189 ←FIXES─ PR #5164 ─TOUCHES→ src/utils/cookie.ts`
- **who knows that code** (who merged the most changes to those files, and when),
- **what to watch**: open tickets about the same thing (duplicates), and recent bug fixes in the same files (regressions),
- and, when you are done, **whether your diff is missing something** that similar fixes always changed (usually the test).

It does this with one embedded [Relate](https://github.com/neo4j-labs/relate) graph built from the repository's own
history: tickets, the pull requests that fixed them, the files they changed, the people who changed them, and the
files that move together. The core retrieval is **hybrid search inside Relate** (vector + full-text, fused with
WRRF in a single Cypher `SEARCH … COMBINE` clause) over tickets and PRs that were already resolved, followed by graph
hops from those matches to the files their fixes touched.

## Does it work? A backtest on 200 real tickets

For every closed ticket of honojs/hono that a merged pull request fixed, Groundwork rebuilds the graph **as it was
the moment the ticket was opened** (the fix, and everything merged later, hidden), predicts the files from the ticket
alone, and compares them with the files the real fix changed. The weights were chosen on the older half of the
tickets; these numbers are on the **newer half, which never influenced a default**:

| Method | Hit@5 | Hit@10 | Recall@5 | Recall@10 | MRR |
|---|---:|---:|---:|---:|---:|
| **Groundwork** | **77.5%** | **83.5%** | **56.6%** | **66.3%** | **0.639** |
| &nbsp;&nbsp;without similar PRs | 69% | 74% | 48.3% | 57.7% | 0.578 |
| &nbsp;&nbsp;without similar tickets | 77% | 83% | 55.3% | 65.5% | 0.668 |
| &nbsp;&nbsp;without co-change | 78% | 83.5% | 56.3% | 65.4% | 0.658 |
| &nbsp;&nbsp;vector only (no full-text) | 74% | 82% | 51.2% | 62.9% | 0.592 |
| &nbsp;&nbsp;full-text only (no vector) | 78% | 81.5% | 57.2% | 65.1% | 0.657 |
| Baseline: the repository's most-changed files | 15.5% | 21.5% | 8.2% | 12.2% | 0.106 |
| Ceiling: fixed files that any earlier PR had touched | | | | 95.2% | |

*Hit@k: a file the real fix changed is in the top k. Recall@k: the share of the fix's files in the top k.
MRR: mean of 1 / rank of the first correct file.*

What the table says, plainly:

- **Starting from the ticket works**: 5 times the hit rate of the best a file-first tool can do before any code exists.
- **The hop through similar merged PRs earns the most** (8.5 points of Hit@5). Similar tickets add a little on
  top; many repositories do not link PRs to tickets, so the PR path matters more.
- **Hybrid search vs. one index**: vector + full-text beats vector alone clearly, and ties full-text alone on
  Hit@5 while finding more of each fix (Recall@10 66.3% vs 65.1%). On a repository whose tickets quote code
  identifiers, full-text carries a lot; on vaguer tickets the vector side matters more.
- **Co-change is a small second hop**: with a high weight it pushed related-but-wrong files up (the older-half
  tuning showed Hit@5 rising from 50% to 60% when we lowered it), so it is kept low. It still brings the test next to the
  source file, which is what `check` relies on.

On all 400 tickets (both halves together, so including the ones the weights were tuned on): Groundwork 69% Hit@5,
vector only 66.3%, full-text only 66.8%, without similar PRs 58.5%, baseline 19.5%. The full results, with every
ablation, are in [`examples/eval/`](examples/eval).

Reproduce it (about 5 minutes per half on a laptop):

```bash
npx tsx src/cli.ts eval honojs/hono --split newer     # this table
npx tsx src/cli.ts eval honojs/hono --split older     # the half the weights were tuned on
```


## Why "before the code"

Tools that analyse impact from code or from a diff (call graphs, co-change, ownership) need a starting file. When
work starts from a ticket, nobody has that file yet: finding it is the actual work. Groundwork starts from the
words of the ticket, finds the past tickets and PRs that meant the same thing, and follows the graph from there.
Co-change and ownership are still used, as a second hop, once the first files are known.

## Quick start (no GitHub token needed)

Requirements: Node.js 20 or newer. Everything runs locally; the embedding model (all-MiniLM-L6-v2, ~25 MB) is
downloaded once on first use.

```bash
git clone https://github.com/Farouk1901/groundwork && cd groundwork
npm install
npm run demo          # builds the graph from examples/honojs__hono.json.gz, then serves http://127.0.0.1:7474
```

The snapshot is the public history of [honojs/hono](https://github.com/honojs/hono): 1,500 merged pull requests
and 1,896 tickets. Building the graph takes a few minutes (most of it is computing embeddings for 3,400 texts on your CPU).

Then, from another terminal (stop `serve` first: a Relate store is opened by one process at a time):

```bash
npx tsx src/cli.ts plan honojs/hono 5601                    # an open ticket: cookie prefixes
npx tsx src/cli.ts plan honojs/hono "JSX streaming breaks when a component throws inside Suspense"
npx tsx src/cli.ts check honojs/hono 5601 --files src/utils/cookie.ts      # forgot the test?
npx tsx src/cli.ts eval honojs/hono --split newer          # the backtest above
npm test                                                    # tests on an in-memory Relate store
```

## Your own repository

```bash
export GITHUB_TOKEN=...          # any token with public read access, or just be logged in with `gh`
npx tsx src/cli.ts ingest your-org/your-repo --prs 1500 --issues 2000
npx tsx src/cli.ts plan your-org/your-repo 123
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
   nothing about how close a match really is. Matches below cosine 0.3 are dropped. The 0.5 / 0.5 split and the
   co-change weight were chosen on the older half of the backtest. Each similar ticket is followed
   through `(Issue)<-[:FIXES]-(PR)-[:TOUCHES]->(File)`, each similar PR through `(PR)-[:TOUCHES]->(File)`.
2. **Expand** along `CO_CHANGED` from the strongest seeds: the test next to the source, the sibling adapter.
3. **Rank.** Lockfiles, manifests and changelogs are damped; a test ranks just below the source file it covers.
4. **People and risks** come from the same graph: `AUTHORED` PRs that touch the ranked files; open tickets that
   name them or look alike; bug-labelled tickets recently fixed in them.

Every score keeps the reasons that produced it, so the CLI prints them, the web view draws them, and an agent can
quote them.

## The backtest, and why it is honest

`eval` takes every closed ticket that a merged PR fixed (with at least 50 PRs of history before it) and replays the
graph **as it was the moment the ticket was opened**: the fixing PR, every PR merged later and every ticket opened
later are invisible, and co-change is recounted from earlier PRs only. It then compares the predicted files with
the files the real fix changed (manifests and changelogs excluded). The baseline ranks the files changed most often
before that moment, which is the best any file-first tool can do when there is only a ticket. "Ceiling" is the share
of fixed files that any earlier PR had touched: a brand-new file cannot be predicted from history.

## Project layout

| Path | |
|---|---|
| `src/github.ts` | GitHub GraphQL: merged PRs with files and closing references, tickets; cached on disk |
| `src/ingest.ts` | Builds the Relate graph and embeddings |
| `src/analyze.ts` | `planTicket`: hybrid search, graph hops, ranking, people, risks, explanation graph; `asOf` replay |
| `src/check.ts` | Diff vs. ticket |
| `src/eval.ts` | Backtest, ablations, baselines |
| `src/jira.ts` | Optional Jira import |
| `src/mcp.ts` | MCP server |
| `src/web.ts`, `public/index.html` | Web view (Cytoscape.js) |
| `skill/SKILL.md` | Claude Code skill |
| `examples/` | hono snapshot, so anyone can build the graph without a token |

## Built with

TypeScript on Node.js, **Relate 1.0.1** (`@relate/relate`, embedded, with the `hybrid-search` preview),
Transformers.js (all-MiniLM-L6-v2, local), the MCP TypeScript SDK, Cytoscape.js, and the GitHub GraphQL API.

Developed with the help of AI coding assistants (Claude Code). All design decisions, testing and the final review
are the author's.

## Licence

MIT. The example snapshot contains public data from github.com/honojs/hono (MIT), used to demonstrate the tool.
