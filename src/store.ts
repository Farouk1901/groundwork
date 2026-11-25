// The graph lives in one Relate store (a directory on disk, or :memory: for tests).
// Hybrid search (vector + full-text fused with WRRF) is a Relate preview feature, so it is switched on here,
// before the native library loads.
process.env.RELATE_PREVIEW = [process.env.RELATE_PREVIEW, 'hybrid-search'].filter(Boolean).join(',');

import { Database } from '@relate/relate';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Data lives next to the project by default (override with GROUNDWORK_HOME), whatever folder you run it from. */
export const HOME = process.env.GROUNDWORK_HOME || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.groundwork');

import { SCHEMA, type Row, type Store } from './core.js';
export { EMBED_DIM, SEARCH_INDEXES, ensureSearchIndexes, num, type Row, type Store } from './core.js';

export function openStore(
  dir = process.env.GROUNDWORK_DB || (existsSync(path.join(HOME, 'graph')) ? path.join(HOME, 'graph') : path.join(HOME, 'graph.rl')),
): Store {
  let db: ReturnType<typeof Database.open>;
  try { db = Database.open(dir); }
  catch (e) {
    throw new Error(`Could not open the graph at ${dir} (${(e as Error).message}). Relate allows one process per store: stop "serve" or "mcp" if it is running, or set GROUNDWORK_DB to another folder.`);
  }
  const conn = db.connect();
  const run = conn.query.bind(conn) as unknown as (c: string, p?: Record<string, unknown>) => { rows: Row[] };
  // Undefined is not a Cypher value: drop such params, so optional ones can be passed as they are.
  const query = (cypher: string, params?: Record<string, unknown>) =>
    run(cypher, params && Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))).rows;
  for (const s of SCHEMA) query(s);
  return { query, path: dir, close: () => { try { (db as unknown as { close?: () => void }).close?.(); } catch { /* ignore */ } } };
}

