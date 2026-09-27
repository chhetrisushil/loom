import type { EventEnvelope, ExecutionState } from "@loom/core";
import { foldEvents } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { classifyStrayPassthroughs, inspectStrayPassthroughs } from "./strayPassthroughs";

// ADR 0104 D2 — which pre-0104 logs carry a passthrough that answered no gate, and whether
// it is already spent. Pure over (retained log, folded state).

let seq = 0;
const ev = (eventType: string, payload: unknown = {}): EventEnvelope => ({
  id: `x-${++seq}`,
  workflowId: "f",
  executionId: "x",
  eventType,
  sequence: seq,
  timestamp: 1000 + seq,
  payload,
});
const park = (on: string) => ev("EXECUTION_SUSPENDED", { condition: { on } });
const INITIAL = { executionId: "x", workflowId: "f", workflowVersion: "1.0.0" };
const classify = (events: EventEnvelope[], state?: ExecutionState) =>
  classifyStrayPassthroughs(events, state ?? foldEvents(events, INITIAL));

describe("classifyStrayPassthroughs", () => {
  it("a clean log (every entry answers a gate park) says nothing", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      park("go1"),
      ev("go1"),
      ev("EXECUTION_RESUMED", { ok: 1 }),
    ];
    expect(classify(log)).toBeUndefined();
  });

  it("a legacy recovery pair after the last gate park, still running: at-risk", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED", { stepId: "a" }),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
    ];
    expect(classify(log)).toEqual({ kind: "at-risk", count: 1 });
  });

  it("the same pair followed by a gate park: provably spent — passed", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
      park("go2"),
    ];
    expect(classify(log)).toEqual({ kind: "passed", count: 1 });
  });

  it("an in-doubt park is NOT a gate park: a stray before it is still at-risk", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
      park("EffectInDoubtResolved"),
      ev("EffectInDoubtResolved"),
      // a legacy verdict: itself a stray (the in-doubt park is not a suspend point)
      ev("EXECUTION_RESUMED", { stepId: "a", resolution: "retry-fresh" }),
    ];
    expect(classify(log)).toEqual({ kind: "at-risk", count: 2 });
  });

  it("strays in an execution that has since terminated are harmless", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
      ev("EXECUTION_COMPLETED", { output: {} }),
    ];
    expect(classify(log)).toBeUndefined();
  });

  it("a 0104 status-only resume (null) is not an entry, so not a stray", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_FAILED", { error: "x" }),
      ev("EXECUTION_MIGRATED", { toFlowId: "g" }),
      ev("EXECUTION_RESUMED", null),
    ];
    expect(classify(log)).toBeUndefined();
  });

  it("entries the retained log cannot explain (prefix truncated) holding {}: unverifiable", () => {
    seq = 0;
    const full = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
      ev("STEP_STARTED", { stepId: "b" }),
    ];
    const state = foldEvents(full, INITIAL); // what the snapshot holds
    const retained = [full[0]!, full[3]!]; // truncatePrefix keeps EXECUTION_STARTED + tail
    expect(classify(retained, state)).toEqual({ kind: "unverifiable", count: 1 });
    // …but a gate park in the retained tail proves every earlier entry spent.
    const parked = [...retained, park("go1")];
    expect(classify(parked, foldEvents([...full, parked[2]!], INITIAL))).toBeUndefined();
  });
});

describe("human parks prove nothing consumed (ADR 0104, fix round 2)", () => {
  const kindOfStep = (id: string) => (id === "h" ? "human" : "tool");
  const inspect = (events: EventEnvelope[]) =>
    inspectStrayPassthroughs(events, foldEvents(events, INITIAL), { kindOfStep });

  it("a pre-0104 recovery {} before a HUMAN park stays at-risk, and the human step is ambiguous", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
      ev("STEP_STARTED", { stepId: "h" }),
      park("Approve"),
    ];
    expect(classifyStrayPassthroughs(log, foldEvents(log, INITIAL))).toEqual({
      kind: "passed",
      count: 1,
    }); // what a human-blind pass concludes — wrong
    expect(inspect(log)).toEqual({
      verdict: { kind: "at-risk", count: 1 },
      ambiguousHumanStep: "h",
    });
  });

  it("a human step the old kernel re-parked after an answer: its answers are at-risk, it is ambiguous", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED", { stepId: "h" }),
      park("Approve"),
      ev("Approve", { n: 1 }),
      ev("EXECUTION_RESUMED", { n: 1 }),
      ev("STEP_STARTED", { stepId: "h" }),
      park("Approve"),
    ];
    expect(inspect(log)).toEqual({
      verdict: { kind: "at-risk", count: 1 },
      ambiguousHumanStep: "h",
    });
  });

  it("a 0104 human step (parked once, answered, completed) is clean", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED", { stepId: "h" }),
      park("Approve"),
      ev("Approve", { n: 1 }),
      ev("EXECUTION_RESUMED", { n: 1 }),
      ev("STEP_COMPLETED", { stepId: "h", output: { n: 1 } }),
      park("go1"),
    ];
    expect(inspect(log)).toEqual({});
  });

  it("a terminal execution's unspent stray is judged live when it is being re-opened", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
      ev("EXECUTION_FAILED", { error: "x" }),
    ];
    const state = foldEvents(log, INITIAL);
    expect(inspectStrayPassthroughs(log, state)).toEqual({});
    expect(inspectStrayPassthroughs(log, state, { reopening: true })).toEqual({
      verdict: { kind: "at-risk", count: 1 },
    });
  });
});

