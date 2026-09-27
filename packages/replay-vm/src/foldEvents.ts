import type { EventEnvelope, ExecutionState } from "@loom/core";
import { FLOW_EMIT_DIGEST, countFlowEmit, getHandler, resetFoldOwnership } from "./eventHandlers";

const DEFAULT_STATE: Omit<ExecutionState, "executionId" | "workflowId" | "workflowVersion"> = {
  status: "pending",
  frames: {},
  variables: {},
  sequence: -1,
  startedAt: 0,
  updatedAt: 0,
};

export function foldEvents(
  events: EventEnvelope[],
  initial?: Partial<ExecutionState>
): ExecutionState {
  // `state` is always an object this function created (the seed below, or a fresh
  // handler result) — never the caller's `initial` — so setting `sequence` in
  // place is safe and avoids a full-state spread per event.
  let state: ExecutionState = {
    executionId: initial?.executionId ?? "",
    workflowId: initial?.workflowId ?? "",
    workflowVersion: initial?.workflowVersion ?? "",
    ...DEFAULT_STATE,
    ...initial,
  };

  // Fresh audit-list ownership for THIS fold pass, so in-place appends never touch the
  // caller's `initial`/snapshot arrays (which we treat as immutable). See appendAudit.
  resetFoldOwnership();

  for (const event of events) {
    const handler = getHandler(event.eventType);
    if (handler) {
      state = handler(state, event);
    }
    // 1.19.0 (ADR 0102) — the one fold step keyed on an envelope STAMP rather than an
    // event type: a flow-level emit (`ctx.emit`/`ctx.stream`/`ctx.ui`, usually a domain
    // event with no handler) may carry `metadata.flowEmit = <content digest>`, and
    // `_flowEmits` counts the stamped emits per digest, so a re-run from the top can serve
    // the emits the log already holds instead of appending them again. An unstamped log
    // (legacy, or kernel facts only) never gains the key and folds byte-identically.
    const stamp = event.metadata?.flowEmit;
    if (typeof stamp === "string" && FLOW_EMIT_DIGEST.test(stamp)) {
      state.variables = countFlowEmit(state.variables, stamp);
    }
    state.sequence = event.sequence;
  }

  return state;
}

/**
 * ADR 0105 (EVENT_SCHEMA 1.21.0) — read a SNAPSHOT's state as the current fold would have
 * written it. Before 1.21.0 `STEP_FAILED` also set the EXECUTION's status to "failed", so a
 * snapshot saved after a step failure the flow caught (or a parallel sibling's failure that
 * landed after the flow parked) records a terminal status for a live execution. A log folds
 * correctly on its own; a snapshot is a stored fold and does not.
 *
 * The artifact is recognisable in O(1) on the common path: the kernel's only
 * `EXECUTION_FAILED` writer always records `error`, so a genuinely failed execution carries
 * `variables._error`. "failed" with no `_error` and a failed step frame is the old fold's
 * doing, and the status it hid is `suspended` when the execution is parked (`suspendedOn`
 * survives only while parked) and `running` otherwise. Every other state is returned as-is
 * (same object).
 */
export function normalizeSnapshotState<T extends Partial<ExecutionState>>(state: T): T {
  if (state.status !== "failed" || state.variables?._error !== undefined) return state;
  const frames = state.frames ?? {};
  let stepFailed = false;
  for (const stepId of Object.keys(frames)) {
    if (frames[stepId]?.status === "failed") {
      stepFailed = true;
      break;
    }
  }
  if (!stepFailed) return state;
  return { ...state, status: state.suspendedOn !== undefined ? "suspended" : "running" };
}
