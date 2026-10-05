import type { ExecutionPackage, ExecutionResult } from "@loom/worker-runtime";

/**
 * SPI version for the {@link ExecutionDispatcher} contract (ADR 0033). Pinned by
 * `runExecutionDispatcherConformance` in `@loom/testing`.
 *
 * 1.1.0 (L20, ADR 0004 amendment) — a dispatcher MUST NOT retry or redispatch when the worker
 * was refused because another holder owns the execution (`isSupersededRefusal` from
 * `@loom/worker-runtime`); it settles the dispatch with that refusal. MINOR: no method changed,
 * a non-retrying dispatcher already conforms, and the kit case runs only when the caller opts in
 * with `overWorker`, so no 1.0 dispatcher newly fails the kit.
 *
 * 1.2.0 (R3, ADR 0111) — `ExecutionPackage.principal` and `WorkerRequest.principal` (both
 * optional JSON) carry the authenticated caller across the dispatch seam, and `WorkerRuntime`
 * gains the optional `runsAsSystem` marker. MINOR: every field is optional, a dispatcher that
 * forwards the package whole (all four first-party ones do) already conforms, and a worker that
 * ignores `principal` behaves as before.
 */
export const DISPATCHER_SPI_VERSION = "1.2.0";

/**
 * Placement hints the scheduler/orchestrator attaches to a dispatch. The
 * Dispatcher maps these to a concrete placement decision (e.g. Cloud Run CPU/
 * memory in Step 3). Everything is optional and advisory — correctness never
 * depends on it.
 */
export interface DispatchMetadata {
  lane?: string;
  priority?: number;
  estimatedCpu?: number;
  estimatedMemory?: number;
  estimatedDuration?: number;
  /**
   * Named compute placement target (e.g. "local" | "cloudrun"). Advisory: a
   * {@link PlacementDispatcher} routes to the matching target, falling back to its
   * default when absent/unknown. Derived from `ExecutionPolicy.computeTarget` (M4).
   */
  target?: string;
}

/**
 * Chooses which named target handles a dispatch. Pure and synchronous so placement
 * is deterministic and cheap. Given the package, its advisory metadata, and the set
 * of registered target names, return the chosen name (a PlacementDispatcher falls
 * back to its default if the returned name is not registered).
 */
export type PlacementPolicy = (
  pkg: ExecutionPackage,
  meta: DispatchMetadata | undefined,
  targets: readonly string[]
) => string;

/** A snapshot of dispatcher liveness for health checks / observability. */
export interface DispatcherHealth {
  healthy: boolean;
  inFlight: number;
  detail?: string;
}

/**
 * Separates execution *placement* from execution *scheduling*. The scheduler
 * decides WHAT runs; the Dispatcher decides WHERE, and owns worker allocation,
 * result collection, retries and (from Step 4) timeout + failure redispatch. It
 * talks only to a {@link WorkerRuntime} — never to a specific cloud.
 */
export interface ExecutionDispatcher {
  /**
   * Run `pkg` to suspend-or-complete. MAY retry a failed attempt; MUST NOT retry or redispatch a
   * superseded refusal (`isSupersededRefusal`, 1.1.0) — it rejects with that refusal instead.
   * Such a rejection is not the execution's failure: another holder owns it, possibly this
   * caller's own earlier timed-out attempt. A caller that needs the outcome awaits it by id
   * (`loadState` / `subscribe`); a holder that has died is re-driven by `recoverAbandoned`.
   */
  dispatch(pkg: ExecutionPackage, meta?: DispatchMetadata): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  health(): Promise<DispatcherHealth>;
}
