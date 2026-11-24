---
name: groundwork
description: Before writing code for a ticket (a GitHub issue, a Jira key, or a described change), get its connected context from the repository's history in a Relate graph - the files similar past fixes changed, who knows that code, open tickets and recent bug fixes to watch - and before committing, check the diff against it. Use when the user hands you an issue number, a Jira key like SHOP-142, or asks you to fix, implement or change something in a repository that Groundwork has ingested.
---

# Groundwork: the ticket's history before the first line of code

Groundwork keeps a Relate graph of a repository: tickets, the pull requests that fixed them, the files those PRs
changed, who changed them, and which files move together. It answers from that graph, and every file it suggests
comes with the path that led there (ticket → similar past ticket → the PR that fixed it → file).

## When you get a ticket

1. Before opening any file, call the MCP tool `plan_ticket` with `repo` and either `issue` (a number or a Jira key)
   or `text` (the change in your own words). Without MCP, run:
   `npx tsx <groundwork>/src/cli.ts plan owner/repo 1234`
2. Read the top files first. Each one says why it is there; a file reached through a *similar past ticket* shows
   how that ticket was fixed: open that PR before you design your own fix.
3. Look at **Watch out for**. An open ticket about the same thing may be a duplicate; a recent bug fix in the same
   file is a regression you must not reintroduce.
4. If the plan names people under **Who knows this code**, mention them when you suggest a reviewer.

## Before you commit

Call `check_diff` with the ticket and the files you changed (or run
`npx tsx <groundwork>/src/cli.ts check owner/repo 1234 --staged`).

- **Probably missing**: similar fixes changed these too. Usually it is the test next to the source file, or a
  sibling adapter. Change it, or say in the PR why it is not needed.
- **Outside the usual footprint**: fine if the change is intended; otherwise it is scope creep.

## Rules

- Groundwork predicts from history. It is a map, not an order: confirm in the code before you edit.
- If `plan_ticket` returns nothing similar, say so; this is new ground, so read more code before editing.
- `graph_query` runs read-only Cypher over the same graph for anything else (schema in its description).
