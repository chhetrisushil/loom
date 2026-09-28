import type { EventEnvelope, ExecutionState } from "@loom/core";
import { describe, expect, it } from "vitest";
import { FAILED_WHILE_PARKED, knownEventTypes } from "./eventHandlers";
import { foldEvents, normalizeSnapshotState } from "./foldEvents";

// ── ADR 0105 — STEP_FAILED fails the STEP; only EXECUTION_FAILED fails the execution ──
//
// A flow may catch a step's throw and carry on, so the step event cannot know whether the
// execution failed. The kernel commits EXECUTION_FAILED when a failure escapes the runner;
// that event owns the terminal status, exactly as EXECUTION_CANCELLED does for STEP_CANCELLED.

function envelope(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `e-${sequence}`,
    executionId: "x-1",
    workflowId: "w-1",
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}

const prefix = [
  envelope(0, "EXECUTION_STARTED", { input: {} }),
  envelope(1, "STEP_STARTED", { stepId: "s1" }),
];

describe("STEP_FAILED leaves the execution status alone (ADR 0105)", () => {
  it("a failed step (untyped) leaves the execution running, with the failure on its frame", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
    ]);
    expect(state.status).toBe("running");
    expect(state.frames.s1).toMatchObject({ status: "failed", error: "boom" });
  });

  it("a typed failure (DE-4) — the canonical caught failure — leaves it running too", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "e", channel: "drift", payload: {} }),
    ]);
    expect(state.status).toBe("running");
  });

  it("a caught failure followed by more work and a completion folds to completed", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
      envelope(3, "STEP_STARTED", { stepId: "fallback" }),
      envelope(4, "STEP_COMPLETED", { stepId: "fallback", output: 1 }),
      envelope(5, "EXECUTION_COMPLETED", { output: 1 }),
    ]);
    expect(state.status).toBe("completed");
  });

  it("a caught failure then a park folds to suspended, and a resume back to running", () => {
    const parked = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
      envelope(3, "EXECUTION_SUSPENDED", { condition: { on: "go" } }),
    ]);
    expect(parked.status).toBe("suspended");
    const resumed = foldEvents([envelope(4, "EXECUTION_RESUMED", { ok: true })], parked);
    expect(resumed.status).toBe("running");
  });

  it("negative: an escaped failure — STEP_FAILED then EXECUTION_FAILED — folds to failed", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
      envelope(3, "EXECUTION_FAILED", { error: "Error: boom" }),
    ]);
    expect(state.status).toBe("failed");
    expect(state.variables._error).toBe("Error: boom");
  });

  it("negative: EXECUTION_FAILED with no step failure before it still folds to failed", () => {
    const state = foldEvents([...prefix, envelope(2, "EXECUTION_FAILED", { error: "x" })]);
    expect(state.status).toBe("failed");
  });
});

describe("the status contract — no STEP_* event moves execution status (spec §fold, ADR 0105)", () => {
  // Property over EVERY step event the fold knows (a new STEP_* kind is covered by adding it)
  // × every non-terminal status an execution can be in when a step event lands.
  const stepTypes = knownEventTypes().filter((t) => t.startsWith("STEP_"));
  const statuses = ["pending", "running", "suspended"] as const;

  it("finds the step events (the sweep can't silently match nothing)", () => {
    expect(stepTypes).toEqual(
      expect.arrayContaining(["STEP_STARTED", "STEP_COMPLETED", "STEP_FAILED", "STEP_CANCELLED"])
    );
  });

  for (const type of stepTypes) {
    for (const status of statuses) {
      it(`${type} leaves "${status}" unchanged`, () => {
        const base = foldEvents([], {
          executionId: "x-1",
          workflowId: "w-1",
          status,
          ...(status === "suspended" && { suspendedOn: { on: "go" } }),
        });
        const payload = { stepId: "s1", attempt: 2, error: "e", output: 1, input: {} };
        expect(foldEvents([envelope(0, type, payload)], base).status).toBe(status);
      });
    }
  }
});

