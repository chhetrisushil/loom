import { type EventKind, KERNEL_EVENT_KINDS } from "@loom/core";

// ADR 0118 D1 — which kernel event kinds ANSWER a park.
//
// `acquireFenceIf(id, { fence, parkSeq })` (landing with R8k) refuses when an ANSWERING event
// exists past the park it is answering: another resumer's `EXECUTION_RESUMED`, a later park, or a
// terminal fact. Every other event is an audit append or an application event that follows a park without answering it
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
  // ADR 0130 residuals D9 (EVENT_SCHEMA 1.25.0, RESERVED: no writer yet): both land under the park's
  // conditional fence and leave the park unanswered, exactly like MESSAGE_CONSUMED.
  INBOX_QUARANTINED: "ignorable", // the topic's head is held; the park is not answered
  INBOX_RELEASED: "ignorable", // a held entry is released or dropped; the delivery's own facts answer
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

/** The two envelope fields the classification reads. */
export interface ClassifiableEvent {
  readonly eventType: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

const KERNEL_KIND_SET: ReadonlySet<string> = new Set(KERNEL_EVENT_KINDS);

/**
 * Whether an appended event answers a park (what `acquireFenceIf` counts past `parkSeq`).
 *
 * - A kind in {@link KERNEL_EVENT_KINDS} is classified by its {@link EVENT_KIND_CLASS} entry.
 * - A kind NOT in it is an APPLICATION event (`ctx.emit`, a `ctx.stream` delta, a parallel
 *   sibling's output) and is IGNORABLE: counting it would let a sibling that keeps emitting after
 *   the park make every `acquireFenceIf` stale, so the execution could never be resumed.
 * - EXCEPT an unknown kind that carries `metadata.kernel === true`: a kernel kind written by a
 *   NEWER node in a mixed fleet. This node cannot classify it, so it is ANSWERING (fail-closed:
 *   the cost of a wrong "answering" is a `contended` retry, of a wrong "ignorable" a fenced-out
 *   live body). This is why every kernel kind added after 1.23.0 MUST be stamped
 *   `metadata.kernel: true` by its writer — an unstamped new kernel kind is indistinguishable
 *   from an app event and would classify as ignorable on an older node.
 *
 * Own-property membership (a `Set`), so `"__proto__"` / `"constructor"` are unknown kinds, not
 * `Object.prototype` members; the stamp must be literally `true`.
 */
export function isAnsweringKind(event: ClassifiableEvent): boolean {
  if (KERNEL_KIND_SET.has(event.eventType)) {
    return EVENT_KIND_CLASS[event.eventType as EventKind] === "answering";
  }
  return event.metadata?.kernel === true;
}
