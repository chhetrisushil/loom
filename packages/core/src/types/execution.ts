import type { RetryPolicy } from "./definitions";

export type ExecutionStatus =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled"
  // EVENT_SCHEMA 1.23.0 (ADR 0109) — terminal, but NOT completed: the execution ended by
  // handing its work to a successor (`_continuedTo`). It has no output of its own, so a
  // consumer that reads "completed" as "the flow returned a value" must not treat it as one.
  | "continued";

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
  /**
   * DE-4 (1.17.0-additive) — the declared error channel a typed STEP_FAILED
   * completed on, with its schema-validated payload. Absent on legacy folds and
   * on untyped failures; presence is what makes replay SUBSTITUTE the failure
   * instead of re-executing the step.
   */
  errorChannel?: string;
  errorPayload?: unknown;
  attempts: number;
  /**
   * ADR 0113 D3 — the journal sequence of this step's FIRST `STEP_STARTED`: the log's first-start
   * order, which the replay-divergence detector ranks frames by. An object's key order cannot carry
   * it (integer-like ids sort first). Absent on a frame folded before this field existed.
   */
  firstSeq?: number;
  /**
   * ADR 0113 D3 — the cancellation-scope path (ADR 0112) the step first started in (`""` = the
   * root), recorded by the kernel only when `kernel.features.scopes` is on and folded only from a
   * kernel-stamped envelope. Absent = unknown (scopes off, or a legacy log).
   */
  scope?: string;
}

export interface SuspendCondition {
  on: string;
  timeout?: number;
  correlationKey?: string;
  /**
   * T1 — the absolute wall-clock time (epoch ms) a durable timer should wake
   * this execution. Recorded ONCE in the EXECUTION_SUSPENDED payload — the only
   * place wall clock enters the log (P9); replay serves the wake from the log
   * and never recomputes it. Set by `ctx.sleep`/`ctx.sleepUntil`, or derived
   * from `timeout` when a timer service is wired.
   */
  wakeAt?: number;
  /**
   * R13 (ADR 0117) — a digest of WHAT the approver is being asked to approve (the proposed
   * tool call, the plan, the diff), declared by the gate that parks. Recorded in the suspend
   * condition, so it is durable and fold-visible with no new event type. When present, the
   * resume that answers this gate MUST echo it as `payload.viewDigest`; a missing or different
   * one is refused before the append (`ResumeRefusedError`, `view-digest-mismatch`).
   */
  viewDigest?: string;
  /**
   * ADR 0104 — set by the KERNEL (never by `ctx.suspend`, which strips it) when a
   * `kind: "human"` step's effect parked the execution: the step whose answer the next resume
   * is. Absent on every `ctx.suspend` park and on every pre-0104 human park.
   */
  stepId?: string;
  /**
   * EVENT_SCHEMA 1.23.0 (ADR 0110) — every wait of a multi-wait park (`ctx.select` /
   * concurrent `ctx.receive`). Additive: a single-gate park keeps writing only the legacy
   * fields above, byte-identically, so older readers and `locatePark` are unaffected.
   */
  waits?: SuspendWait[];
}

/** One wait of a multi-wait park (EVENT_SCHEMA 1.23.0, ADR 0110 D4). */
export interface SuspendWait {
  /** `<scopePath>#<ordinal>` (ADR 0110 D3). */
  waitId: string;
  kind: "gate" | "inbox" | "timer";
  /** The gate name (`kind: "gate"`). */
  on?: string;
  /** The inbox topic (`kind: "inbox"`). */
  topic?: string;
  viewDigest?: string;
  correlationKey?: string;
  /** A timer arm's wake (epoch ms), recorded once at first registration. */
  wakeAt?: number;
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
