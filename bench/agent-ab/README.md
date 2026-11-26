# Agent A/B test

Does Groundwork help a coding agent that already has `grep`? Each ticket runs twice with the same model and tools:

- **A**: Claude Code (`claude -p`, Sonnet, max 25 turns) with Read, Grep, Glob and read-only `git log/show/blame/grep` and `ls`. No web, no edits.
- **B**: the same, plus the Groundwork MCP server with only `plan_ticket` allowed, the skill in `skill/SKILL.md` as system prompt, and one line in the prompt saying the repository's `CLAUDE.md` asks agents to start from `plan_ticket`. The server runs with `GROUNDWORK_AS_OF` set to the ticket's creation time, so the graph holds only tickets opened and PRs merged before it.

The agent works in a checkout of the repository at the commit just before the fix and answers with up to five files it would change. A run is scored against the files the real fix changed.

## Ticket sets

| Set | Tickets | How they were picked |
|---|---|---|
| `named` | 20 `hono` + 20 `vitest` | every 10th / 11th held-out case (`--split newer`), ticket text as filed |
| `symptom` | 15 `hono` + 15 `vitest`, none in `named` | every 10th / 11th held-out case from another offset, rewritten by `rewrite.mjs` |

`rewrite.mjs` asks Claude to restate each ticket as a user or support agent would: what they did, saw and expected, with no file, function, type, option or flag names and no guess at the cause. It sees the ticket text only, never the fix. The original text stays in each case as `origTitle` / `origBody`. The `symptom` prompts carry no ticket number, so the agent cannot look the ticket up.

## Leakage checks

`score.mjs` marks a run as leaked if its transcript contains the fix PR's number, the fix commit, or `git log --all`. None did. In B, every run called `plan_ticket`.

## Reproduce

```bash
npx tsx bench/agent-ab/select.ts vitest-dev/vitest /path/to/vitest 220 6 11 15 cases.json   # pick cases
node bench/agent-ab/rewrite.mjs cases.json symptom-vitest.json                              # symptom-only text
# one checkout per case at its preFixCommit: $GW_WORKTREES/vitest/<issue>
GW_WORKTREES=/path/to/worktrees node bench/agent-ab/run.mjs symptom-vitest.json runs/symptom-vitest
node bench/agent-ab/score.mjs runs                                                          # writes docs/data/agent-ab.json
```

`run.mjs` runs one ticket at a time, never re-runs a ticket that already has a result, and stops when the runs pass $15 at API list prices. The four case files used here are in `cases/`.

## Caveats

Seventy tickets from two repositories is a small sample; one ticket moves a count by one. The rewrite is done by a model and may keep words a real user would not know. B is told to use Groundwork. Without that line, on tickets that name the code, the agent did not call it and went straight to `grep`.
