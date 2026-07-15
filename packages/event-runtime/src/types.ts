import type { EventEnvelope } from "@loom/core";

export type { EventEnvelope };

/**
 * SPI version for the {@link EventStore} contract (ADR 0033). Bump MINOR when adding an
 * optional method, MAJOR when changing a required method's contract. Pinned by
 * `runEventStoreConformance` in `@loom/testing`.
 *
 * 1.1.0: added optional `listExecutions()` (enumerate distinct executionIds — powers
 *   `loom retention run` / `loom compliance report` over cold storage).
 * 1.2.0: added optional `listExecutionsPage()` (SP-1, db-copilot infra #184 — keyset-paged
 *   enumeration so maintenance passes run in bounded memory at year scale). Consumers use
 *   {@link iterateExecutionIds}, which prefers pages and falls back to `listExecutions()`.
 */
export const EVENT_STORE_SPI_VERSION = "1.2.0";

/**
 * Reserved-stream prefix. Control facts (retention `__loom_lifecycle__`, erasure
 * `__loom_erasure__`) are stored under executionIds beginning with this, so
 * {@link listExecutions} surfaces them too. Enumerators over *real* executions filter with
 * {@link isReservedStream}.
 */
export const RESERVED_STREAM_PREFIX = "__loom_";

/** Whether an executionId names a reserved control stream rather than a real execution. */
export function isReservedStream(executionId: string): boolean {
  return executionId.startsWith(RESERVED_STREAM_PREFIX);
}

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
   * OPTIONAL fencing (K9.4). Atomically increment and return the execution's
   * monotonic fencing token (first call → 1). A dispatcher/worker acquires a
   * fence per dispatch; every envelope the run appends carries it in
   * `metadata.fence`. Once an execution has a fence, a store that implements
   * fencing MUST reject appends whose token is missing or lower than the
   * current one (throw {@link StaleFenceError}) — a re-dispatched execution's
   * zombie predecessor can no longer write. Executions that never acquire a
   * fence are entirely unaffected (zero overhead, G2); a store that omits this
   * method performs no fencing (e.g. single-node SQLite, where the process is
   * the failure domain).
   */
  acquireFence?(executionId: string): Promise<number>;
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
  /**
   * OPTIONAL (K10.1 retention). Delete ALL events for an execution. Used by the
   * retention sweep after a terminal execution's retention window elapses
   * (archive-before-delete is the sweep's responsibility, not the store's). A
   * store that omits it cannot be swept — retention is opt-in per backend.
   */
  deleteExecution?(executionId: string): Promise<void>;
  /**
   * OPTIONAL (K10.4 compaction). Delete the prefix `(0..throughSequence]` of an
   * execution's log — **sequence 0 (the EXECUTION_STARTED bootstrap) is always
   * preserved** as the execution's metadata anchor (resume reads input/workflowId
   * from it). The caller MUST ensure a snapshot at a sequence
   * `>= throughSequence` exists first, so the invariant
   * `fold(snapshot, suffix) === fold(events)` holds — the store only truncates.
   */
  truncatePrefix?(executionId: string, throughSequence: number): Promise<void>;
  /**
   * OPTIONAL enumeration of every distinct executionId in the store (unordered). Powers
   * operator sweeps that must visit all executions — `loom retention run`,
   * `loom compliance report`. Includes reserved control streams (`__loom_*`); callers that
   * want only real executions filter with {@link isReservedStream}. A store that omits this
   * cannot be swept over cold storage (there is no cheap fallback — enumeration requires a
   * scan the store alone can do efficiently, e.g. `SELECT DISTINCT execution_id`).
   */
  listExecutions?(): Promise<string[]>;
  /**
   * OPTIONAL keyset-paged enumeration (SP-1, SPI 1.2.0): distinct executionIds in
   * LEXICOGRAPHIC order, `limit` per page, resumed via the opaque `cursor` from the prior
   * page. Bounded-memory alternative to {@link listExecutions} for maintenance passes
   * (retention, the K10.6 sweep, read-model catch-up) over year-scale stores. Executions
   * created DURING iteration whose ids sort before the cursor may be missed — acceptable
   * for periodic maintenance jobs (they are visited on the next pass); do not use this for
   * exactly-once semantics. Same reserved-stream note as `listExecutions`.
   */
  listExecutionsPage?(opts?: { cursor?: string; limit?: number }): Promise<ExecutionPage>;
  close(): Promise<void>;
}

/** One page of {@link EventStore.listExecutionsPage}. `nextCursor` present iff more remain. */
export interface ExecutionPage {
  executionIds: string[];
  nextCursor?: string;
}

/** The enumeration surface of a store — what maintenance passes actually need. */
export interface ExecutionEnumerable {
  listExecutions?(): Promise<string[]>;
  listExecutionsPage?(opts?: { cursor?: string; limit?: number }): Promise<ExecutionPage>;
}

/**
 * SP-2 — the one enumeration loop every maintenance pass shares: prefers the
 * bounded-memory paged surface, falls back to `listExecutions()`, and REFUSES a
 * store with neither (silent partial passes are how retention deletes evidence
 * and read models under-index).
 */
export async function* iterateExecutionIds(
  source: ExecutionEnumerable,
  pageSize = 1000
): AsyncGenerator<string, void, void> {
  if (source.listExecutionsPage !== undefined) {
    let cursor: string | undefined;
    for (;;) {
      const page = await source.listExecutionsPage({
        ...(cursor !== undefined && { cursor }),
        limit: pageSize,
      });
      for (const id of page.executionIds) yield id;
      if (page.nextCursor === undefined) return;
      cursor = page.nextCursor;
    }
  }
  if (source.listExecutions !== undefined) {
    for (const id of await source.listExecutions()) yield id;
    return;
  }
  throw new TypeError(
    "iterateExecutionIds: the store supports neither listExecutionsPage() nor listExecutions() — it cannot be enumerated"
  );
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
