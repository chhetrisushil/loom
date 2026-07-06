import type { EventEnvelope } from "@loom/core";
import { foldAt } from "./core";

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
  return {
    executionId: first?.executionId ?? "",
    workflowId: first?.workflowId ?? "",
    timeline: events.map((e) => ({
      sequence: e.sequence,
      eventType: e.eventType,
      suspend: e.eventType === "EXECUTION_SUSPENDED",
    })),
    frames: events.map((e) => ({
      sequence: e.sequence,
      status: foldAt(events, e.sequence).status,
    })),
    finalStatus: events.length > 0 ? foldAt(events).status : "unknown",
  };
}
