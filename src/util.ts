import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { RepoData } from './github.js';
import { decodeVectors } from './vectors.js';

export { targetOf } from './target.js';

/**
 * A repository snapshot, plain or gzipped: the cached GitHub data, or a web export that also carries the embeddings
 * (int8), which makes building the graph take seconds instead of minutes. Lets anyone build it without a token.
 */
export function readSnapshot(file: string): { data: RepoData; vectors?: number[][] } {
  const buf = readFileSync(file);
  const j = JSON.parse((file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')) as RepoData | { data: RepoData; vectors: string; dim: number; scale: number };
  if ('vectors' in j && 'data' in j) return { data: j.data, vectors: decodeVectors(j.vectors, j.dim, j.scale) };
  return { data: j as RepoData };
}
