// Store over RelateDb. The import is type-only, so browser.ts does not pull in the WASM runtime.
import type { RelateDb } from '@relate/relate-wasm';
import { SCHEMA, type Row, type Store } from '../src/core.js';

export function wasmStore(db: RelateDb): Store {
  const query = (cypher: string, params?: Record<string, unknown>): Row[] => {
    const p = params && Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const r = JSON.parse(db.execute(cypher, p ? JSON.stringify(p) : null)) as { rows: Row[]; error: unknown };
    if (r.error) throw new Error(typeof r.error === 'string' ? r.error : (r.error as { message?: string }).message ?? JSON.stringify(r.error));
    return r.rows;
  };
  for (const s of SCHEMA) query(s);
  return { query, close: () => db.free(), path: 'relate-wasm (Web Worker)', nativeHybrid: false };
}
