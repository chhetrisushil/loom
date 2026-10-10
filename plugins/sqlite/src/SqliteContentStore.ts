import { createHash } from "node:crypto";
import {
  type ContentListPage,
  type ContentListPageOptions,
  type ContentRef,
  type ContentStore,
  contentListPageLimit,
} from "@loom/plugin-content";
import Database from "better-sqlite3";

/** Bind variables per `touch` UPDATE (SQLite builds cap at 999 on old versions). */
const TOUCH_CHUNK = 500;

/**
 * SQLite-backed {@link ContentStore} (the first durable content backend —
 * ADR 0046 deferred one "until a real requirement lands"; the db-copilot's
 * evidence retention is that requirement, and `loom sweep content` needs a
 * file-backed store to operate on). Content-addressed (`sha256:<hex>`),
 * idempotent by hash, `putStream` per the ADR 0059 outcome contract
 * (hash-while-spooling). Point it at its own file — blob I/O must not contend
 * with event-append latency (TS-7 discipline).
 *
 * SPI 1.4.0 adds `touch` (a batched `UPDATE … RETURNING`). SPI 1.3.0 (ADR 0055 D5/D6): every blob carries `touched_at`, bumped by EVERY put (a dedup'd
 * put is a re-citation), so `deleteIfUntouchedSince` is one conditional `DELETE` and
 * `listPage` is a keyset scan on the `address` primary key. A pre-1.3.0 file is migrated on
 * open: the column is added and existing blobs are backfilled to the migration time
 * (conservative — none ages out until a full TTL after the upgrade).
 */
export interface SqliteContentStoreOptions {
  /** Clock for touch times (epoch ms). Default `Date.now`. */
  now?: () => number;
}

export class SqliteContentStore implements ContentStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteIfUntouchedStmt: Database.Statement;
  private readonly pageStmt: Database.Statement;
  private readonly pageBeforeStmt: Database.Statement;

  constructor(dbPath: string, options: SqliteContentStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS content_blobs (
          address TEXT PRIMARY KEY,
          bytes BLOB NOT NULL,
          touched_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.migrateTouchedAt();
      // Monotonic bump: a clock stepping back cannot make a re-cited blob look older.
      this.insertStmt = this.db.prepare(
        `INSERT INTO content_blobs (address, bytes, touched_at) VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET touched_at = max(touched_at, excluded.touched_at)`
      );
      this.getStmt = this.db.prepare("SELECT bytes FROM content_blobs WHERE address = ?");
      this.deleteStmt = this.db.prepare("DELETE FROM content_blobs WHERE address = ?");
      this.deleteIfUntouchedStmt = this.db.prepare(
        "DELETE FROM content_blobs WHERE address = ? AND touched_at < ?"
      );
      this.pageStmt = this.db.prepare(
        `SELECT address, touched_at AS touchedAt FROM content_blobs
         WHERE address > ? ORDER BY address LIMIT ?`
      );
      this.pageBeforeStmt = this.db.prepare(
        `SELECT address, touched_at AS touchedAt FROM content_blobs
         WHERE address > ? AND touched_at < ? ORDER BY address LIMIT ?`
      );
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.insertStmt.run(address, Buffer.from(bytes), this.now());
    return { __loomContent: address, size: bytes.byteLength };
  }

  async putStream(stream: AsyncIterable<Uint8Array>): Promise<ContentRef> {
    // ADR 0059 outcome contract: address of the full sequence, idempotent —
    // hash while spooling, then a single idempotent insert.
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
      size += chunk.byteLength;
    }
    const address = `sha256:${hash.digest("hex")}`;
    this.insertStmt.run(address, Buffer.concat(chunks, size), this.now());
    return { __loomContent: address, size };
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const row = this.getStmt.get(ref.__loomContent) as { bytes: Buffer } | undefined;
    return row === undefined ? null : new Uint8Array(row.bytes);
  }

  async delete(ref: ContentRef): Promise<void> {
    this.deleteStmt.run(ref.__loomContent);
  }

  async deleteIfUntouchedSince(ref: ContentRef, cutoffMs: number): Promise<boolean> {
    return this.deleteIfUntouchedStmt.run(ref.__loomContent, cutoffMs).changes > 0;
  }

  async touchClock(): Promise<number> {
    return this.now();
  }

  /**
   * SPI 1.4.0: bump `touched_at` for existing blobs without a put. One `UPDATE … WHERE address
   * IN (…) RETURNING address` per chunk (bounded bind-variable count), all inside one
   * transaction so a batch is all-or-nothing. `max()` keeps the time monotonic; an unknown
   * address matches no row (no insert), and is reported back as missing.
   */
  async touch(addresses: readonly string[]): Promise<string[]> {
    const unique = [...new Set(addresses)];
    if (unique.length === 0) return [];
    const touchedAt = this.now();
    const present = new Set<string>();
    this.db.transaction(() => {
      for (let i = 0; i < unique.length; i += TOUCH_CHUNK) {
        const chunk = unique.slice(i, i + TOUCH_CHUNK);
        const rows = this.db
          .prepare(
            `UPDATE content_blobs SET touched_at = max(touched_at, ?)
             WHERE address IN (${chunk.map(() => "?").join(",")}) RETURNING address`
          )
          .all(touchedAt, ...chunk) as { address: string }[];
        for (const row of rows) present.add(row.address);
      }
    })();
    return unique.filter((a) => !present.has(a));
  }

  async listPage(opts: ContentListPageOptions = {}): Promise<ContentListPage> {
    const limit = contentListPageLimit(opts.limit);
    const after = opts.cursor ?? "";
    const entries = (
      opts.touchedBefore === undefined
        ? this.pageStmt.all(after, limit)
        : this.pageBeforeStmt.all(after, opts.touchedBefore, limit)
    ) as { address: string; touchedAt: number }[];
    const last = entries[entries.length - 1];
    return entries.length === limit && last !== undefined
      ? { entries, nextCursor: last.address }
      : { entries };
  }

  /**
   * One-time upgrade of a pre-1.3.0 file. IMMEDIATE so two processes opening the same file
   * cannot both add the column; the re-check inside the transaction makes it idempotent.
   */
  private migrateTouchedAt(): void {
    const hasColumn = (): boolean =>
      (this.db.prepare("PRAGMA table_info(content_blobs)").all() as { name: string }[]).some(
        (c) => c.name === "touched_at"
      );
    if (hasColumn()) return;
    this.db
      .transaction(() => {
        if (hasColumn()) return;
        this.db.exec("ALTER TABLE content_blobs ADD COLUMN touched_at INTEGER NOT NULL DEFAULT 0");
        this.db.prepare("UPDATE content_blobs SET touched_at = ?").run(this.now());
      })
      .immediate();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
