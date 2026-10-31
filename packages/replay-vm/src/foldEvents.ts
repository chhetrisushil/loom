import type { EventEnvelope, ExecutionFrame, ExecutionState } from "@loom/core";
import {
  FAILED_WHILE_PARKED,
  FLOW_EMIT_DIGEST,
  countFlowEmit,
  getHandler,
  resetFoldOwnership,
  useFoldOwnership,
} from "./eventHandlers";

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
  initial?: Partial<ExecutionState>,
  /**
   * R1a — the ownership set of a LIVE fold (see {@link useFoldOwnership}). Omit it for a
   * one-shot fold: ownership then starts empty, so nothing the caller passed in is written to.
   */
  owned?: WeakSet<object>
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
  if (owned === undefined) resetFoldOwnership();
  else useFoldOwnership(owned);

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
  return normalizeFailed(stripSettledInputs(state));
}

const SETTLED_FRAME = new Set(["completed", "failed", "cancelled"]);

/**
 * ADR 0138 D8 (EVENT_SCHEMA 1.26.0) - the fold no longer keeps a SETTLED frame's `input` (the log, or the
 * compaction archive, holds it). A snapshot written by an older fold still carries them; strip them in
 * one O(frames) pass so `fold(snapshot, tail) == fold(events)` holds. Frames still in flight keep theirs.
 * Returns the same object when there is nothing to strip.
 */
function stripSettledInputs<T extends Partial<ExecutionState>>(state: T): T {
  const frames = state.frames;
  if (frames === undefined) return state;
  let stripped: Record<string, ExecutionFrame> | undefined;
  for (const stepId of Object.keys(frames)) {
    const frame = frames[stepId];
    if (frame !== undefined && frame.input !== undefined && SETTLED_FRAME.has(frame.status)) {
      stripped ??= { ...frames };
      const { input: _input, ...rest } = frame;
      stripped[stepId] = rest as ExecutionFrame;
    }
  }
  return stripped === undefined ? state : { ...state, frames: stripped };
}

function normalizeFailed<T extends Partial<ExecutionState>>(state: T): T {
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
  // A parked artifact means the failure landed AFTER the park (a STEP_FAILED before it would
  // have been overwritten by the park's "suspended"; a resume removes `suspendedOn`) — exactly
  // what the current fold records as `_failedWhileParked`, so the repaired snapshot folds its
  // tail as the full log would.
  if (state.suspendedOn === undefined) return { ...state, status: "running" };
  return {
    ...state,
    status: "suspended",
    variables: { ...state.variables, [FAILED_WHILE_PARKED]: true },
  };
}
