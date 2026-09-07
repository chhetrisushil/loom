import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "@loom/memory";
import { clampSearchLimit, searchableText, tokenize } from "@loom/memory";
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
 *
 * `search` rides an FTS5 index over `searchableText(entry)`, held in an EXTERNAL-CONTENT
 * table so the text is indexed but not stored twice, and synchronised by triggers so a
 * `clear`/`replace` cannot leave the index describing entries that no longer exist. FTS5's
 * `rank` is a BM25 score where LOWER is better, hence `ORDER BY rank` ascending.
 */
export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database.Database;
  private readonly appendStmt: Database.Statement;
  private readonly readStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;
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
          entry TEXT NOT NULL,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_entries_key
          ON memory_entries (key, seq ASC);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          text, content='memory_entries', content_rowid='seq'
        );
        -- External content: the index holds no copy of the row, so it must be told about
        -- every insert and delete. Entries are never updated, so there is no update trigger.
        CREATE TRIGGER IF NOT EXISTS memory_entries_ai AFTER INSERT ON memory_entries BEGIN
          INSERT INTO memory_fts(rowid, text) VALUES (new.seq, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_entries_ad AFTER DELETE ON memory_entries BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.seq, old.text);
        END;
      `);
      this.appendStmt = this.db.prepare(
        "INSERT INTO memory_entries (key, entry, text) VALUES (?, ?, ?)"
      );
      this.readStmt = this.db.prepare(
        "SELECT entry FROM memory_entries WHERE key = ? ORDER BY seq ASC"
      );
      this.clearStmt = this.db.prepare("DELETE FROM memory_entries WHERE key = ?");
      this.searchStmt = this.db.prepare(
        `SELECT e.entry FROM memory_fts
           JOIN memory_entries e ON e.seq = memory_fts.rowid
          WHERE memory_fts MATCH ? AND e.key = ?
          ORDER BY memory_fts.rank
          LIMIT ?`
      );
      this.replaceTxn = this.db.transaction((key: string, entries: readonly MemoryEntry[]) => {
        this.clearStmt.run(key);
        for (const entry of entries)
          this.appendStmt.run(key, JSON.stringify(entry), searchableText(entry));
      });
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async append(key: string, entry: MemoryEntry): Promise<void> {
    this.appendStmt.run(key, JSON.stringify(entry), searchableText(entry));
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

  async search(key: string, query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    // Building the MATCH from TERMS, never from the raw question, is what keeps FTS5's
    // expression syntax (`*`, `NEAR`, `AND`, a bare `-`) out of it: a user question passed
    // through is parsed as operators, and either raises a syntax error or quietly means
    // something else. `tokenize` already yields lowercase alphanumerics — which cannot be
    // FTS5 keywords, those being uppercase — and the quoting below is the second belt, so
    // that widening what counts as a term later cannot reopen this.
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = this.searchStmt.all(match, key, clampSearchLimit(opts.limit)) as EntryRow[];
    return rows.map((row) => JSON.parse(row.entry) as MemoryEntry);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
