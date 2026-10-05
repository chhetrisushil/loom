import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type {
  ExecutionHandle,
  ResumeEvent,
  RunOptions,
  WorkflowRuntime,
} from "@loom/workflow-runtime";

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `pred` until it is truthy or the timeout elapses — replaces the hand-rolled
 * `for (i<200) { sleep(25) }` loops in the example tests. Throws on timeout.
 */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  options: WaitOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(intervalMs);
  }
  if (await pred()) return;
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

/** Read a projection surface's current folded state. */
export function getSurfaceState<T>(
  projectionRuntime: ProjectionRuntime,
  surface: string,
  executionId: string
): T {
  return projectionRuntime.getState<T>(surface, executionId);
}

/** Wait until a surface's `phase` field reaches `phase`. */
export function waitForPhase(
  projectionRuntime: ProjectionRuntime,
  surface: string,
  executionId: string,
  phase: string,
  options?: WaitOptions
): Promise<void> {
  return waitFor(
    () =>
      getSurfaceState<{ phase?: string }>(projectionRuntime, surface, executionId)?.phase === phase,
    options
  );
}

/** Await a flow reaching its next durable suspend checkpoint. */
export function driveToSuspend(handle: ExecutionHandle): Promise<unknown> {
  return handle.waitForSuspend();
}

/**
 * Resume a durably-suspended execution with a resume event — the runtime-level
 * counterpart to an orchestrator's `resolveApproval`. Defaults to an
 * `ApprovalGranted` approval.
 *
 * `options` is forwarded to `runtime.resume` — pass `{ principal }` (or
 * `runtime.systemOptions()`) to drive an app that fails closed on a missing principal
 * (`security.strict`); without one the resume is anonymous and such an app refuses it.
 */
export function resumeWith(
  runtime: WorkflowRuntime,
  executionId: string,
  event: ResumeEvent = { eventType: "ApprovalGranted", payload: { approved: true } },
  options?: RunOptions
): Promise<ExecutionHandle> {
  return runtime.resume(executionId, event, options);
}

/** Read an execution's durable event log — the raw material for a golden fixture. */
export function captureGolden(
  eventStore: EventStore,
  executionId: string
): Promise<EventEnvelope[]> {
  return eventStore.read(executionId);
}
