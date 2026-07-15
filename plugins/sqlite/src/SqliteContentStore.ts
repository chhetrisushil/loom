import { createHash } from "node:crypto";
import type { ContentRef, ContentStore } from "@loom/plugin-content";
import Database from "better-sqlite3";

/**
 * SQLite-backed {@link ContentStore} (the first durable content backend —
 * ADR 0046 deferred one "until a real requirement lands"; the db-copilot's
 * evidence retention is that requirement, and `loom sweep content` needs a
 * file-backed store to operate on). Content-addressed (`sha256:<hex>`),
 * idempotent by hash, `putStream` per the ADR 0059 outcome contract
 * (hash-while-spooling). Point it at its own file — blob I/O must not contend
 * with event-append latency (TS-7 discipline).
 */
export class SqliteContentStore implements ContentStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS content_blobs (
          address TEXT PRIMARY KEY,
          bytes BLOB NOT NULL
        );
      `);
      this.insertStmt = this.db.prepare(
        "INSERT OR IGNORE INTO content_blobs (address, bytes) VALUES (?, ?)"
      );
      this.getStmt = this.db.prepare("SELECT bytes FROM content_blobs WHERE address = ?");
      this.deleteStmt = this.db.prepare("DELETE FROM content_blobs WHERE address = ?");
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.insertStmt.run(address, Buffer.from(bytes));
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
    this.insertStmt.run(address, Buffer.concat(chunks, size));
    return { __loomContent: address, size };
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const row = this.getStmt.get(ref.__loomContent) as { bytes: Buffer } | undefined;
    return row === undefined ? null : new Uint8Array(row.bytes);
  }

  async delete(ref: ContentRef): Promise<void> {
    this.deleteStmt.run(ref.__loomContent);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
