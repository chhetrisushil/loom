import type { ExecutionState } from "@loom/core";

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
  close(): Promise<void>;
}
