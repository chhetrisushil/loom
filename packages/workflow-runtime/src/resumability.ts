import type { ExecutionState } from "@loom/core";

export interface ProjectionSnapshot {
  executionId: string;
  states: Record<string, unknown>;
}

export function serializeExecution(state: ExecutionState): string {
  return JSON.stringify(state);
}

export function deserializeExecution(serialized: string): ExecutionState {
  const parsed = JSON.parse(serialized) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)["executionId"] !== "string"
  ) {
    throw new Error("Invalid serialized ExecutionState");
  }
  return parsed as ExecutionState;
}

export function serializeProjections(
  states: Record<string, unknown>,
  executionId: string
): string {
  const snapshot: ProjectionSnapshot = { executionId, states };
  return JSON.stringify(snapshot);
}

export function deserializeProjections(serialized: string): ProjectionSnapshot {
  return JSON.parse(serialized) as ProjectionSnapshot;
}
