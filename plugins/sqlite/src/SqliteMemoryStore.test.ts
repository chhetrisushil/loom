import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./SqliteMemoryStore";

// What the portable kit cannot see. `search` joins the FTS index back to `memory_entries`,
// so a deleted row is filtered out of results whether or not the index was told about the
// delete — every conformance case passes with the delete trigger removed. What actually
// rots is the index itself: it grows without bound as entries are evicted, and BM25 ranks
// against document statistics that count rows nobody can retrieve. This asserts the
// external-content index is genuinely maintained, not merely masked.
describe("SqliteMemoryStore FTS index maintenance", () => {
  let dir: string;
  let path: string;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-memory-fts-"));
    path = join(dir, "memory.db");
    store = new SqliteMemoryStore(path);
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Index hits for a term, read WITHOUT the join that would hide a stale entry. */
  const indexHits = (term: string): number => {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?")
        .get(`"${term}"`) as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  };

  it("indexes an appended entry", async () => {
    await store.append("k", { content: "forgettable fact", timestamp: 1 });
    expect(indexHits("forgettable")).toBe(1);
  });

  it("removes cleared entries from the index, not just from the results", async () => {
    await store.append("k", { content: "forgettable fact", timestamp: 1 });
    await store.clear("k");
    expect(indexHits("forgettable")).toBe(0);
  });

  it("removes id-deleted entries from the index", async () => {
    // `remove` is the corpus path: a document revised once a week leaks a whole revision
    // into the index each time, and the join hides every one of them from `search`.
    await store.append("k", { id: "RB-1#0", content: "superseded passage", timestamp: 1 });
    await store.append("k", { id: "RB-1#1", content: "second passage", timestamp: 1 });
    await store.remove("k", ["RB-1#0"]);
    expect(indexHits("superseded")).toBe(0);
    expect(indexHits("second")).toBe(1);
  });

  it("uses the id index rather than scanning the key (remove stays cheap on a big corpus)", async () => {
    // The point of `remove` over read-filter-replace is that deleting one document does not
    // touch the rest of the corpus. That is only true if the expression index is USED —
    // an index SQLite ignores makes this a full scan of the scope with extra steps.
    const db = new Database(path, { readonly: true });
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN DELETE FROM memory_entries
             WHERE key = ? AND json_extract(entry, '$.id') IN (SELECT value FROM json_each(?))`
        )
        .all("k", "[]") as { detail: string }[];
      expect(plan.map((r) => r.detail).join(" | ")).toContain("idx_memory_entries_id");
    } finally {
      db.close();
    }
  });

  it("removes replaced entries from the index", async () => {
    // The path eviction takes on every TTL/maxEntries rewrite, so a leak here grows with
    // the age of the memory rather than with the size of it.
    await store.append("k", { content: "superseded fact", timestamp: 1 });
    await store.replace("k", [{ content: "current fact", timestamp: 2 }]);
    expect(indexHits("superseded")).toBe(0);
    expect(indexHits("current")).toBe(1);
  });
});

// ── A query cannot buy unbounded work (audit 2026-09-10) ─────────────────────
//
// FTS5 evaluates every clause of a MATCH expression, and terms are OR-ed — so before
// `queryTerms` deduplicated them, one word repeated 20,000 times built a 20,000-clause
// expression and this store took **32.7 seconds** to answer a query whose meaning was one
// word. A 128 KB text box was a denial of service.
//
// The bound below is 5s against a fixed path that answers in about a millisecond: three
// orders of magnitude of headroom for a loaded CI box, and still far under the failure it
// discriminates. Timing is the only observable here, because deduplication cannot change
// which rows come back — that is exactly why it was safe to do and invisible to a
// semantic test.
describe("SqliteMemoryStore query bounds", () => {
  let dir: string;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-memory-bounds-"));
    store = new SqliteMemoryStore(join(dir, "memory.db"));
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a 20,000-repeat query as fast as the single term it means", async () => {
    for (let i = 0; i < 200; i++) {
      await store.append("k", { content: { text: `entry ${i} about latency` }, timestamp: i });
    }
    const repeated = Array.from({ length: 20_000 }, () => "latency").join(" ");

    const started = performance.now();
    const hits = await store.search("k", repeated, { limit: 5 });
    const elapsed = performance.now() - started;

    expect(hits).toHaveLength(5);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("does not match on a term past the cap", async () => {
    await store.append("k", { content: { text: "term0 only" }, timestamp: 1 });
    await store.append("k", { content: { text: "term500 only" }, timestamp: 2 });
    const query = Array.from({ length: 600 }, (_, i) => `term${i}`).join(" ");

    const hits = await store.search("k", query, { limit: 10 });

    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits[0]?.content)).toContain("term0");
  });
});
