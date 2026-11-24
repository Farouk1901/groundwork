# Draft GitHub Issue for `relatedb/relate` *(DO NOT PUBLISH WITHOUT AHMED'S APPROVAL)*

**Target repository:** `relatedb/relate`
**Title:** Allow enabling preview features (e.g. `hybrid-search`) in `@relate/relate-wasm` without environment variables

---

## Body

Hi Relate team!

We built **Groundwork** (an open-source ticket-to-files graph tool) using `@relate/relate` on Node.js and `@relate/relate-wasm` (`1.2.0`) in the browser for an instant zero-install demo.

### The issue
In the native Node binding (`@relate/relate`), preview features like `hybrid-search` (`SEARCH n IN (COMBINE (VECTOR INDEX ..., FULLTEXT INDEX ...) USING WRRF)`) are enabled through an environment variable (`RELATE_PREVIEW_FEATURES=hybrid-search`).

In a browser running `@relate/relate-wasm`, there is no process environment variable, so any Cypher query using `SEARCH ... COMBINE ... USING WRRF` fails in WASM with a preview-feature error even though both vector indexes and full-text indexes work independently inside `@relate/relate-wasm`.

### Minimal reproducer (Node or browser with `@relate/relate-wasm` 1.2.0)

```js
import init, { RelateDb } from '@relate/relate-wasm';

await init();
const db = new RelateDb();
db.execute('CREATE FULLTEXT INDEX doc_text FOR (d:Doc) ON EACH [d.title]');
db.execute('CREATE VECTOR INDEX doc_vec FOR (d:Doc) ON (d.embedding) OPTIONS { indexConfig: { `vector.dimensions`: 4, `vector.similarity_function`: "cosine" } }');
db.execute('CREATE (:Doc { title: "cookie parser", embedding: [1.0, 0.0, 0.0, 0.0] })');

// Fails in WASM because preview features can only be toggled via env vars:
const res = JSON.parse(db.execute(`
  MATCH (d:Doc)
  SEARCH d IN (COMBINE (
    VECTOR INDEX doc_vec FOR $vec LIMIT 5 WEIGHT 0.5,
    FULLTEXT INDEX doc_text FOR $kw LIMIT 5 WEIGHT 0.5
  ) USING WRRF WITH CONSTANT 60 LIMIT 5) SCORE AS score
  RETURN d.title, score
`, JSON.stringify({ vec: [1, 0, 0, 0], kw: 'cookie' })));
console.log(res.error);
```

### Workaround we used
We run `VECTOR INDEX` and `FULLTEXT INDEX` as two separate Cypher queries inside `@relate/relate-wasm` and fuse them with the same WRRF formula in TypeScript. That works and matches native Top-5 ranking on 188/200 tickets, but it duplicates fusion logic and takes two queries instead of one.

### Suggested API
Allow passing preview flags when constructing `RelateDb` in WASM (and optionally in native bindings too):

```ts
const db = new RelateDb({ previewFeatures: ['hybrid-search'] });
// or:
const db = RelateDb.openWithOptions({ previewFeatures: ['hybrid-search'] });
```

Happy to test a prerelease or help verify a PR if helpful — `@relate/relate-wasm` has been awesome to build with!