describe("the runtime warns once per execution and verdict (ADR 0104)", () => {
  it("at-risk on the recovery that will spend it, passed afterwards, then silence", async () => {
    const { EffectRuntime } = await import("@loom/effect-runtime");
    const { InMemoryAsyncEventStore } = await import("@loom/event-runtime");
    const { InMemoryAsyncSnapshotStore } = await import("@loom/snapshot-runtime");
    const { WorkflowRuntime } = await import("./WorkflowRuntime");
    const { z } = await import("zod");
    const io = z.object({}).passthrough();
    const eventStore = new InMemoryAsyncEventStore();
    const warnings: string[] = [];
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onWarn: (m) => warnings.push(m),
    });
    const definition = {
      _tag: "FlowDefinition" as const,
      id: "g3",
      name: "g3",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
    };
    runtime.registerFlow(definition, async (ctx) => {
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      await ctx.suspend({ on: "go3" });
      return {};
    });
    // A crashed execution (started, never ran its runner) plus the pre-0104 recovery pair.
    const base = { workflowId: "g3", executionId: "x", timestamp: Date.now() };
    await eventStore.append({
      ...base,
      id: "x-1",
      sequence: 1,
      eventType: "EXECUTION_STARTED",
      payload: { input: {} },
    });
    await eventStore.append({
      ...base,
      id: "x-2",
      sequence: 2,
      eventType: "EXECUTION_RECOVERED",
      payload: {},
    });
    await eventStore.append({
      ...base,
      id: "x-3",
      sequence: 3,
      eventType: "EXECUTION_RESUMED",
      payload: {},
    });

    const recovered = await runtime.resume("x", { eventType: "EXECUTION_RECOVERED", payload: {} });
    expect((await recovered.waitForSuspend()).suspendedOn?.on).toBe("go2"); // go1 passed with {}
    const g2 = await runtime.resume("x", { eventType: "go2", payload: {} });
    await g2.waitForSuspend();
    const g3 = await runtime.resume("x", { eventType: "go3", payload: {} });
    await g3.waitForCompletion();

    const ours = warnings.filter((w) => w.includes("ADR 0104"));
    expect(ours).toHaveLength(2);
    expect(ours[0]).toMatch(/NOT yet spent/);
    expect(ours[1]).toMatch(/already served/);
  });
});

// ADR 0105 — EVENT_SCHEMA 1.20.0 folded a parallel sibling's STEP_FAILED after a park to
// "failed", so its `resumeAs` recorded a status-only EXECUTION_RESUMED(null) there. Since 1.21.0
// that execution reads `suspended`, and the same null answers the parked gate.
describe("inspectStrayPassthroughs — a null resume after a late sibling failure (ADR 0105)", () => {
  const inspect = (events: EventEnvelope[]) =>
    inspectStrayPassthroughs(events, foldEvents(events, INITIAL));

  it("flags the 1.20.0 resumeAs shape: park, sibling STEP_FAILED, EXECUTION_MIGRATED, null resume", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED", { stepId: "slow" }),
      park("Approval"),
      ev("STEP_FAILED", { stepId: "slow", error: "late boom" }),
      ev("EXECUTION_MIGRATED", { toFlowId: "f", strategy: "replay-check" }),
      ev("Fixup", { note: "operator" }),
      ev("EXECUTION_RESUMED", null),
    ];
    expect(inspect(log).ambiguousNullResumes).toBe(1);
  });

  it("negative: a null answer to a park with no failure while parked is an ordinary answer", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      park("Approval"),
      ev("Approval", null),
      ev("EXECUTION_RESUMED", null),
    ];
    expect(inspect(log).ambiguousNullResumes).toBeUndefined();
  });

  it("negative: a non-null answer after a late sibling failure is unambiguous", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      park("Approval"),
      ev("STEP_FAILED", { stepId: "slow", error: "late boom" }),
      ev("Approval", { ok: true }),
      ev("EXECUTION_RESUMED", { ok: true }),
    ];
    expect(inspect(log).ambiguousNullResumes).toBeUndefined();
  });

  it("negative: a failure BEFORE the park does not taint the park's answer", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_FAILED", { stepId: "a", error: "caught" }),
      park("Approval"),
      ev("EXECUTION_RESUMED", null),
    ];
    expect(inspect(log).ambiguousNullResumes).toBeUndefined();
  });
});
