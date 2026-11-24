# Demo video script: Groundwork (1:55)

The rules say the video must be the entrant's own work: filming, editing and graphics. So Ahmed records the screen
and edits it himself. Use no third-party music unless its licence allows it.
**Voice:** Ahmed records the narration in his own voice, **and** the same words appear as on-screen captions
(two short lines at a time, synced to the voice). Narration is about 250 words: read it slowly, about 130 words a minute.

Setup before recording: `npm run demo` running, browser at http://127.0.0.1:7474, zoom 110%, dark or light theme
(not both), a terminal with Claude Code in a hono clone, the MCP server added.

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:12 | The real open hono ticket #5601 on GitHub: "Support the __Http- and __Host-Http- cookie prefixes" | Every change starts as a ticket. Before writing code, you need to know where it lives, who knows that code, and what broke there before. Tools that start from code can't help yet: there is no code. |
| 0:12–0:22 | Title card: **Groundwork**, "the connected context of a ticket, before the first line of code", Relate logo text only | Groundwork answers from the repository's own history, in a Relate graph. |
| 0:22–0:50 | Web view: type 5601, press Plan. Files appear; click file 1, the path lights up in the graph | Hybrid search inside Relate (vector and full-text, fused in one Cypher query) finds past tickets that meant the same thing. The graph follows each one to the PR that fixed it, and to the files that PR changed. Click a file and you see exactly why it is there. |
| 0:50–1:05 | Scroll to: Who knows this code, Watch out for, Similar past work | It also finds who changed those files most, open tickets that look like duplicates, and recent bug fixes in the same files you must not undo. |
| 1:05–1:20 | "Check your change": paste only `src/utils/cookie.ts`, press Check, the test file shows as missing | When you're done, check compares your diff with the ticket. Similar fixes also changed the test, and you didn't. |
| 1:20–1:38 | Claude Code terminal in a hono clone: "work on issue 5601". The agent calls `plan_ticket`, then edits the right file | Coding agents get the same through MCP and a Claude Code skill: plan before editing, check before committing. |
| 1:38–1:55 | The green proof banner, then open the results table | Does it work? We replayed the 200 newest real hono tickets, each as of the day it was opened, with its fix hidden. A file from the real fix was in the top five 77.5% of the time. The most-changed files: 15.5%. Open source, MIT, runs locally. Groundwork. |

## Captions
The captions are the narration word for word, split into chunks of 6 to 10 words. Each chunk stays on screen
while it is being said. Place them in the bottom band so they don't cover the graph or the file list. In the
final scene, show the two numbers large (the hit rate and the baseline).

## Recording order
1. Record the voice first, in a quiet room, sentence by sentence.
2. Record the screen against the voice, scene by scene, using the table above.
3. Edit and add the captions yourself, to stay within the "own work" rule. No third-party music.
