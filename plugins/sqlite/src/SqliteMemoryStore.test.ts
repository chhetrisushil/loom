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

  it("removes replaced entries from the index", async () => {
    // The path eviction takes on every TTL/maxEntries rewrite, so a leak here grows with
    // the age of the memory rather than with the size of it.
    await store.append("k", { content: "superseded fact", timestamp: 1 });
    await store.replace("k", [{ content: "current fact", timestamp: 2 }]);
    expect(indexHits("superseded")).toBe(0);
    expect(indexHits("current")).toBe(1);
  });
});
