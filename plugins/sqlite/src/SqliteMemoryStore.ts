import type { MemoryEntry, MemoryStore } from "@loom/memory";
import Database from "better-sqlite3";

interface EntryRow {
  entry: string;
}

/**
 * SQLite-backed {@link MemoryStore} — the zero-server durable agent memory. Point it
 * at the same DB file as the SqliteEventStore so one backup captures events + memory.
 * Own idempotent migration, same pattern as SqliteTimerStore/SqliteDurableStateStore.
 *
 * A key names an ordered list, so the table needs an insertion key of its own: entries
 * routinely share a timestamp and `ORDER BY timestamp` would reshuffle a conversation.
 * `AUTOINCREMENT` (not bare rowid) makes the monotonicity a schema-level guarantee
 * rather than an argument about rowid reuse after a `clear`.
 *
 * `replace` is one transaction, which is the whole reason it is on the SPI: MemoryRuntime
 * rewrites a list on every TTL/maxEntries eviction, and a crash between the delete and the
 * re-insert would make routine eviction the thing that loses the scope.
 */
export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database.Database;
  private readonly appendStmt: Database.Statement;
  private readonly readStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;
  private readonly replaceTxn: (key: string, entries: readonly MemoryEntry[]) => void;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          entry TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_entries_key
          ON memory_entries (key, seq ASC);
      `);
      this.appendStmt = this.db.prepare("INSERT INTO memory_entries (key, entry) VALUES (?, ?)");
      this.readStmt = this.db.prepare(
        "SELECT entry FROM memory_entries WHERE key = ? ORDER BY seq ASC"
      );
      this.clearStmt = this.db.prepare("DELETE FROM memory_entries WHERE key = ?");
      this.replaceTxn = this.db.transaction((key: string, entries: readonly MemoryEntry[]) => {
        this.clearStmt.run(key);
        for (const entry of entries) this.appendStmt.run(key, JSON.stringify(entry));
      });
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async append(key: string, entry: MemoryEntry): Promise<void> {
    this.appendStmt.run(key, JSON.stringify(entry));
  }

  async read(key: string): Promise<MemoryEntry[]> {
    const rows = this.readStmt.all(key) as EntryRow[];
    return rows.map((row) => JSON.parse(row.entry) as MemoryEntry);
  }

  async clear(key: string): Promise<void> {
    this.clearStmt.run(key);
  }

  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    this.replaceTxn(key, entries);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
