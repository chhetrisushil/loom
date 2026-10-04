import type { EventEnvelope } from "@loom/core";
import { ReplayVM } from "@loom/replay-vm";

export interface TraceEvent {
  sequence: number;
  eventType: string;
  suspend: boolean;
}
export interface TraceFrame {
  sequence: number;
  status: string;
}
export interface Trace {
  executionId: string;
  workflowId: string;
  timeline: TraceEvent[];
  /** Folded status at each sequence — the data a time-travel slider renders. */
  frames: TraceFrame[];
  finalStatus: string;
}

/**
 * Build the render model for the inspector: the event timeline plus the folded
 * status at every sequence. Pure and reusing `foldAt`, so the web slider and
 * `loom debug` share one deterministic time-travel engine.
 */
export function buildTrace(events: EventEnvelope[]): Trace {
  const first = events[0];
  // Single incremental fold: apply each event once, capturing the status at each
  // sequence — O(N) total, not a fresh prefix-fold per event (which was O(N²)).
  const vm = new ReplayVM(
    [],
    first ? { executionId: first.executionId, workflowId: first.workflowId } : undefined
  );
  const timeline: TraceEvent[] = [];
  const frames: TraceFrame[] = [];
  for (const e of events) {
    vm.applyEvent(e);
    timeline.push({
      sequence: e.sequence,
      eventType: e.eventType,
      suspend: e.eventType === "EXECUTION_SUSPENDED",
    });
    frames.push({ sequence: e.sequence, status: vm.peekState().status });
  }
  return {
    executionId: first?.executionId ?? "",
    workflowId: first?.workflowId ?? "",
    timeline,
    frames,
    finalStatus: events.length > 0 ? vm.peekState().status : "unknown",
  };
}
