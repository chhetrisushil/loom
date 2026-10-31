import type { EventEnvelope, ExecutionState } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents, normalizeSnapshotState } from "./foldEvents";

// ADR 0138 D8 (EVENT_SCHEMA 1.26.0) - a settled frame no longer carries `input`; a running one does.

const ID = "ex";
const ev = (sequence: number, eventType: string, payload: unknown = {}): EventEnvelope => ({
  id: `${ID}-${sequence}`,
  workflowId: "wf",
  executionId: ID,
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
});
const INITIAL: ExecutionState = new ReplayVM([]).getState();
const input = { big: "x".repeat(100), n: 1 };

const log = [
  ev(0, "EXECUTION_STARTED", { input: {} }),
  ev(1, "STEP_STARTED", { stepId: "a", input }),
  ev(2, "STEP_COMPLETED", { stepId: "a", output: { y: 1 } }),
  ev(3, "STEP_STARTED", { stepId: "b", input }),
  ev(4, "STEP_FAILED", { stepId: "b", error: "boom" }),
  ev(5, "STEP_STARTED", { stepId: "c", input }),
  ev(6, "STEP_CANCELLED", { stepId: "c" }),
  ev(7, "STEP_STARTED", { stepId: "d", input }),
  ev(8, "STEP_RETRYING", { stepId: "d", attempt: 2 }),
  ev(9, "STEP_STARTED", { stepId: "e", input }),
];

describe("the fold drops a settled frame's input", () => {
  const state = foldEvents(log, INITIAL);

  it("completed, failed and cancelled frames have no input", () => {
    for (const id of ["a", "b", "c"]) {
      expect(state.frames[id]?.input, id).toBeUndefined();
      expect("input" in (state.frames[id] ?? {}), id).toBe(false);
    }
    expect(state.frames.a?.output).toEqual({ y: 1 }); // everything else is kept
    expect(state.frames.b?.status).toBe("failed");
  });

  it("running and retrying frames keep theirs", () => {
    expect(state.frames.d?.input).toEqual(input);
    expect(state.frames.e?.input).toEqual(input);
  });

  it("normalizeSnapshotState strips old snapshots in one pass; fold(snapshot, tail) == fold(events)", () => {
    // what a pre-1.26 fold wrote: inputs on every frame, settled included
    const old = structuredClone(state) as ExecutionState;
    for (const id of ["a", "b", "c"]) old.frames[id] = { ...old.frames[id]!, input };
    const normalized = normalizeSnapshotState(old);
    expect(normalized.frames).toEqual(state.frames);
    expect(normalized.frames.d?.input).toEqual(input); // in flight: kept
    // a snapshot with nothing to strip is returned as is
    expect(normalizeSnapshotState(state)).toBe(state);
    // the equivalence under a tail that settles the in-flight frames
    const tail = [
      ev(10, "STEP_COMPLETED", { stepId: "d", output: 1 }),
      ev(11, "STEP_COMPLETED", { stepId: "e", output: 2 }),
    ];
    const viaSnapshot = foldEvents(tail, normalizeSnapshotState({ ...old, sequence: 9 }));
    const direct = foldEvents([...log, ...tail], INITIAL);
    expect(viaSnapshot.frames).toEqual(direct.frames);
  });
});
