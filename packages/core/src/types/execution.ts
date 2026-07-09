import type { RetryPolicy } from "./definitions";

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
  /**
   * K8.3 — the LOGGED timestamp of this step's FIRST attempt (`startedAt`
   * tracks the latest). Deadlines anchor here, so a crash-recovery re-run
   * never resets the clock. Optional/additive: absent on legacy folds;
   * callers fall back to `startedAt`.
   */
  firstStartedAt?: number;
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

// ── Execution (the process-control-block) — Loom 2.0 ─────────────────────────
//
// A minimal, kernel-owned handle to a running execution. Deliberately small
// (P10 — minimal kernel): identity, lifecycle status, per-task frames, the
// durable sequence, lineage, and free-form tags — nothing else. Scheduling,
// reasoning, memory and compute concerns live OUTSIDE this type in
// ExecutionPolicy (referenced by id), so the durable core never depends on those
// modules. Derived purely from ExecutionState via `executionFromState`; it is a
// projection, never persisted.
export interface Execution {
  id: string;
  status: ExecutionStatus;
  frames: Record<string, ExecutionFrame>;
  sequence: number;
  /** Parent execution id when this was forked/spawned from another. */
  parent?: string;
  /** Child execution ids (fan-out / spawned sub-executions). */
  children?: string[];
  /** Free-form labels for routing, filtering and observability. */
  tags?: string[];
}

export interface ExecutionFromStateOpts {
  /** Parent execution id — lives in the BranchRegistry, not the fold. */
  parent?: string;
  /** Child execution ids — lives in the BranchRegistry, not the fold. */
  children?: string[];
  /** Free-form labels to attach to the projected Execution. */
  tags?: string[];
}

// Pure projection from the durable ExecutionState into the minimal PCB. Lineage
// and tags are supplied by the caller (they live beside the fold, in the
// BranchRegistry / ExecutionPolicy), so this stays a pure, I/O-free function.
export function executionFromState(
  state: ExecutionState,
  opts: ExecutionFromStateOpts = {}
): Execution {
  return {
    id: state.executionId,
    status: state.status,
    frames: state.frames,
    sequence: state.sequence,
    ...(opts.parent !== undefined && { parent: opts.parent }),
    ...(opts.children !== undefined && { children: opts.children }),
    ...(opts.tags !== undefined && { tags: opts.tags }),
  };
}

// ── ExecutionPolicy — the opt-in, out-of-core placement/priority descriptor ───
//
// Carried BESIDE an Execution (referenced by id), never embedded in it. Owned by
// the scheduler/compute/reasoning modules and consumed in later milestones; the
// kernel treats it as opaque. Every field optional — omitting it reproduces
// today's behaviour exactly.
export interface ExecutionResources {
  cpu?: number;
  memoryMb?: number;
  gpu?: boolean;
}

export interface ExecutionPolicy {
  /** The execution this policy applies to. */
  executionId?: string;
  /** Scheduling priority (lower = sooner); maps to @loom/scheduler Priority. */
  priority?: number;
  resources?: ExecutionResources;
  /** Named compute placement target (e.g. "local" | "cloudrun:svc"). */
  computeTarget?: string;
  /** Memory scope/namespace for the Memory runtime. */
  memoryScope?: string;
  /** Placement affinity hint. */
  affinity?: string;
  /** Durable retry policy (distinct from the in-effect retry middleware). */
  retryPolicy?: RetryPolicy;
  /** Free-form labels mirrored onto the Execution. */
  tags?: string[];
}
