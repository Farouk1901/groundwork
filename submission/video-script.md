# Demo video script: Groundwork (1:55)

The rules say the video must be the entrant's own work: filming, editing and graphics. Ahmed records the narration in
his own voice **and** the same words appear as on-screen captions (two short lines at a time, synced to the voice).
Narration is about 260 words: read it slowly, about 130 words a minute. No third-party music.

Setup before recording: the live demo open at https://farouk1901.github.io/groundwork/ (or `npm run site` locally),
zoom 110%, one theme only (dark or light, not both), a terminal with Claude Code in a hono clone, the MCP server added.

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:14 | hono ticket #2550 on GitHub: "Regression caused by multiHeaderValue handling on Lambda" (opened 24 April 2024) | April 2024. A user reports a regression in hono's AWS Lambda adapter. Before anyone writes a fix, someone has to find where it lives, who knows that code, and what broke there before. |
| 0:14–0:24 | Title card: **Groundwork**, "the connected context of a ticket, before the first line of code" | Groundwork answers that from the repository's own history, in a Relate graph. |
| 0:24–0:50 | Live demo: type 2550, press Plan, then press **Replay**. The banner turns green; `handler.ts` gets a ✓ at the top | Replay rewinds the graph to the day the ticket was opened. The fix doesn't exist yet. Hybrid search inside Relate (vector and full-text in one Cypher query) finds past tickets and PRs that meant the same thing, and the graph follows them to the files they changed. First suggestion: handler.ts, exactly the file the real fix changed twelve days later. |
| 0:50–1:05 | Click the top file: the path lights up in the graph (ticket → similar PR → file → people) | Every answer is a path you can check. And the people who know that code, and the bug fixes in the same files you must not undo. |
| 1:05–1:18 | Open ticket 5601. "Check your change": press "Try: top file only"; the test file shows as missing | When the change is written, check compares it with the ticket: similar fixes also changed the test, and you didn't. |
| 1:18–1:32 | Claude Code terminal in a hono clone: "work on issue 5601". The agent calls `plan_ticket`, then opens the right file | Coding agents get the same through MCP and a Claude Code skill: plan before editing, check before committing. |
| 1:32–1:55 | The green results banner; switch the repository to vitest, then to relatedb/relate | Does it work beyond one example? We replayed hundreds of real tickets, fixes hidden. On hono, the right file is in the top five 77 percent of the time; on vitest, which we never tuned on, 60; on Relate's own repository, from the PR title alone, 53. The most-changed files manage 15 to 18. All of it runs in your browser, on Relate WebAssembly. Open source, MIT. Groundwork. |

## Captions
The captions are the narration word for word, split into chunks of 6 to 10 words. Each chunk stays on screen while
it is being said. Keep them in the bottom band so they don't cover the graph or the file list. In the last scene,
show the three numbers large next to the baseline.

## Recording order
1. Record the voice first, in a quiet room, sentence by sentence.
2. Record the screen against the voice, scene by scene, using the table above.
3. Edit and add the captions yourself, to stay within the "own work" rule.
