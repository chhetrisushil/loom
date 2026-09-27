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
