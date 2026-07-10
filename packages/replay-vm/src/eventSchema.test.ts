import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION, knownEventTypes } from "./eventHandlers";

// K5 governance: the event log is the kernel's on-disk ABI. This pins the set of
// event types the fold understands so a removal/rename (which changes how historical
// logs replay) can't happen silently. Adding one is additive — bump the version and
// update this list in the same, reviewed change.
const PINNED_EVENT_TYPES = [
  "DECISION_RECORDED",
  "EFFECT_DENIED",
  "EFFECT_INDOUBT",
  "EGRESS_DENIED",
  "EXECUTION_CANCELLED",
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_MIGRATED",
  "EXECUTION_RESUMED",
  "EXECUTION_STARTED",
  "EXECUTION_SUSPENDED",
  "OUTCOME_RECORDED",
  "PARALLEL_COMPLETED",
  "PARALLEL_STARTED",
  "QUOTA_EXCEEDED",
  "RESOURCE_METERED",
  "SAFETY_BLOCKED",
  "STEP_CANCELLED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "STEP_RETRYING",
  "STEP_STARTED",
  "TIMER_FIRED",
];

describe("Event-schema ABI (K5)", () => {
  it("declares a semver schema version", () => {
    expect(EVENT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("pins the known event-type set (guards against silent on-disk ABI breaks)", () => {
    expect(knownEventTypes()).toEqual(PINNED_EVENT_TYPES);
  });
});
