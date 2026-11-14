// The graph lives in one Relate store (a directory on disk, or :memory: for tests).
// Hybrid search (vector + full-text fused with WRRF) is a Relate preview feature, so it is switched on here,
// before the native library loads.
process.env.RELATE_PREVIEW = [process.env.RELATE_PREVIEW, 'hybrid-search'].filter(Boolean).join(',');

import { Database } from '@relate/relate';

export type Row = Record<string, unknown>;
export type Store = { query: (cypher: string, params?: Record<string, unknown>) => Row[]; close: () => void; path: string };

export const EMBED_DIM = 384;

const SCHEMA = [
  'CREATE CONSTRAINT issue_key IF NOT EXISTS FOR (n:Issue) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT pr_key IF NOT EXISTS FOR (n:PR) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT file_key IF NOT EXISTS FOR (n:File) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT module_key IF NOT EXISTS FOR (n:Module) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT person_login IF NOT EXISTS FOR (n:Person) REQUIRE n.login IS UNIQUE',
  'CREATE CONSTRAINT label_key IF NOT EXISTS FOR (n:Label) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT repo_name IF NOT EXISTS FOR (n:Repo) REQUIRE n.name IS UNIQUE',
  'CREATE INDEX issue_repo IF NOT EXISTS FOR (n:Issue) ON (n.repo)',
  'CREATE INDEX file_path IF NOT EXISTS FOR (n:File) ON (n.path)',
];

// Search indexes are (re)built after an import, once every node has its text and embedding.
export const SEARCH_INDEXES = [
  'CREATE FULLTEXT INDEX issue_text IF NOT EXISTS FOR (n:Issue) ON EACH [n.title, n.body]',
  'CREATE VECTOR INDEX issue_embed IF NOT EXISTS FOR (n:Issue) ON n.embedding WITH [n.repo, n.state]',
  'CREATE FULLTEXT INDEX pr_text IF NOT EXISTS FOR (n:PR) ON EACH [n.title, n.body]',
  'CREATE VECTOR INDEX pr_embed IF NOT EXISTS FOR (n:PR) ON n.embedding WITH [n.repo]',
];

export function openStore(path = process.env.BLAST_DB || './.blast-radius/graph'): Store {
  const db = Database.open(path);
  const conn = db.connect();
  const query = (cypher: string, params?: Record<string, unknown>) => conn.query(cypher, params).rows as Row[];
  for (const s of SCHEMA) query(s);
  return { query, path, close: () => { try { (db as unknown as { close?: () => void }).close?.(); } catch { /* ignore */ } } };
}

export function ensureSearchIndexes(store: Store) {
  for (const s of SEARCH_INDEXES) {
    try { store.query(s); } catch (e) { console.warn('index:', (e as Error).message); }
  }
}

/** Numbers from the engine can be bigint (lossless int64); the rest of the app wants plain numbers. */
export const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
