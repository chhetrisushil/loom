import type { ExecutionState } from "@loom/core";

/**
 * SPI version for the {@link SnapshotStore} contract (ADR 0033). Pinned by
 * `runSnapshotStoreConformance` in `@loom/testing`.
 */
export const SNAPSHOT_STORE_SPI_VERSION = "1.0.0";

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
