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
  payload: unknown
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
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
    const actual = { status: state.status, sequence: state.sequence, variables: state.variables, frames: framesView };
    const passed = JSON.stringify(actual) === JSON.stringify(v.expected);
    return passed
      ? { name: v.name, passed }
      : { name: v.name, passed, detail: `expected ${JSON.stringify(v.expected)} got ${JSON.stringify(actual)}` };
  });
}
