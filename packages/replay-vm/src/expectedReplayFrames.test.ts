import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";

const EXEC = "exec-frames";
const ev = (sequence: number, eventType: string, payload: unknown = {}): EventEnvelope => ({
  id: `${EXEC}-${sequence}`,
  workflowId: "wf",
  executionId: EXEC,
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
});
const done = (seq: number, stepId: string): EventEnvelope[] => [
  ev(seq, "STEP_STARTED", { stepId, input: {} }),
  ev(seq + 1, "STEP_COMPLETED", { stepId, output: 1 }),
];

// ADR 0113 D3 — the replay-divergence detector's baseline: the completed frames a re-run must ask for,
// minus those recorded before the execution's last EXECUTION_MIGRATED.
describe("ReplayVM.expectedReplayFrames", () => {
  const log = [
    ev(0, "EXECUTION_STARTED", { input: {} }),
    ...done(1, "a"),
    ...done(3, "b"),
    ev(5, "STEP_STARTED", { stepId: "running", input: {} }), // not completed: not expected
    ev(6, "STEP_STARTED", { stepId: "failed", input: {} }),
    ev(7, "STEP_FAILED", { stepId: "failed", error: "x" }),
  ];

  it("is every COMPLETED frame when the execution was never migrated", () => {
    expect(new ReplayVM(log).expectedReplayFrames().sort()).toEqual(["a", "b"]);
  });

  it("resets at EXECUTION_MIGRATED: only frames completed after it count", () => {
    const migrated = [...log, ev(8, "EXECUTION_MIGRATED", { toFlowId: "wf" }), ...done(9, "c")];
    expect(new ReplayVM(migrated).expectedReplayFrames()).toEqual(["c"]);
  });

  it("tracks a migration applied live (applyEvent), as resumeAs commits it", () => {
    const vm = new ReplayVM(log);
    vm.applyEvent(ev(8, "EXECUTION_MIGRATED", { toFlowId: "wf" }));
    expect(vm.expectedReplayFrames()).toEqual([]);
    for (const e of done(9, "c")) vm.applyEvent(e);
    expect(vm.expectedReplayFrames()).toEqual(["c"]);
  });

  it("a snapshot taken after a migration is conservative: only the tail's completions count", () => {
    const head = new ReplayVM([
      ...log,
      ev(8, "EXECUTION_MIGRATED", { toFlowId: "wf" }),
      ...done(9, "c"),
    ]).getState();
    const tail = done(11, "d");
    const vm = new ReplayVM(tail, head);
    expect(vm.expectedReplayFrames()).toEqual(["d"]); // `c` is in the snapshot: when it ran is unknown
  });
});
