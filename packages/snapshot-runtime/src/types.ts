import type { ExecutionState } from "@loom/core";

export interface Snapshot {
  id: string;
  executionId: string;
  workflowId: string;
  sequence: number;
  state: ExecutionState;
  createdAt: number;
}

export interface SnapshotStore {
  save(snapshot: Snapshot): void;
  loadLatest(executionId: string): Snapshot | null;
  loadAt(executionId: string, sequence: number): Snapshot | null;
  /**
   * The greatest snapshot at or below `sequence` (i.e. latest snapshot no newer
   * than the given point). Used by fork() to materialize state at an arbitrary
   * fork point without folding the event log from zero. Returns null if no
   * snapshot at or before `sequence` exists.
   */
  loadLatestBefore(executionId: string, sequence: number): Snapshot | null;
  close(): void;
}
