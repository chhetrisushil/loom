import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "@loom/memory";
import { clampSearchLimit, queryTerms, searchableText } from "@loom/memory";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

interface EntryRow {
  entry: MemoryEntry; // JSONB → parsed value
}

/**
 * Postgres-backed {@link MemoryStore} — durable agent memory for a multi-node
 * deployment, in the same database as the event log (one backup = events + memory).
 *
 * A key names an ORDERED LIST, and the order is APPEND order: entries routinely share
 * a timestamp (one turn written in one tick), so `BIGSERIAL seq` — not `timestamp` —
 * is what reads are ordered by.
 *
 * `replace` runs on a dedicated client in one transaction, which is the reason it is on
 * the SPI at all: MemoryRuntime rewrites a list on every TTL/maxEntries eviction, and the
 * clear-then-re-append fallback would make routine eviction able to lose a whole scope.
 * The insert is a single statement whatever the list length (`unnest … WITH ORDINALITY`,
 * ordered explicitly so the serial values follow list order rather than trusting the
 * planner to emit rows in array order).
 *
 * `remove` is one indexed `DELETE` over `entry->>'id'` (ADR 0091) — the id is read from
 * the stored JSON rather than duplicated into a column, so nothing can drift between what
 * `read` returns and what a delete matches.
 *
 * `search` ranks with `ts_rank` over a GIN-indexed `to_tsvector('simple', text)`, where the
 * text is `searchableText(entry)` — the same projection the other backends index, so a query
 * means the same thing whichever one an app is wired to.
 *
 * Concurrent appends to ONE key from two nodes interleave by assigned `seq`, which need
 * not match commit order. That is benign for a memory list (both entries are present, and
 * neither node's own appends can reorder relative to each other) and is the same latitude
 * every multi-writer log has.
 */
export class PostgresMemoryStore implements MemoryStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async append(key: string, entry: MemoryEntry): Promise<void> {
    await this.ready;
    // Explicit stringify + ::jsonb: the pg driver mis-serializes top-level JS arrays as
    // Postgres arrays, and an entry's `content` is frequently one.
    await this.pool.query(
      "INSERT INTO memory_entries (key, entry, text) VALUES ($1, $2::jsonb, $3)",
      [key, JSON.stringify(entry), searchableText(entry)]
    );
  }

  async read(key: string): Promise<MemoryEntry[]> {
    await this.ready;
    const { rows } = await this.pool.query<EntryRow>(
      "SELECT entry FROM memory_entries WHERE key = $1 ORDER BY seq ASC",
      [key]
    );
    return rows.map((row) => row.entry);
  }

  async clear(key: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM memory_entries WHERE key = $1", [key]);
  }

  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM memory_entries WHERE key = $1", [key]);
      if (entries.length > 0) {
        await client.query(
          `INSERT INTO memory_entries (key, entry, text)
             SELECT $1, e, x FROM unnest($2::jsonb[], $3::text[]) WITH ORDINALITY AS t(e, x, ord)
             ORDER BY t.ord`,
          [
            key,
            entries.map((entry) => JSON.stringify(entry)),
            entries.map((entry) => searchableText(entry)),
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      // Best-effort rollback; the original error is what the caller needs to see.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete by entry id in ONE statement — `= ANY($2::text[])` rather than a generated
   * `IN (...)` list, so the plan is cached whatever the number of ids and a document with
   * 200 chunks is not a 200-placeholder statement nobody has seen before.
   *
   * `entry->>'id'` reads the id back out of the stored JSON, which is where it already
   * lives; there is no `id` column to keep in step with it. An entry with no id yields
   * SQL NULL, and `NULL = ANY(...)` is never true, so an anonymous entry cannot be
   * removed by any list of ids — including one containing the strings "null" or
   * "undefined", which is how that bug usually arrives.
   */
  async remove(key: string, ids: readonly string[]): Promise<void> {
    await this.ready;
    if (ids.length === 0) return;
    await this.pool.query(
      "DELETE FROM memory_entries WHERE key = $1 AND entry->>'id' = ANY($2::text[])",
      [key, [...ids]]
    );
  }

  async search(key: string, query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    await this.ready;
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    // OR-ed terms, and safe to interpolate into a tsquery because `queryTerms` yields only
    // alphanumerics — `plainto_tsquery` would AND them instead, so a longer question would
    // return fewer memories, which is backwards.
    const tsquery = terms.join(" | ");
    const { rows } = await this.pool.query<EntryRow>(
      `SELECT entry FROM memory_entries
        WHERE key = $1 AND to_tsvector('simple', text) @@ to_tsquery('simple', $2)
        ORDER BY ts_rank(to_tsvector('simple', text), to_tsquery('simple', $2)) DESC, seq DESC
        LIMIT $3`,
      [key, tsquery, clampSearchLimit(opts.limit)]
    );
    return rows.map((row) => row.entry);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