describe("a parallel sibling that fails after the flow parked (1.21.0)", () => {
  const parkedThenFailed = [
    ...prefix,
    envelope(2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
    envelope(3, "STEP_FAILED", { stepId: "s1", error: "late boom" }),
  ];

  it("leaves the execution suspended on its gate, marked failed-while-parked", () => {
    const state = foldEvents(parkedThenFailed);
    expect(state.status).toBe("suspended");
    expect(state.suspendedOn).toEqual({ on: "Approval" });
    expect(state.variables[FAILED_WHILE_PARKED]).toBe(true);
  });

  it("a following null resume is status-only (fail-closed, as 1.20.0 folded it) and clears the mark", () => {
    const state = foldEvents([...parkedThenFailed, envelope(4, "EXECUTION_RESUMED", null)]);
    expect(state.status).toBe("running");
    expect(state.variables._resumePayloads).toBeUndefined();
    expect(Object.hasOwn(state.variables, FAILED_WHILE_PARKED)).toBe(false);
  });

  it("a following NON-null resume is the gate's answer", () => {
    const state = foldEvents([...parkedThenFailed, envelope(4, "EXECUTION_RESUMED", { ok: 1 })]);
    expect(state.variables._resumePayloads).toEqual([{ ok: 1 }]);
    expect(Object.hasOwn(state.variables, FAILED_WHILE_PARKED)).toBe(false);
  });

  it("negative: a failure BEFORE the park never marks it, so a null answer to the gate is kept", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "caught" }),
      envelope(3, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      envelope(4, "EXECUTION_RESUMED", null),
    ]);
    expect(state.variables._resumePayloads).toEqual([null]);
  });

  for (const [terminal, payload] of [
    ["EXECUTION_CANCELLED", { reason: "operator" }],
    ["EXECUTION_COMPLETED", {}],
    ["EXECUTION_FAILED", {}],
  ] as const) {
    it(`${terminal} ends the park, so the mark does not outlive it`, () => {
      const state = foldEvents([...parkedThenFailed, envelope(4, terminal, payload)]);
      expect(Object.hasOwn(state.variables, FAILED_WHILE_PARKED)).toBe(false);
    });
  }

  it("a log with no late failure never gains the key", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      envelope(3, "EXECUTION_RESUMED", { ok: 1 }),
    ]);
    expect(Object.hasOwn(state.variables, FAILED_WHILE_PARKED)).toBe(false);
  });
});

