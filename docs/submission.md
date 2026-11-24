# Devpost submission: Groundwork

## Project name
Groundwork

## Tagline (max 200 characters)
Before the first line of code: Groundwork reads a ticket, finds how similar tickets were fixed, and shows the files, people and risks, each with the Relate graph path behind it.

## Links
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
  *your ticket → similar ticket hono#3189 ← fixed by PR #5164 → `src/utils/cookie.ts`*
- **Who knows that code**: the people who merged the most changes to those files, and when.
- **What to watch**: open tickets about the same thing (likely duplicates) and recent bug fixes in the same files
  (regressions you must not reintroduce).
- **Similar past work**: the tickets and PRs to read before you design the fix.

And when the change is written, `check` compares the diff with the ticket: covered files, files that similar
fixes also changed but you did not (usually the test), and files outside the ticket's usual footprint.

It works as a CLI, an **MCP server** for Claude Code / Cursor / Codex (`plan_ticket`, `check_diff`, `similar_work`,
`who_knows`, read-only `graph_query`), a **Claude Code skill**, a pre-commit / CI gate (`check --strict`), and a
local web view that draws the path behind each answer.

**Does it work? We measured it.** `eval` replays the repository's history: for each of the 200 newest real tickets of
honojs/hono that a merged PR fixed (the older 200 were used to choose the weights, these never were), it rebuilds the view of the graph *as of the moment the ticket was opened*
(the fix and everything later hidden), predicts the files from the ticket alone, and compares them with the real fix.

| Method | Hit@5 | Recall@10 |
|---|---:|---:|
| **Groundwork** | **77.5%** | **66.3%** |
| without the hop through similar PRs | 69% | 57.7% |
| vector search only | 74% | 62.9% |
| Baseline: the repository's most-changed files | 15.5% | 12.2% |

Hit@5: a file the real fix changed is among the first five suggestions. Five times the baseline, which is the best a
tool that needs a starting file can do before any code exists. Every number reproduces with one command.

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
- TypeScript on Node.js with tsx, the MCP TypeScript SDK, Cytoscape.js for the web view, `node:test` for the tests
  (10 tests against an in-memory Relate store).

## Challenges we ran into

- **Fused scores are flat.** WRRF ranks well but its scores barely separate a near-duplicate from a loose match, so
  files from weak matches crowded the list. Reading `vector.similarity.cosine` next to the fused score, and weighting
  by it, fixed the ranking.
- **Leakage.** The first backtest was too good: the ticket's own fix was in the graph, and co-change edges were
  counted over all history. The `asOf` replay hides both, and a test pins it.
- **Noise files.** Lockfiles, manifests and changelogs change in every PR; they are damped, and huge PRs (renames,
  formatting) are left out of co-change.
- **Many repos never link PRs to tickets.** Searching merged PRs directly, not only tickets, covers them.

## Accomplishments that we're proud of

- A measured result, reproducible with one command, with ablations that show which part of the graph earns its keep.
- Every answer is explainable: the web view lights up the path from the ticket to any suggested file.
- A judge can run everything without a GitHub token: the hono snapshot ships in the repository.

## What we learned

Retrieval finds the *meaning* (which old ticket is this one like?), and the graph turns meaning into *places and
people* (which files did that fix change, who changed them, what moves with them). Neither alone is enough: the
ablations show the drop when either is removed. An embedded graph makes this cheap enough to run before every ticket.

## What's next

Follow file renames, weight recent history higher, learn the hybrid weights per repository from the backtest,
GitLab and Linear importers, and a GitHub Action that comments the groundwork on each new issue.

## Built with
relate, neo4j, cypher, typescript, node.js, transformers.js, mcp, cytoscape.js, github-graphql-api, jira-rest-api

## Relate capabilities used
Embedded use (`@relate/relate` in-process), Cypher (MERGE / UNWIND ingest, multi-hop MATCH, aggregation),
uniqueness constraints and property indexes, **vector indexes with a filter**, **full-text indexes**, **hybrid
retrieval with `SEARCH … COMBINE … USING WRRF`** (preview feature `hybrid-search`), `vector.similarity.cosine`,
and an MCP server that exposes the graph (including read-only Cypher) to coding agents.

## Third-party tools
GitHub GraphQL API, Jira Cloud REST API (optional), Transformers.js with the all-MiniLM-L6-v2 model, MCP TypeScript
SDK, Cytoscape.js, zod, tsx. Demo data: public history of honojs/hono (MIT).

## AI tools used in development
The code, tests and documentation were written with significant help from an AI coding assistant (Claude Code,
Anthropic). I directed the design (the ticket-first approach, the graph model, the backtest and its leakage
controls), reviewed and tested the code, and made the product decisions. The product itself calls no hosted AI
model: its embeddings are computed locally.
