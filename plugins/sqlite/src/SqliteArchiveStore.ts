import {
  type ArchiveExecutionPage,
  type ArchiveSegment,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  assertReplaceable,
  classifyAppend,
} from "@loom/event-runtime";
import Database from "better-sqlite3";

// ADR 0138 — the SQLite compaction archive. One row per segment, keyed (execution_id, from_seq).
// The envelopes (and a sealing wrapper's `sealed` form) are stored as one JSON text; the header
// fields are columns so `headers()` reads no bodies.

interface Row {
  from_seq: number;
  through_seq: number;
  count: number;
  digest: string;
  incarnation: string;
  kind: string | null;
  sender_digest: string | null;
  body: string;
}

const kindOf = (k: string | null): Pick<ArchiveSegmentHeader, "kind"> =>
  k === "legacy-checkpoint" ? { kind: "legacy-checkpoint" } : {};

const senderOf = (d: string | null): Pick<ArchiveSegmentHeader, "senderDigest"> =>
  d === null ? {} : { senderDigest: d };

const toSegment = (r: Row): ArchiveSegment => {
  const body = JSON.parse(r.body) as { envelopes: ArchiveSegment["envelopes"]; sealed?: unknown };
  return {
    from: r.from_seq,
    through: r.through_seq,
    count: r.count,
    digest: r.digest,
    incarnation: r.incarnation,
    ...kindOf(r.kind),
    ...senderOf(r.sender_digest),
    envelopes: body.envelopes,
    ...(body.sealed !== undefined && { sealed: body.sealed }),
  };
};

export class SqliteArchiveStore implements ArchiveStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS archive_segments (
          execution_id TEXT NOT NULL,
          from_seq INTEGER NOT NULL,
          through_seq INTEGER NOT NULL,
          count INTEGER NOT NULL,
          digest TEXT NOT NULL,
          incarnation TEXT NOT NULL,
          kind TEXT,
          sender_digest TEXT,
          body TEXT NOT NULL,
          PRIMARY KEY (execution_id, from_seq)
        );
      `);
      // ADR 0139 N7: a table an earlier build created gains the column (CREATE IF NOT EXISTS never does).
      const cols = this.db.prepare("PRAGMA table_info(archive_segments)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "sender_digest")) {
        this.db.exec("ALTER TABLE archive_segments ADD COLUMN sender_digest TEXT");
      }
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  async append(executionId: string, segment: ArchiveSegment): Promise<void> {
    // One transaction: the classify read and the insert see the same rows.
    const tx = this.db.transaction(() => {
      const stored = this.headersSync(executionId);
      if (classifyAppend(executionId, stored, segment) === "noop") return;
      this.insert(executionId, segment);
    });
    tx.immediate();
  }

  private insert(executionId: string, segment: ArchiveSegment): void {
    this.db
      .prepare(
        "INSERT INTO archive_segments (execution_id, from_seq, through_seq, count, digest, incarnation, kind, sender_digest, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        executionId,
        segment.from,
        segment.through,
        segment.count,
        segment.digest,
        segment.incarnation,
        segment.kind ?? null,
        segment.senderDigest ?? null,
        JSON.stringify({
          envelopes: segment.envelopes,
          ...(segment.sealed !== undefined && { sealed: segment.sealed }),
        })
      );
  }

  /** ADR 0139 N1: one transaction - compare the headers, delete the key's segments, insert the new ones. */
  async replaceSegments(
    executionId: string,
    expected: readonly ArchiveSegmentHeader[],
    next: readonly ArchiveSegment[]
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      assertReplaceable(executionId, this.headersSync(executionId), expected, next);
      this.db.prepare("DELETE FROM archive_segments WHERE execution_id = ?").run(executionId);
      for (const seg of next) this.insert(executionId, seg);
    });
    tx.immediate();
  }

  private headersSync(executionId: string): ArchiveSegmentHeader[] {
    return this.db
      .prepare<[string], Omit<Row, "body">>(
        "SELECT from_seq, through_seq, count, digest, incarnation, kind, sender_digest FROM archive_segments WHERE execution_id = ? ORDER BY from_seq"
      )
      .all(executionId)
      .map((r) => ({
        from: r.from_seq,
        through: r.through_seq,
        count: r.count,
        digest: r.digest,
        incarnation: r.incarnation,
        ...kindOf(r.kind),
        ...senderOf(r.sender_digest),
      }));
  }

  async headers(executionId: string): Promise<ArchiveSegmentHeader[]> {
    return this.headersSync(executionId);
  }

  async listExecutions(
    opts: { cursor?: string; limit?: number } = {}
  ): Promise<ArchiveExecutionPage> {
    const limit = opts.limit ?? 500;
    // BINARY collation = code point order for well-formed ids (the SPI's order).
    const ids = this.db
      .prepare<[string, number], { execution_id: string }>(
        "SELECT DISTINCT execution_id FROM archive_segments WHERE execution_id > ? ORDER BY execution_id LIMIT ?"
      )
      .all(opts.cursor ?? "", limit + 1)
      .map((r) => r.execution_id);
    // An empty-string id sorts first and `> ''` would skip it; it names no execution, so that is moot.
    const page = ids.slice(0, limit);
    return ids.length > limit
      ? { executionIds: page, nextCursor: page[page.length - 1]! }
      : { executionIds: page };
  }

  async read(
    executionId: string,
    range: { readonly from?: number; readonly through?: number } = {}
  ): Promise<ArchiveSegment[]> {
    return this.db
      .prepare<[string, number, number], Row>(
        "SELECT * FROM archive_segments WHERE execution_id = ? AND through_seq >= ? AND from_seq <= ? ORDER BY from_seq"
      )
      .all(
        executionId,
        range.from ?? Number.MIN_SAFE_INTEGER,
        range.through ?? Number.MAX_SAFE_INTEGER
      )
      .map(toSegment);
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.db.prepare("DELETE FROM archive_segments WHERE execution_id = ?").run(executionId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