describe("snapshot + tail ≡ full log, for every shape ADR 0105 touches, from any snapshot", () => {
  // A replica of the 1.20.0 fold: the current handlers, but STEP_FAILED also forced the
  // execution to "failed" and the fold had no `_failedWhileParked` key — nothing else differed.
  function legacyFold(events: EventEnvelope[], initial?: Partial<ExecutionState>): ExecutionState {
    let state = foldEvents([], initial);
    for (const e of events) {
      state = foldEvents([e], state);
      if (e.eventType === "STEP_FAILED") {
        const { [FAILED_WHILE_PARKED]: _k, ...variables } = state.variables;
        state = { ...state, status: "failed", variables };
      }
    }
    return state;
  }
  let n = 0;
  const e = (type: string, payload: unknown) => envelope(n++, type, payload);
  const shapes: Record<string, () => EventEnvelope[]> = {
    // A 1.20.0 resumeAs after a late sibling failure, the re-park, then the real answer.
    "late sibling failure + 1.20.0 resumeAs null + real answer": () => [
      e("EXECUTION_STARTED", { input: {} }),
      e("STEP_STARTED", { stepId: "slow" }),
      e("EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      e("STEP_FAILED", { stepId: "slow", error: "late boom" }),
      e("EXECUTION_MIGRATED", { toFlowId: "f", strategy: "operator-ack" }),
      e("Fixup", { note: "operator" }),
      e("EXECUTION_RESUMED", null),
      e("STEP_STARTED", { stepId: "slow" }),
      e("EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      e("STEP_FAILED", { stepId: "slow", error: "late boom" }),
      e("Approval", { ok: true }),
      e("EXECUTION_RESUMED", { ok: true }),
      e("EXECUTION_COMPLETED", { output: { ok: true } }),
    ],
    ...Object.fromEntries(
      (
        [
          ["EXECUTION_CANCELLED", { reason: "operator" }],
          ["EXECUTION_COMPLETED", { output: {} }],
          // As the kernel writes it: its only EXECUTION_FAILED writer always records `error`.
          ["EXECUTION_FAILED", { error: "Error: x" }],
        ] as const
      ).map(([terminal, payload]) => [
        `park, late sibling failure, then ${terminal}`,
        () => [
          e("EXECUTION_STARTED", { input: {} }),
          e("STEP_STARTED", { stepId: "slow" }),
          e("EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
          e("STEP_FAILED", { stepId: "slow", error: "late boom" }),
          e(terminal, payload),
        ],
      ])
    ),
    "caught failure, then a crash": () => [
      e("EXECUTION_STARTED", { input: {} }),
      e("STEP_STARTED", { stepId: "a" }),
      e("STEP_FAILED", { stepId: "a", error: "caught" }),
      e("STEP_STARTED", { stepId: "b" }),
    ],
    "caught failure, then a park answered with null": () => [
      e("EXECUTION_STARTED", { input: {} }),
      e("STEP_FAILED", { stepId: "a", error: "caught" }),
      e("EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      e("EXECUTION_RESUMED", null),
    ],
  };

  for (const [name, build] of Object.entries(shapes)) {
    it(name, () => {
      n = 0;
      const log = build();
      const full = foldEvents(log);
      // Every gate passthrough is the one 1.20.0 folded (D3): the bump changes status, not answers.
      expect(full.variables._resumePayloads).toEqual(legacyFold(log).variables._resumePayloads);
      for (let k = 0; k < log.length; k++) {
        // (An EXECUTION_FAILED WITHOUT `error` — never kernel-written — is the one exception for a
        // 1.20.0 snapshot: after it, that snapshot is byte-for-byte the old fold's caught-failure
        // artifact, so normalizeSnapshotState cannot tell them apart. Current snapshots hold for it
        // too; see the next test.)
        const head = log.slice(0, k + 1);
        const tail = log.slice(k + 1);
        // A snapshot the current fold wrote…
        expect(foldEvents(tail, foldEvents(head)), `current snapshot @${k}`).toEqual(full);
        // …and one a 1.20.0 fold wrote, read through normalizeSnapshotState.
        expect(
          foldEvents(tail, normalizeSnapshotState(legacyFold(head))),
          `1.20.0 snapshot @${k}`
        ).toEqual(full);
      }
    });
  }
});

describe("snapshot + tail ≡ full log for an EXECUTION_FAILED without `error` (current snapshots)", () => {
  it("holds from every sequence", () => {
    const log = [
      ...prefix,
      envelope(2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      envelope(3, "STEP_FAILED", { stepId: "s1", error: "late boom" }),
      envelope(4, "EXECUTION_FAILED", {}),
    ];
    const full = foldEvents(log);
    expect(full.status).toBe("failed");
    for (let k = 0; k < log.length; k++) {
      expect(foldEvents(log.slice(k + 1), foldEvents(log.slice(0, k + 1))), `@${k}`).toEqual(full);
    }
  });
});

describe("normalizeSnapshotState — a snapshot folded before 1.21.0 (ADR 0105)", () => {
  const legacy = {
    executionId: "x-1",
    workflowId: "w-1",
    workflowVersion: "1",
    status: "failed" as const,
    frames: { s1: { stepId: "s1", status: "failed" as const, attempts: 1, error: "boom" } },
    variables: { _input: {} },
    sequence: 2,
    startedAt: 1,
    updatedAt: 3,
  };

  it("reads a caught-failure artifact (failed, no _error, a failed frame) as running", () => {
    expect(normalizeSnapshotState(legacy).status).toBe("running");
  });

  it("reads it as suspended when the snapshot is parked (a sibling failed during the park)", () => {
    const parked = { ...legacy, suspendedOn: { on: "Approval" } };
    const repaired = normalizeSnapshotState(parked);
    expect(repaired.status).toBe("suspended");
    // …and records what the current fold would have: the failure landed while parked.
    expect(repaired.variables[FAILED_WHILE_PARKED]).toBe(true);
  });

  it("negative: a genuine failure (EXECUTION_FAILED always records _error) is untouched", () => {
    const failed = { ...legacy, variables: { _input: {}, _error: "Error: boom" } };
    expect(normalizeSnapshotState(failed)).toBe(failed);
  });

  it("negative: failed with no failed frame is not the artifact, and is untouched", () => {
    const noFrame = { ...legacy, frames: {} };
    expect(normalizeSnapshotState(noFrame)).toBe(noFrame);
  });

  it("every non-failed state is returned as the same object", () => {
    const running = { ...legacy, status: "running" as const };
    expect(normalizeSnapshotState(running)).toBe(running);
  });

  it("a normalized legacy snapshot plus its tail folds like the log would", () => {
    const tail = [
      envelope(3, "STEP_STARTED", { stepId: "s2" }),
      envelope(4, "STEP_COMPLETED", { stepId: "s2", output: 1 }),
    ];
    expect(foldEvents(tail, normalizeSnapshotState(legacy)).status).toBe("running");
    // …which is what the unrepaired snapshot got wrong.
    expect(foldEvents(tail, legacy).status).toBe("failed");
  });
});
