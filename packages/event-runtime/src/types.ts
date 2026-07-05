import type { EventEnvelope } from "@loom/core";

export type { EventEnvelope };

/**
 * Durable, append-only event log. Async-first so any backend plugs in —
 * synchronous stores (SQLite, in-memory) satisfy this trivially by marking
 * methods `async`; async/network stores (Postgres, Redis, DynamoDB) return
 * real Promises.
 *
 * Note there is no `nextSequence` — sequence allocation is owned by the
 * per-execution in-memory sequencer in `@loom/workflow-runtime` (ExecutionJournal),
 * so a backend never needs a read-then-write round-trip to append.
 */
export interface EventStore {
  append(envelope: EventEnvelope): Promise<void>;
  read(executionId: string): Promise<EventEnvelope[]>;
  readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]>;
  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void>;
  close(): Promise<void>;
}

export interface EventStoreOptions {
  dbPath: string;
}
