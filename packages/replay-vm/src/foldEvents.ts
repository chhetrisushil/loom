import type { EventEnvelope, ExecutionState } from "@loom/core";
import { getHandler, resetFoldOwnership } from "./eventHandlers";

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
    // event with no handler) carries `metadata.flowEmit = ordinal`, and `_flowEmits` is
    // the high-water mark `ordinal + 1`, so a re-run from the top can serve the emits
    // the log already holds instead of appending them again. An unstamped log (legacy,
    // or kernel facts only) never gains the key and folds byte-identically.
    const stamp = event.metadata?.flowEmit;
    if (typeof stamp === "number" && Number.isInteger(stamp) && stamp >= 0) {
      const prev = (state.variables._flowEmits as number | undefined) ?? 0;
      if (stamp + 1 > prev) {
        // Copy-on-write like every `_`-prefixed kernel variable: `state` is always an
        // object this function created, but `variables` may be the caller's.
        state.variables = { ...state.variables, _flowEmits: stamp + 1 };
      }
    }
    state.sequence = event.sequence;
  }

  return state;
}
