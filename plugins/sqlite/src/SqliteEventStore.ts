import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { SubscriberRegistry } from "@loom/event-runtime";
import Database from "better-sqlite3";
import { migrate } from "./schema";

interface EventRow {
  id: string;
  workflow_id: string;
  execution_id: string;
  event_type: string;
  sequence: number;
  timestamp: number;
  payload: string;
  metadata: string | null;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    eventType: row.event_type,
    sequence: row.sequence,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as unknown,
    ...(row.metadata !== null && { metadata: JSON.parse(row.metadata) as Record<string, unknown> }),
  };
}

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private pageFirstStmt: Database.Statement | undefined;
  private pageAfterStmt: Database.Statement | undefined;
  private readonly subscribers = new SubscriberRegistry();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      migrate(this.db);
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const stmt = this.db.prepare<
      [string, string, string, string, number, number, string, string | null]
    >(`
      INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      envelope.id,
      envelope.workflowId,
      envelope.executionId,
      envelope.eventType,
      envelope.sequence,
      envelope.timestamp,
      JSON.stringify(envelope.payload),
      envelope.metadata !== undefined ? JSON.stringify(envelope.metadata) : null
    );

    this.notify(envelope.executionId, envelope);
  }

  /**
   * ADR 0074 D1 — bulk append in ONE transaction. better-sqlite3's `transaction()` wrapper
   * is synchronous and rolls back on throw, which gives the required atomicity directly:
   * a UNIQUE(execution_id, sequence) violation part-way aborts the whole statement group,
   * so no execution is left with a hole.
   *
   * Subscribers fire only after the transaction commits — a subscriber must never observe
   * a batch that could still roll back.
   */
  async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    const stmt = this.db.prepare<
      [string, string, string, string, number, number, string, string | null]
    >(`
      INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = this.db.transaction((batch: readonly EventEnvelope[]) => {
      for (const envelope of batch) {
        stmt.run(
          envelope.id,
          envelope.workflowId,
          envelope.executionId,
          envelope.eventType,
          envelope.sequence,
          envelope.timestamp,
          JSON.stringify(envelope.payload),
          envelope.metadata !== undefined ? JSON.stringify(envelope.metadata) : null
        );
      }
    });
    insertAll(envelopes);
    for (const envelope of envelopes) this.notify(envelope.executionId, envelope);
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    const rows = this.db
      .prepare<[string], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? ORDER BY sequence ASC"
      )
      .all(executionId);
    return rows.map(rowToEnvelope);
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    const rows = this.db
      .prepare<[string, number], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? AND sequence >= ? ORDER BY sequence ASC"
      )
      .all(executionId, fromSequence);
    return rows.map(rowToEnvelope);
  }

  async readRange(
    executionId: string,
    fromSequence: number,
    toSequence: number
  ): Promise<EventEnvelope[]> {
    if (toSequence < fromSequence) return [];
    const rows = this.db
      .prepare<[string, number, number], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence ASC"
      )
      .all(executionId, fromSequence, toSequence);
    return rows.map(rowToEnvelope);
  }

  async copyPrefix(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void> {
    // Copy the prefix entirely inside SQLite — payload stays as stored TEXT (no
    // JS parse/stringify), id/execution_id are re-stamped, and provenance metadata
    // is merged via json_patch (JSON1). O(P) rows, zero JS serialization.
    this.db
      .prepare<[string, string, string, string, number]>(
        `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
         SELECT ? || '-' || sequence, workflow_id, ?, event_type, sequence, timestamp, payload,
                json_patch(COALESCE(metadata, '{}'), json(?))
         FROM events WHERE execution_id = ? AND sequence <= ?`
      )
      .run(
        toExecutionId,
        toExecutionId,
        JSON.stringify(metadata),
        fromExecutionId,
        throughSequence
      );
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    return this.subscribers.add(executionId, handler);
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.db.prepare<[string]>("DELETE FROM events WHERE execution_id = ?").run(executionId);
  }

  async truncatePrefix(executionId: string, throughSequence: number): Promise<void> {
    // Preserve sequence 0 (bootstrap anchor); drop (0..throughSequence].
    this.db
      .prepare<[string, number]>(
        "DELETE FROM events WHERE execution_id = ? AND sequence > 0 AND sequence <= ?"
      )
      .run(executionId, throughSequence);
  }

  async listExecutions(): Promise<string[]> {
    // The (execution_id, sequence) index makes DISTINCT a cheap index-only scan.
    const rows = this.db
      .prepare<[], { execution_id: string }>("SELECT DISTINCT execution_id FROM events")
      .all();
    return rows.map((r) => r.execution_id);
  }

  async listExecutionsPage(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }> {
    // SP-1 (SPI 1.2.0) — keyset over the same index: lexicographic, bounded memory.
    // Statements prepared lazily once (audit: no per-page re-parse on big scans).
    const limit = opts?.limit ?? 1000;
    this.pageFirstStmt ??= this.db.prepare(
      "SELECT DISTINCT execution_id FROM events ORDER BY execution_id LIMIT ?"
    );
    this.pageAfterStmt ??= this.db.prepare(
      "SELECT DISTINCT execution_id FROM events WHERE execution_id > ? ORDER BY execution_id LIMIT ?"
    );
    const rows =
      opts?.cursor === undefined
        ? (this.pageFirstStmt.all(limit + 1) as { execution_id: string }[])
        : (this.pageAfterStmt.all(opts.cursor, limit + 1) as { execution_id: string }[]);
    const executionIds = rows.slice(0, limit).map((r) => r.execution_id);
    const last = executionIds[executionIds.length - 1];
    return {
      executionIds,
      ...(rows.length > limit && last !== undefined && { nextCursor: last }),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private notify(_executionId: string, event: EventEnvelope): void {
    this.subscribers.emit(event);
  }
}
