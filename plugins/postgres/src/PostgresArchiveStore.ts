import {
  type ArchiveSegment,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  classifyAppend,
} from "@loom/event-runtime";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

// ADR 0138 — the Postgres compaction archive: one row per segment in `archive_segments`, primary
// key (execution_id, from_seq). `body` is TEXT holding the segment's JSON, so the archived bytes
// are exactly what was written (jsonb would reorder keys and normalise numbers).

interface HeaderRow {
  from_seq: string; // BIGINT -> string
  through_seq: string;
  n_events: string;
  digest: string;
}
interface Row extends HeaderRow {
  body: string;
}

const toHeader = (r: HeaderRow): ArchiveSegmentHeader => ({
  from: Number(r.from_seq),
  through: Number(r.through_seq),
  count: Number(r.n_events),
  digest: r.digest,
});

const toSegment = (r: Row): ArchiveSegment => {
  const body = JSON.parse(r.body) as { envelopes: ArchiveSegment["envelopes"]; sealed?: unknown };
  return {
    ...toHeader(r),
    envelopes: body.envelopes,
    ...(body.sealed !== undefined && { sealed: body.sealed }),
  };
};

/** Postgres-backed {@link ArchiveStore}. Same contract as the SQLite and in-memory stores. */
export class PostgresArchiveStore implements ArchiveStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async append(executionId: string, segment: ArchiveSegment): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize appends to one execution: the contiguity check reads the last segment, and
      // two racing appends must not both pass it. (Compactions of one execution are already
      // exclusive per LogLifecycle; this keeps the store correct on its own.)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 137))", [executionId]);
      const { rows } = await client.query<HeaderRow>(
        "SELECT from_seq, through_seq, n_events, digest FROM archive_segments WHERE execution_id = $1 ORDER BY from_seq",
        [executionId]
      );
      if (classifyAppend(executionId, rows.map(toHeader), segment) === "append") {
        await client.query(
          "INSERT INTO archive_segments (execution_id, from_seq, through_seq, n_events, digest, body) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            executionId,
            segment.from,
            segment.through,
            segment.count,
            segment.digest,
            JSON.stringify({
              envelopes: segment.envelopes,
              ...(segment.sealed !== undefined && { sealed: segment.sealed }),
            }),
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async headers(executionId: string): Promise<ArchiveSegmentHeader[]> {
    await this.ready;
    const { rows } = await this.pool.query<HeaderRow>(
      "SELECT from_seq, through_seq, n_events, digest FROM archive_segments WHERE execution_id = $1 ORDER BY from_seq",
      [executionId]
    );
    return rows.map(toHeader);
  }

  async read(
    executionId: string,
    range: { readonly from?: number; readonly through?: number } = {}
  ): Promise<ArchiveSegment[]> {
    await this.ready;
    const { rows } = await this.pool.query<Row>(
      `SELECT from_seq, through_seq, n_events, digest, body FROM archive_segments
       WHERE execution_id = $1 AND through_seq >= $2 AND from_seq <= $3 ORDER BY from_seq`,
      [executionId, range.from ?? Number.MIN_SAFE_INTEGER, range.through ?? Number.MAX_SAFE_INTEGER]
    );
    return rows.map(toSegment);
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM archive_segments WHERE execution_id = $1", [executionId]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
