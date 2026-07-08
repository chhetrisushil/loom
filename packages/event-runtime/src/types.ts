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
  /**
   * OPTIONAL bounded read of `[fromSequence..toSequence]` (both inclusive) for one
   * execution, ordered by sequence. Backends push the bound into the query (indexed
   * range) instead of loading the whole log and filtering in JS. A store that omits
   * it falls back to `readFrom` + filter, so callers must tolerate its absence — use
   * {@link readRangeOf}. Empty when `toSequence < fromSequence`.
   */
  readRange?(
    executionId: string,
    fromSequence: number,
    toSequence: number
  ): Promise<EventEnvelope[]>;
  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void>;
  /**
   * OPTIONAL bulk copy of the prefix `[0..throughSequence]` of one execution's log
   * into another `executionId`, re-stamping `id` + `executionId` and merging
   * `metadata` into each copied event — WITHOUT round-tripping payloads through JS
   * (de)serialization. Used by `fork()`; a store that omits it falls back to a
   * per-event `append` loop, so this is purely a performance fast-path.
   */
  copyPrefix?(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void>;
  close(): Promise<void>;
}

export interface EventStoreOptions {
  dbPath: string;
}

/**
 * Read `[fromSequence..toSequence]` from a store that may or may not implement the
 * optional `readRange` fast-path. Uses the native indexed range when available,
 * else falls back to `readFrom` + a bounded slice — so every caller gets the
 * range without having to branch on the capability.
 */
export async function readRangeOf(
  store: EventStore,
  executionId: string,
  fromSequence: number,
  toSequence: number
): Promise<EventEnvelope[]> {
  if (toSequence < fromSequence) return [];
  if (store.readRange) return store.readRange(executionId, fromSequence, toSequence);
  const from = await store.readFrom(executionId, fromSequence);
  return from.filter((e) => e.sequence <= toSequence);
}
