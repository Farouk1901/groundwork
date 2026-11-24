#!/usr/bin/env node
// Prepares the immutable GitHub Release artifact and release notes for the 617 sealed forecasts.
// Does NOT publish anything — the Main Session runs `gh release create` using the generated files.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sealedPath = path.join(root, 'docs', 'predictions', 'sealed.json');
const shaPath = path.join(root, 'docs', 'predictions', 'sealed.sha256');
const notesPath = path.join(root, 'submission', 'release-seal-body.md');

const raw = readFileSync(sealedPath);
const hash = createHash('sha256').update(raw).digest('hex');
const sealed = JSON.parse(raw.toString('utf8'));
const total = sealed.repos.reduce((a, r) => a + r.forecasts.length, 0);

writeFileSync(shaPath, `${hash}  sealed.json\n`);

const rows = sealed.repos.map((r) => `| \`${r.repo}\` | ${r.forecasts.length} open unfixed issues | \`${r.graphFetchedAt}\` |`).join('\n');

const body = `# Groundwork Sealed Forecast Snapshot (${sealed.sealedAt.slice(0, 10)})

This GitHub Release provides a **server-timestamped external anchor** for Groundwork's **${total} sealed forecasts** (commit \`f9e4c54\`).

Every forecast in \`sealed.json\` was computed strictly for **open, unfixed issues** (never open PRs whose diffs are already public) before any fix existed. The daily Action scores newly merged fixes against this frozen file until the Relate by Neo4j hackathon deadline (\`2026-12-11 18:00 PST\`).

## Integrity verification (SHA-256)

\`\`\`text
${hash}  sealed.json
\`\`\`

Verify locally:

\`\`\`bash
sha256sum -c sealed.sha256
\`\`\`

## Breakdown

| Repository | Sealed open issues | Graph snapshot |
|---|---:|---|
${rows}

> Note: \`relatedb/relate\` only had 2 open issues at seal time; its primary evaluation is the leak-free \`asOf\` historical backtest on 283 merged PR titles.
`;

writeFileSync(notesPath, body);
console.log(`Prepared release seal for ${total} forecasts:`);
console.log(`  SHA-256: ${hash}`);
console.log(`  Wrote:   ${path.relative(root, shaPath)}`);
console.log(`  Wrote:   ${path.relative(root, notesPath)}`);
