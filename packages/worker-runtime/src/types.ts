import type { ExecutionState, SuspendCondition } from "@loom/core";

/**
 * The immutable, JSON-serializable description of ONE execution to run on a
 * worker. It is the sole payload that crosses the placement boundary
 * (in-process, HTTP, Cloud Run). It carries **identity + resume coordinates**,
 * never live code: the worker resolves the flow/effects by id from the code it
 * was booted with (`flowId`), and reconstructs state from the shared event +
 * snapshot stores.
 *
 * Two shapes:
 *  - fresh start:  `input` set, `resumeEvent` absent.
 *  - resume:       `resumeEvent` set (e.g. an approval decision). The worker
 *                  rebuilds from the latest snapshot + event tail and continues.
 */
export interface ExecutionPackage {
  executionId: string;
  /** Workflow/flow definition id — used to fold identity and resolve code. */
  workflowId: string;
  /** Registry key the worker uses to resolve the flow's runner + effects. */
  flowId: string;
  /** Input for a fresh start. Ignored on resume (it lives in the event log). */
  input?: unknown;
  /** Present ⇒ this is a resume dispatch. Delivered as the resume payload. */
  resumeEvent?: { eventType: string; payload: unknown };
  /** Optional resume hints (a specific snapshot / event offset to rebuild from). */
  snapshotId?: string;
  fromSequence?: number;
  /** Opaque routing/telemetry metadata; never load-bearing for correctness. */
  metadata?: Record<string, unknown>;
}

/** Where an execution ended for this dispatch. A suspend is a normal outcome. */
export type ExecutionOutcome = "completed" | "suspended" | "failed";

/**
 * What a worker returns after running an ExecutionPackage to a terminal-or-
 * suspended state and persisting its events/snapshot. This is exactly the JSON a
 * remote worker sends back over `POST /execute`, plus the folded terminal state
 * so in-process callers avoid a re-read.
 */
export interface ExecutionResult {
  executionId: string;
  status: ExecutionOutcome;
  /** Folded execution state at the stopping point (completed / suspended / failed). */
  state: ExecutionState;
  /** `state.variables._output` on completion; convenience mirror. */
  output?: unknown;
  /** `state.variables._error` on failure; convenience mirror. */
  error?: unknown;
  /** The condition the execution suspended on, when `status === "suspended"`. */
  suspendedOn?: SuspendCondition;
  /** Highest event sequence persisted for this execution. */
  lastSequence: number;
}

/** A request to reserve worker capacity for one execution. */
export interface WorkerRequest {
  executionId: string;
  metadata?: Record<string, unknown>;
}

/**
 * A reservation of worker capacity. For LocalWorkerRuntime this is a trivial
 * in-process token; for CloudRunWorkerRuntime it names the allocated instance.
 */
export interface WorkerLease {
  leaseId: string;
  metadata?: Record<string, unknown>;
}

/**
 * The Platform SPI. A `WorkerRuntime` abstracts *how/where* an ExecutionPackage
 * runs. Implementations: LocalWorkerRuntime (in-process), RemoteWorkerRuntime
 * (HTTP), CloudRunWorkerRuntime. Optional platform capabilities
 * (secrets/identity/logging/metrics) hang off the same adapter so cloud concerns
 * stay isolated behind the interface.
 */
export interface WorkerRuntime {
  allocate(request: WorkerRequest): Promise<WorkerLease>;
  execute(lease: WorkerLease, pkg: ExecutionPackage): Promise<ExecutionResult>;
  release(lease: WorkerLease): Promise<void>;
}
