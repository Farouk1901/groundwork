import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { RepoData } from './github.js';

/** "1234" or "#1234" is a GitHub ticket, "SHOP-142" a Jira key; anything else describes the change. */
export const targetOf = (what: string): { issue: number | string } | { text: string } =>
  /^#?\d+$/.test(what.trim()) ? { issue: Number(what.trim().replace('#', '')) }
    : /^[A-Z][A-Z0-9]+-\d+$/.test(what.trim()) ? { issue: what.trim() } : { text: what.slice(0, 2000) };

/** A repository snapshot (the cached GitHub data), plain or gzipped: lets anyone build the graph without a token. */
export function readSnapshot(file: string): RepoData {
  const buf = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')) as RepoData;
}
