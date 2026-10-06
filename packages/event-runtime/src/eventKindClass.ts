import type { EventKind } from "@loom/core";

// ADR 0118 D1 — which kernel event kinds ANSWER a park.
//
// `acquireFenceIf(id, { fence, parkSeq })` (landing with R8k) refuses when an ANSWERING event
// exists past the park it is answering: another resumer's `EXECUTION_RESUMED`, a later park, or a
// terminal fact. Every other kind is an audit append that follows a park without answering it
// (an unfenced `EXECUTION_DENIED`, a late `OUTCOME_RECORDED`, a `STEP_FAILED` while parked, a
// `MESSAGE_CONSUMED` written by the running owner, ...) and must NOT make the acquire stale, or a
// legitimate resume would be refused for an audit row.
//
// The map is a REQUIRED `Record<EventKind, ...>` with no default: adding a kind to
// `KERNEL_EVENT_KINDS` without deciding is a compile error here. The fitness test in
// `@loom/workflow-runtime` pins its keys equal to the fold's handler table.

/** Whether an event of this kind, appended after a park, answers it. */
export type EventKindClass = "answering" | "ignorable";

export const EVENT_KIND_CLASS: Readonly<Record<EventKind, EventKindClass>> = {
  // ── answering: they move the execution out of the park (or supersede it) ──
  EXECUTION_RESUMED: "answering", // any payload, incl. the `null` status-only re-open (ADR 0104)
  EXECUTION_SUSPENDED: "answering", // a later park supersedes this one
  EXECUTION_COMPLETED: "answering",
  EXECUTION_FAILED: "answering",
  EXECUTION_CANCELLED: "answering",
  EXECUTION_CONTINUED: "answering", // ADR 0109: terminal, names the successor

  // ── ignorable: audit / bookkeeping that never answers a park by itself ──
  EXECUTION_STARTED: "ignorable", // sequence 0; precedes every park
  EXECUTION_DENIED: "ignorable", // unfenced, appended after a park (`recordExecutionDenied`)
  OUTCOME_RECORDED: "ignorable", // ADR 0116: terminal-only late attach, or a live emit
  MESSAGE_CONSUMED: "ignorable", // ADR 0110: written by the running owner; the RESUMED answers
  EXECUTION_MIGRATED: "ignorable",
  STEP_STARTED: "ignorable",
  STEP_COMPLETED: "ignorable",
  STEP_FAILED: "ignorable", // ADR 0105: a sibling failing while parked
  STEP_CANCELLED: "ignorable",
  STEP_RETRYING: "ignorable",
  PARALLEL_STARTED: "ignorable",
  PARALLEL_COMPLETED: "ignorable", // ADR 0112: the scope outcome, written before a rethrow
  DECISION_RECORDED: "ignorable",
  EFFECT_DENIED: "ignorable",
  EFFECT_INDOUBT: "ignorable",
  EGRESS_DENIED: "ignorable",
  SAFETY_BLOCKED: "ignorable",
  QUOTA_EXCEEDED: "ignorable",
  RESOURCE_METERED: "ignorable",
  APPROVAL_GRANTED: "ignorable",
  TIMER_FIRED: "ignorable",
  PAYLOAD_SHREDDED: "ignorable",
  ERASURE_PENDING: "ignorable",
  EXECUTION_ARCHIVED: "ignorable",
  EXECUTION_DELETED: "ignorable",
  EVENTS_REHOMED: "ignorable",
};

/**
 * Whether an event of `kind` answers a park. FAIL-CLOSED: a kind absent from the map (only
 * possible in a mixed fleet, where a newer node wrote a kind this node does not know) is
 * ANSWERING. The cost of a wrong "answering" is a `contended` retry; the cost of a wrong
 * "ignorable" is fencing out a live body. Own-property lookup, so `"__proto__"` and
 * `"constructor"` are unknown kinds too, not `Object.prototype` members.
 */
export function isAnsweringKind(kind: string): boolean {
  if (!Object.hasOwn(EVENT_KIND_CLASS, kind)) return true;
  return EVENT_KIND_CLASS[kind as EventKind] === "answering";
}
