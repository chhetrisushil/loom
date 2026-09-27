import type { EventEnvelope } from "@loom/core";
import { foldEvents } from "@loom/replay-vm";

// ── T2.3 — language-agnostic fold conformance vectors ─────────────────────────
//
// The event log is the kernel's on-disk ABI (K5): state = fold(events). These
// vectors are the EXECUTABLE, language-agnostic conformance suite the amendment
// requires — event-log fixtures in, expected folds out. Any client
// implementation (in any language) can load `FOLD_VECTORS` as plain JSON, run
// its own fold, and assert equality; the TS reference below is one such runner.
// This extends the K1/K5 pins from "the fold understands these types" to "the
// fold produces exactly this state for this log".

export interface FoldVector {
  name: string;
  events: EventEnvelope[];
  /** The expected `fold(events)` — compared field-by-field (JSON-equal). */
  expected: {
    status: string;
    sequence: number;
    variables: Record<string, unknown>;
    frames: Record<string, { status: string; attempts: number }>;
  };
}

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

/**
 * The canonical vectors. Deliberately covers the core lifecycle plus a
 * representative kernel-ring fact, so a foreign fold that mishandles any of them
 * fails loudly. Extend (never repurpose) alongside the K5 schema.
 */
export const FOLD_VECTORS: FoldVector[] = [
  {
    name: "start → step → complete",
    events: [
      ev("v1", 0, "EXECUTION_STARTED", { input: { n: 1 } }),
      ev("v1", 1, "STEP_STARTED", { stepId: "a", input: { n: 1 } }),
      ev("v1", 2, "STEP_COMPLETED", { stepId: "a", output: { n: 2 } }),
      ev("v1", 3, "EXECUTION_COMPLETED", { output: { n: 2 } }),
    ],
    expected: {
      status: "completed",
      sequence: 3,
      variables: { _input: { n: 1 }, _output: { n: 2 } },
      frames: { a: { status: "completed", attempts: 1 } },
    },
  },
  {
    name: "suspend leaves a running frame + suspended status",
    events: [
      ev("v2", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v2", 1, "STEP_STARTED", { stepId: "gate", input: {} }),
      ev("v2", 2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
    ],
    expected: {
      status: "suspended",
      sequence: 2,
      variables: { _input: {} },
      frames: { gate: { status: "running", attempts: 1 } },
    },
  },
  {
    name: "a metered + denied ring log folds its audit facts",
    events: [
      ev("v3", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v3", 1, "RESOURCE_METERED", { tokens: 100, costUsd: 0.5, ms: 10 }),
      ev("v3", 2, "EFFECT_DENIED", { toolId: "delete-prod", reason: "not granted" }),
    ],
    expected: {
      status: "running",
      sequence: 2,
      variables: {
        _input: {},
        _resources: { tokens: 100, costUsd: 0.5, ms: 10, count: 1 },
        _denials: [{ toolId: "delete-prod", reason: "not granted" }],
      },
      frames: {},
    },
  },
  {
    // 1.19.0 (ADR 0102) — the one fold step keyed on an envelope stamp, not a type:
    // `metadata.flowEmit` (a 16-hex content digest) on ANY event type — here a domain
    // event and SURFACE_PATCH, neither of which has a handler — is counted per digest in
    // a 16-way trie of 16-slot arrays over the digest's last three hex digits. An unstamped event (a legacy log's emit, or one
    // appended while an effect was in flight) counts nothing.
    name: "stamped flow-level emits are counted per content digest; unstamped ones are not",
    events: [
      ev("v4", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v4", 1, "response.committed", { msg: "m1" }, { flowEmit: "0123456789abcdef" }),
      ev("v4", 2, "SURFACE_PATCH", { patches: [] }, { flowEmit: "ffffffffffffffef", fence: 2 }),
      ev("v4", 3, "response.committed", { msg: "m1" }, { flowEmit: "0123456789abcdef" }),
      ev("v4", 4, "legacy.domain", {}),
    ],
    expected: {
      status: "running",
      sequence: 4,
      variables: {
        _input: {},
        // 16-slot arrays indexed by the digest's last three hex digits (f, e, then d / f).
        _flowEmits: [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          [
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            [
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              { "0123456789abcdef": 2 },
              null,
              { ffffffffffffffef: 1 },
            ],
            null,
          ],
        ],
      },
      frames: {},
    },
  },
  {
    // 1.21.0 (ADR 0105) — STEP_FAILED folds the step's frame only. A flow that catches the
    // failure keeps running; only EXECUTION_FAILED fails the execution. A foreign fold that
    // still moves the execution status on a step failure reports a live execution terminal.
    name: "a caught step failure fails the frame, not the execution",
    events: [
      ev("v5", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v5", 1, "STEP_STARTED", { stepId: "a", input: {} }),
      ev("v5", 2, "STEP_FAILED", { stepId: "a", error: "Error: 503" }),
      ev("v5", 3, "STEP_STARTED", { stepId: "fallback", input: {} }),
    ],
    expected: {
      status: "running",
      sequence: 3,
      variables: { _input: {} },
      frames: {
        a: { status: "failed", attempts: 1 },
        fallback: { status: "running", attempts: 1 },
      },
    },
  },
  {
    // 1.21.0 (ADR 0105) — a STEP_FAILED that lands while the execution is PARKED (a parallel
    // sibling) leaves it suspended and sets `_failedWhileParked`; a following `null` resume is
    // status-only (no gate passthrough) and clears it. A foreign fold that serves that null to
    // the gate lets it pass with no approval.
    name: "a null resume after a sibling failed while parked answers no gate",
    events: [
      ev("v6", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v6", 1, "STEP_STARTED", { stepId: "slow", input: {} }),
      ev("v6", 2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      ev("v6", 3, "STEP_FAILED", { stepId: "slow", error: "Error: late" }),
      ev("v6", 4, "EXECUTION_RESUMED", null),
    ],
    expected: {
      status: "running",
      sequence: 4,
      variables: { _input: {} },
      frames: { slow: { status: "failed", attempts: 1 } },
    },
  },
];

/** Run the reference fold over every vector; returns per-vector pass/fail + detail. */
export function runFoldVectors(vectors: readonly FoldVector[] = FOLD_VECTORS): Array<{
  name: string;
  passed: boolean;
  detail?: string;
}> {
  return vectors.map((v) => {
    const state = foldEvents(v.events);
    const framesView: Record<string, { status: string; attempts: number }> = {};
    for (const [k, f] of Object.entries(state.frames)) {
      framesView[k] = { status: f.status, attempts: f.attempts };
    }
    const actual = {
      status: state.status,
      sequence: state.sequence,
      variables: state.variables,
      frames: framesView,
    };
    const passed = JSON.stringify(actual) === JSON.stringify(v.expected);
    return passed
      ? { name: v.name, passed }
      : {
          name: v.name,
          passed,
          detail: `expected ${JSON.stringify(v.expected)} got ${JSON.stringify(actual)}`,
        };
  });
}
