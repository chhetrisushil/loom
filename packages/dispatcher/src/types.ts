import type { ExecutionPackage, ExecutionResult } from "@loom/worker-runtime";

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
  dispatch(pkg: ExecutionPackage, meta?: DispatchMetadata): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  health(): Promise<DispatcherHealth>;
}
