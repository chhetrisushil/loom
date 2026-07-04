import Database from "better-sqlite3";
import type { EventEnvelope } from "@loom/core";
import { migrate } from "./schema";
import type { EventStore } from "./types";

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
  private readonly subscribers = new Map<string, Set<(event: EventEnvelope) => void>>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    migrate(this.db);
  }

  append(envelope: EventEnvelope): void {
    const stmt = this.db.prepare<[string, string, string, string, number, number, string, string | null]>(`
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

  read(executionId: string): EventEnvelope[] {
    const rows = this.db
      .prepare<[string], EventRow>("SELECT * FROM events WHERE execution_id = ? ORDER BY sequence ASC")
      .all(executionId);
    return rows.map(rowToEnvelope);
  }

  readFrom(executionId: string, fromSequence: number): EventEnvelope[] {
    const rows = this.db
      .prepare<[string, number], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? AND sequence >= ? ORDER BY sequence ASC"
      )
      .all(executionId, fromSequence);
    return rows.map(rowToEnvelope);
  }

  subscribe(executionId: string, handler: (event: EventEnvelope) => void): () => void {
    if (!this.subscribers.has(executionId)) {
      this.subscribers.set(executionId, new Set());
    }
    const handlers = this.subscribers.get(executionId)!;
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscribers.delete(executionId);
      }
    };
  }

  nextSequence(executionId: string): number {
    const row = this.db
      .prepare<[string], { maxSeq: number | null }>(
        "SELECT MAX(sequence) as maxSeq FROM events WHERE execution_id = ?"
      )
      .get(executionId);
    return (row?.maxSeq ?? -1) + 1;
  }

  close(): void {
    this.db.close();
  }

  private notify(executionId: string, event: EventEnvelope): void {
    const handlers = this.subscribers.get(executionId);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }
}
