# Groundwork Sealed Forecast Snapshot (2026-11-24)

This GitHub Release provides a **server-timestamped external anchor** for Groundwork's **617 sealed forecasts** (commit `f9e4c54`).

Every forecast in `sealed.json` was computed strictly for **open, unfixed issues** (never open PRs whose diffs are already public) before any fix existed. The daily Action scores newly merged fixes against this frozen file until the Relate by Neo4j hackathon deadline (`2026-12-11 18:00 PST`).

## Integrity verification (SHA-256)

```text
a48a0eb87d0462673ccd14ed22e989d8535fbc1f2ccc2e602dd0d216b817398b  sealed.json
```

Verify locally:

```bash
sha256sum -c sealed.sha256
```

## Breakdown

| Repository | Sealed open issues | Graph snapshot |
|---|---:|---|
| `honojs/hono` | 263 open unfixed issues | `2026-11-24T08:06:05.873Z` |
| `vitest-dev/vitest` | 352 open unfixed issues | `2026-11-24T10:05:24.804Z` |
| `relatedb/relate` | 2 open unfixed issues | `2026-11-24T10:02:51.861Z` |

> Note: `relatedb/relate` only had 2 open issues at seal time; its primary evaluation is the leak-free `asOf` historical backtest on 283 merged PR titles.
