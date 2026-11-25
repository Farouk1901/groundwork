# Demo video script: Groundwork (1:55 — hard limit 2:00)

**Rules & authenticity:** Must be entrant's own work (filming, editing, narration). Ahmed records the narration in **his own real voice** (no AI voice clone, no third-party music), with burned-in synced English captions (6–10 words per chunk, bottom band so the graph stays unobstructed).
**Word count:** ~250 words (~130 wpm → ~1:55 with 5 s margin under the 2:00 cap).

Setup before recording: live demo open at `https://farouk1901.github.io/groundwork/` (instant boot opens directly on `hono#2550` Replay in `< 200 ms`, while Relate WASM loads in a Web Worker in the background), zoom 110%, one theme only, and a terminal with Claude Code connected to the Groundwork MCP server.

| Time | Screen | Narration (Ahmed's real voice) |
|---|---|---|
| **0:00–0:20** | **Hook (result first):** Open `hono#2550` (*"Regression caused by multiHeaderValue handling on Lambda"*) — Groundwork's GitHub Action comment + instant **Replay** showing `src/adapter/aws-lambda/handler.ts` ranked #1 with green **✓** | Before anyone writes a single line of code, a ticket lands. Here's hono #2550, a real AWS Lambda regression. Groundwork rewinds the Relate graph to the day it opened — hiding the fix — and ranks `handler.ts` number one. Twelve days later, the real PR fixed that exact file. |
| **0:20–0:55** | Click `handler.ts` → graph path lights up (`ticket → similar PR → file → people → risks`). Then open `#5601` → **Check your change** → press *"Try: top file only"* → missing test file flagged in red. | How? Hybrid search inside Relate — vector and full-text fused with WRRF in one Cypher query — finds similar past tickets and PRs, then follows the graph to the files, the engineers who know them, and recent regressions to watch. Click any file to inspect its exact graph path. When code is ready, `check` catches the test file that similar fixes always changed. |
| **0:55–1:20** | Terminal: Claude Code in a `hono` clone. Prompt: *"plan issue 5601"* → calls MCP `plan_ticket` → immediately opens `src/utils/cookie.ts` and `cookie.test.ts` without blind grepping. | Coding agents use the same Relate graph through MCP and a built-in skill — jumping straight to the right files instead of burning tokens grepping blindly. |
| **1:20–1:55** | Unified 3-repo results table + 5 s switch in the live demo dropdown to **`relatedb/relate`** showing **68.2%** fused vs 60.4% grep + quick glance at the 617 sealed-forecasts banner + browser WASM badge (`133 ms` median boot, Web Worker). | Across 703 held-out cases on hono, vitest, and Relate's own repository — where Groundwork + grep hits 68.2% vs 60.4% for grep alone — we reach 69.7% Hit@5, 3.7 to 5.1 times baseline. We even sealed 617 open-ticket forecasts on November 24 to score against future fixes. Zero install, running Relate WebAssembly right in your browser, with a ready `.rl` store in the repo. MIT — Groundwork. |

## Recording checklist
1. Record Ahmed's real voice first in a quiet room, checking total audio length is **≤ 1:55**.
2. Record screen clips synced to each timestamp row above (no blank loading screen — instant boot renders immediately).
3. Verify the numbers shown on screen match the final post-`b10c11b` table in `README.md` and `submission/devpost.md` verbatim.
4. Confirm zero third-party music, zero third-party logos, and final video duration **≤ 2:00**.
