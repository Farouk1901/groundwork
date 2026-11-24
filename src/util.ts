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
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const j = JSON.parse((isGzip ? gunzipSync(buf) : buf).toString('utf8')) as RepoData | { data: RepoData; vectors: string; dim: number; scale: number };
  if ('vectors' in j && 'data' in j) return { data: j.data, vectors: decodeVectors(j.vectors, j.dim, j.scale) };
  return { data: j as RepoData };
}
