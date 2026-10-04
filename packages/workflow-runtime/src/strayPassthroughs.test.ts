import type { EventEnvelope, ExecutionState } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import {
  StrayScanner,
  classifyStrayPassthroughs,
  inspectStrayPassthroughs,
} from "./strayPassthroughs";

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
  // The runtime is imported at the top of the file, not inside this test (L18). Its work here
  // is ~3 ms; loading it — WorkflowRuntime's whole source graph through vite's transform — is
  // 250–600 ms on a busy host and measured past 5 s under a saturated full-suite run, and a
  // dynamic import inside the body charged all of it to this test's hang detector. At module
  // scope it is collection cost, which vitest does not time out.
  it("at-risk on the recovery that will spend it, passed afterwards, then silence", async () => {
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

// ADR 0105 — the mirror follows the fold's `_failedWhileParked` rule: a `null` resume after a
// STEP_FAILED that landed while parked is status-only (as 1.20.0 folded it), so it is no entry,
// no stray and no human step's answer.
describe("inspectStrayPassthroughs — the fail-closed null after a late sibling failure (ADR 0105)", () => {
  const kindOfStep = (id: string) => (id === "h" ? "human" : "tool");
  const inspect = (events: EventEnvelope[]) =>
    inspectStrayPassthroughs(events, foldEvents(events, INITIAL), { kindOfStep });

  it("the 1.20.0 resumeAs shape is clean: the null answered nothing, and the mirror agrees with the fold", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED", { stepId: "slow" }),
      park("Approval"),
      ev("STEP_FAILED", { stepId: "slow", error: "late boom" }),
      ev("EXECUTION_MIGRATED", { toFlowId: "f", strategy: "operator-ack" }),
      ev("Fixup", { note: "operator" }),
      ev("EXECUTION_RESUMED", null),
      park("Approval"),
    ];
    expect(foldEvents(log, INITIAL).variables._resumePayloads).toBeUndefined();
    expect(inspect(log)).toEqual({});
  });

  it("at a HUMAN park the same null is not the step's answer, so nothing is ambiguous", () => {
    seq = 0;
    const humanPark = () =>
      ev("EXECUTION_SUSPENDED", { condition: { on: "Approve", stepId: "h" } });
    const log = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED", { stepId: "h" }),
      ev("STEP_STARTED", { stepId: "slow" }),
      humanPark(),
      ev("STEP_FAILED", { stepId: "slow", error: "late boom" }),
      ev("Fixup", { note: "operator" }),
      ev("EXECUTION_RESUMED", null),
      ev("STEP_STARTED", { stepId: "h" }),
      humanPark(),
    ];
    expect(inspect(log)).toEqual({});
  });

  it("negative: a null answer to a park with no failure while parked IS an entry (counted as answered)", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      park("Approval"),
      ev("Approval", null),
      ev("EXECUTION_RESUMED", null),
    ];
    expect(foldEvents(log, INITIAL).variables._resumePayloads).toEqual([null]);
    expect(inspect(log)).toEqual({});
  });
});

describe("StrayScanner is resumable (R1a)", () => {
  it("feeding a log in two pieces reports exactly what one whole pass reports, at every cut", () => {
    seq = 0;
    const logs: EventEnvelope[][] = [
      [
        ev("EXECUTION_STARTED"),
        ev("STEP_STARTED", { stepId: "h" }),
        park("Approve"),
        ev("EXECUTION_RESUMED", { by: "a" }),
        ev("STEP_STARTED", { stepId: "h" }),
        park("Approve"),
      ],
      [
        ev("EXECUTION_STARTED"),
        park("go0"),
        ev("EXECUTION_RESUMED", { ok: 1 }),
        ev("EXECUTION_RECOVERED"),
        ev("EXECUTION_RESUMED", {}),
        ev("STEP_STARTED", { stepId: "h" }),
        park("Approve"),
      ],
      [ev("EXECUTION_STARTED"), park("go1"), ev("EXECUTION_RESUMED", { ok: 1 })],
    ];
    const kindOfStep = () => "human";
    for (const log of logs) {
      const state = foldEvents(log, INITIAL);
      const whole = inspectStrayPassthroughs(log, state, { kindOfStep });
      for (let cut = 0; cut <= log.length; cut++) {
        const scanner = new StrayScanner(kindOfStep);
        scanner.feed(log.slice(0, cut));
        scanner.feed(log.slice(cut));
        expect(scanner.report(state)).toEqual(whole);
        expect(scanner.through).toBe(log.at(-1)?.sequence);
      }
    }
  });

  it("re-feeding events it has already seen changes nothing (concurrent resumes share a scanner)", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED"),
      park("go0"),
      ev("EXECUTION_RESUMED", { ok: 1 }),
      ev("EXECUTION_RECOVERED"),
      ev("EXECUTION_RESUMED", {}),
    ];
    const kindOfStep = () => "human";
    const state = foldEvents(log, INITIAL);
    const whole = inspectStrayPassthroughs(log, state, { kindOfStep });
    const scanner = new StrayScanner(kindOfStep);
    scanner.feed(log.slice(0, 3));
    scanner.feed(log.slice(2)); // overlaps: event 3 again
    scanner.feed(log.slice(2)); // and again
    expect(scanner.report(state)).toEqual(whole);
  });
});
