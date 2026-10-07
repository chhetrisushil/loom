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

// ADR 0113 (fix round 1) — additive fold fields, and the reserved refusal gate.
describe("ADR 0113 additive fold shapes", () => {
  const kernel = { kernel: true };
  const withMeta = (e: EventEnvelope, metadata: Record<string, unknown>): EventEnvelope => ({
    ...e,
    metadata,
  });

  it("DECISION_RECORDED.innerSteps folds ONLY from a kernel-stamped envelope", () => {
    const rec = (meta?: Record<string, unknown>): EventEnvelope => {
      const e = ev(1, "DECISION_RECORDED", {
        decisionId: "d",
        choice: 1,
        innerSteps: ["a", 7, "b"],
      });
      return meta === undefined ? e : withMeta(e, meta);
    };
    const stamped = new ReplayVM([ev(0, "EXECUTION_STARTED", { input: {} }), rec(kernel)]);
    expect(stamped.getDecisionInnerSteps("d")).toEqual(["a", "b"]);
    const plain = new ReplayVM([ev(0, "EXECUTION_STARTED", { input: {} }), rec()]);
    expect(plain.getDecisionInnerSteps("d")).toBeUndefined();
    expect(plain.getDecision("d")).toBe(1); // the choice is unaffected either way
  });

  it("EXECUTION_MIGRATED.toCodeHash re-points _codeHash ('' clears it); absent leaves it", () => {
    const base = [ev(0, "EXECUTION_STARTED", { input: {}, codeHash: "fp1" })];
    const fold = (p: Record<string, unknown>) =>
      new ReplayVM([...base, ev(1, "EXECUTION_MIGRATED", { toFlowId: "wf", ...p })]).getState()
        .variables._codeHash;
    expect(fold({ toCodeHash: "fp2" })).toBe("fp2");
    expect(fold({ toCodeHash: "" })).toBe("");
    expect(fold({})).toBe("fp1");
  });

  it("a null resume of the reserved refusal gate is status-only (never enters _resumePayloads)", () => {
    const parked = [
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "EXECUTION_SUSPENDED", { condition: { on: "__loom_diverged__" } }),
    ];
    const resumed = new ReplayVM([...parked, ev(2, "EXECUTION_RESUMED", null)]).getState();
    expect(resumed.status).toBe("running");
    expect(resumed.variables._resumePayloads).toBeUndefined();
    // an ordinary gate with a null answer IS recorded (the contrast)
    const other = new ReplayVM([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "EXECUTION_SUSPENDED", { condition: { on: "go" } }),
      ev(2, "EXECUTION_RESUMED", null),
    ]).getState();
    expect(other.variables._resumePayloads).toEqual([null]);
  });
});
