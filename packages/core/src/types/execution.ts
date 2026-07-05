export type ExecutionStatus =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";

export type FrameStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export interface ExecutionFrame {
  stepId: string;
  status: FrameStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
}

export interface SuspendCondition {
  on: string;
  timeout?: number;
  correlationKey?: string;
}

export interface ExecutionState {
  executionId: string;
  workflowId: string;
  workflowVersion: string;
  status: ExecutionStatus;
  frames: Record<string, ExecutionFrame>;
  variables: Record<string, unknown>;
  sequence: number;
  suspendedOn?: SuspendCondition;
  startedAt: number;
  updatedAt: number;
}
