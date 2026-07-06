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
}

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
