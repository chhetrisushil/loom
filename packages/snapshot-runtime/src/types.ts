import type { ExecutionState } from "@loom/core";

/**
 * SPI version for the {@link SnapshotStore} contract (ADR 0033). Pinned by
 * `runSnapshotStoreConformance` in `@loom/testing`.
 *
 * 1.1.0: added optional `loadLatestSealed()` (ADR 0106 — the latest snapshot as stored at
 *   rest, readable after a crypto-shred destroyed the subject's key).
 */
export const SNAPSHOT_STORE_SPI_VERSION = "1.1.0";

export interface Snapshot {
  id: string;
  executionId: string;
  workflowId: string;
  sequence: number;
  state: ExecutionState;
  createdAt: number;
}

/**
 * Snapshot storage. Async-first (see {@link EventStore}) — synchronous backends
 * mark methods `async`; async/network backends return real Promises.
 */
export interface SnapshotStore {
  save(snapshot: Snapshot): Promise<void>;
  loadLatest(executionId: string): Promise<Snapshot | null>;
  loadAt(executionId: string, sequence: number): Promise<Snapshot | null>;
  /**
   * The greatest snapshot at or below `sequence` (i.e. latest snapshot no newer
   * than the given point). Used by fork() to materialize state at an arbitrary
   * fork point without folding the event log from zero. Returns null if no
   * snapshot at or before `sequence` exists.
   */
  loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null>;
  /**
   * OPTIONAL (K10.1 retention). Delete ALL snapshots for an execution — the
   * snapshot half of a retention sweep, alongside `EventStore.deleteExecution`.
   */
  deleteExecution?(executionId: string): Promise<void>;
  /**
   * OPTIONAL (SPI 1.1.0, ADR 0106). The latest snapshot AS STORED AT REST: an encrypting
   * store returns its sensitive fields as unopened ciphertext envelopes instead of
   * decrypting them (so it never throws for a destroyed key); a plain store returns exactly
   * `loadLatest`. For callers that need only non-sensitive facts — the sequence, a plain
   * variable like `_shredded` — after a subject's key is gone (`shredSubject`'s retry). It
   * never yields plaintext a decrypting read would refuse. Decorators MUST forward it.
   */
  loadLatestSealed?(executionId: string): Promise<Snapshot | null>;
  close(): Promise<void>;
}

/**
 * The names of the OPTIONAL {@link SnapshotStore} methods, derived from the interface (see
 * `OptionalEventStoreMethod` in `@loom/event-runtime`). Snapshot decorators declare a
 * `DecoratorPlan` over this whole union.
 */
export type OptionalSnapshotStoreMethod = {
  // biome-ignore lint/complexity/noBannedTypes: `{}` is exactly the test — a key whose Pick admits the empty object is optional
  [K in keyof SnapshotStore]-?: {} extends Pick<SnapshotStore, K> ? K : never;
}[keyof SnapshotStore];

/** The runtime list of {@link OptionalSnapshotStoreMethod}, for the decorator conformance kit. */
export const OPTIONAL_SNAPSHOT_STORE_METHODS = [
  "deleteExecution",
  "loadLatestSealed",
] as const satisfies readonly OptionalSnapshotStoreMethod[];

type _MissingOptionalSnapshotMethod = Exclude<
  OptionalSnapshotStoreMethod,
  (typeof OPTIONAL_SNAPSHOT_STORE_METHODS)[number]
>;
// A new optional SnapshotStore method that is not listed above makes this line a compile error.
const _exhaustiveOptionalSnapshotMethods: [_MissingOptionalSnapshotMethod] extends [never]
  ? true
  : never = true;
void _exhaustiveOptionalSnapshotMethods;
