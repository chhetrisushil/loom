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
  close(): void;
}
