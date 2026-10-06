/**
 * EVENT_SCHEMA 1.23.0 (Wave 2, W2-0) — the NAMES of the kernel's folded event kinds, as a
 * compile-time union.
 *
 * The fold's handler table (`@loom/replay-vm`) is the runtime truth; this tuple is its
 * type-level mirror, so a table keyed by `EventKind` (the answering/ignorable classification
 * in `@loom/event-runtime`, ADR 0118 D1) is a COMPILE error the moment a kind is added here
 * without a decision. A fitness test pins `KERNEL_EVENT_KINDS` equal to `knownEventTypes()`,
 * so the two cannot drift: adding a handler without adding it here fails that test, and adding
 * it here without classifying it fails `tsc`.
 */
export const KERNEL_EVENT_KINDS = [
  "APPROVAL_GRANTED",
  "DECISION_RECORDED",
  "EFFECT_DENIED",
  "EFFECT_INDOUBT",
  "EGRESS_DENIED",
  "ERASURE_PENDING",
  "EVENTS_REHOMED",
  "EXECUTION_ARCHIVED",
  "EXECUTION_CANCELLED",
  "EXECUTION_COMPLETED",
  "EXECUTION_CONTINUED",
  "EXECUTION_DELETED",
  "EXECUTION_DENIED",
  "EXECUTION_FAILED",
  "EXECUTION_MIGRATED",
  "EXECUTION_RESUMED",
  "EXECUTION_STARTED",
  "EXECUTION_SUSPENDED",
  "MESSAGE_CONSUMED",
  "OUTCOME_RECORDED",
  "PARALLEL_COMPLETED",
  "PARALLEL_STARTED",
  "PAYLOAD_SHREDDED",
  "QUOTA_EXCEEDED",
  "RESOURCE_METERED",
  "SAFETY_BLOCKED",
  "STEP_CANCELLED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "STEP_RETRYING",
  "STEP_STARTED",
  "TIMER_FIRED",
] as const;

/** A kind the kernel's fold has a handler for. */
export type EventKind = (typeof KERNEL_EVENT_KINDS)[number];
