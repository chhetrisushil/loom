import type { EventEnvelope, ExecutionState } from "@loom/core";
import { getHandler } from "./eventHandlers";

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

  for (const event of events) {
    const handler = getHandler(event.eventType);
    if (handler) {
      state = handler(state, event);
    }
    state.sequence = event.sequence;
  }

  return state;
}
