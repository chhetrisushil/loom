import type { MemoryEntry, MemoryStore } from "@loom/memory";
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
    await this.pool.query("INSERT INTO memory_entries (key, entry) VALUES ($1, $2::jsonb)", [
      key,
      JSON.stringify(entry),
    ]);
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
          `INSERT INTO memory_entries (key, entry)
             SELECT $1, e FROM unnest($2::jsonb[]) WITH ORDINALITY AS t(e, ord)
             ORDER BY t.ord`,
          [key, entries.map((entry) => JSON.stringify(entry))]
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

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
