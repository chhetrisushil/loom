import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// L11 (ADR 0106) — compaction must be invisible to everything that reads the log afterwards:
// a resume across one compaction, or two, produces the same log suffix and the same state as
// the same execution never compacted; the checkpoint names its execution; and an app's
// pinned event kinds survive it (ADR 0055 D1).

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema: io, outputSchema: io });

const FLOW = "compaction-flow";
const FINDING = "FINDING_RECORDED";

const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: FLOW,
  name: FLOW,
  version: "2.3.0",
  inputSchema: io,
  outputSchema: io,
  steps: [s1, s2, s3],
};

const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  const a = await ctx.run(s1, input);
  ctx.emit(FINDING, { finding: "f1" });
  await ctx.suspend({ on: "go1" });
  const b = await ctx.run(s2, a);
  await ctx.suspend({ on: "go2" });
  const c = await ctx.run(s3, b);
  return { n: c.n };
};

function boot() {
  const calls = { t1: 0, t2: 0, t3: 0 };
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"] as const) {
    effects.register(
      id,
      new ToolEffect(async (x: { n: number }) => {
        calls[id]++;
        return { n: x.n + 1 };
      })
    );
  }
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
  });
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, snapshotStore, calls };
}

type App = ReturnType<typeof boot>;

async function toFirstGate(app: App, id: string): Promise<void> {
  const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: id });
  await h.waitForSuspend();
}

async function resume(app: App, id: string, on: string) {
  const h = await app.runtime.resume(id, { eventType: on, payload: {} });
  return on === "go2" ? h.waitForCompletion() : h.waitForSuspend();
}

/** The events of `log` above `floor`, keyed for comparison with the uncompacted control. */
const above = (log: EventEnvelope[], floor: number) => log.filter((e) => e.sequence > floor);

async function control() {
  const app = boot();
  await toFirstGate(app, "e");
  const atGate1 = await app.runtime.loadState("e");
  await resume(app, "e", "go1");
  const atGate2 = await app.runtime.loadState("e");
  await resume(app, "e", "go2");
  const done = await app.runtime.loadState("e");
  return { log: await app.eventStore.read("e"), atGate1, atGate2, done, calls: app.calls };
}

describe("L11 (a) — resume after compaction", () => {
  it("a resume across a compaction lands in the execution's own log and folds identically", async () => {
    const want = await control();
    const app = boot();
    await toFirstGate(app, "e");
    const through = await new LogLifecycle(app.eventStore, app.snapshotStore).compact("e");
    expect(through).not.toBeNull();

    await resume(app, "e", "go1");
    // Nothing was written anywhere but the execution's own log.
    expect(await app.eventStore.read("")).toEqual([]);
    const log = await app.eventStore.read("e");
    const gate2Tip = want.atGate2!.sequence;
    expect(above(log, through!)).toEqual(
      above(want.log, through!).filter((e) => e.sequence <= gate2Tip)
    );
    expect(await app.runtime.loadState("e")).toEqual(want.atGate2);
  });

  it("two compactions, a resume across each — same final log suffix, state and effect count", async () => {
    const want = await control();
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    await toFirstGate(app, "e");
    await life.compact("e");
    await resume(app, "e", "go1");
    const second = await life.compact("e");
    expect(second).toBe(want.atGate2!.sequence);

    // The second checkpoint folded ON the first: s1's recorded output survives, so the
    // resumed runner serves it from the fold instead of re-running the effect.
    const checkpoint = await app.snapshotStore.loadLatest("e");
    expect(checkpoint!.state).toEqual(want.atGate2);

    await resume(app, "e", "go2");
    expect(app.calls).toEqual(want.calls);
    expect(above(await app.eventStore.read("e"), second!)).toEqual(above(want.log, second!));
    expect(await app.runtime.loadState("e")).toEqual(want.done);
  });

  it("refuses to compact a gapped log whose checkpoint is missing (the fold would be wrong)", async () => {
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    await toFirstGate(app, "e");
    await life.compact("e");
    await resume(app, "e", "go1");
    await app.snapshotStore.deleteExecution!("e");
    const before = await app.eventStore.read("e");
    await expect(life.compact("e")).rejects.toThrow(/checkpoint/);
    expect(await app.eventStore.read("e")).toEqual(before);
  });
});

describe("L11 (b) — the checkpoint names its execution", () => {
  it("seeds executionId/workflowId from the log, not empty strings", async () => {
    const app = boot();
    const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: "b1" });
    await h.waitForSuspend();
    await new LogLifecycle(app.eventStore, app.snapshotStore).compact("b1");
    const snap = await app.snapshotStore.loadLatest("b1");
    expect(snap!.state.executionId).toBe("b1");
    expect(snap!.state.workflowId).toBe(FLOW);
    // The suspend checkpoint the runtime took carried the version; compaction keeps it.
    expect(snap!.state.workflowVersion).toBe("2.3.0");
  });

  it("a checkpoint with blank identity (written before the fix) still resumes into its own log", async () => {
    const want = await control();
    const app = boot();
    await toFirstGate(app, "e");
    const tip = (await app.eventStore.head("e"))!;
    const state = (await app.runtime.loadState("e"))!;
    await app.snapshotStore.save({
      id: "legacy",
      executionId: "e",
      workflowId: FLOW,
      sequence: tip,
      state: { ...state, executionId: "", workflowId: "", workflowVersion: "" },
      createdAt: 0,
    });
    await app.eventStore.truncatePrefix("e", tip);
    await resume(app, "e", "go1");
    expect(await app.eventStore.read("")).toEqual([]);
    expect(await app.runtime.loadState("e")).toEqual(want.atGate2);
  });
});

describe("L11 (c) — pinned event kinds survive compaction (ADR 0055 D1)", () => {
  it("keeps every pinned-kind event through two compactions; the fold is unchanged", async () => {
    const want = await control();
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    await toFirstGate(app, "e");
    const finding = (await app.eventStore.read("e")).find((e) => e.eventType === FINDING)!;
    await life.compact("e");
    expect((await app.eventStore.read("e")).filter((e) => e.eventType === FINDING)).toEqual([
      finding,
    ]);
    await resume(app, "e", "go1");
    await life.compact("e");
    await resume(app, "e", "go2");

    const log = await app.eventStore.read("e");
    expect(log.filter((e) => e.eventType === FINDING)).toEqual([finding]);
    expect(await app.runtime.loadState("e")).toEqual(want.done);
    expect(app.calls).toEqual(want.calls);
  });

  it("a pinned execution is not compacted when no pinned event kinds are declared", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    const before = await app.eventStore.read("e");
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, { pinned: () => true });
    expect(await life.compact("e")).toBeNull();
    expect(await app.eventStore.read("e")).toEqual(before);
  });
});

describe("L11 (c) — the edges of keeping pinned kinds", () => {
  it("on a store without truncatePrefixKeeping, compaction stops below the first kept event — shorter, never lossy", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    const inner = app.eventStore;
    // The SPI 1.4.0 surface: truncatePrefix, no truncatePrefixKeeping.
    const legacy = {
      append: inner.append.bind(inner),
      read: inner.read.bind(inner),
      readFrom: inner.readFrom.bind(inner),
      subscribe: inner.subscribe.bind(inner),
      close: inner.close.bind(inner),
      truncatePrefix: inner.truncatePrefix.bind(inner),
    };
    const before = await inner.read("e");
    const finding = before.find((e) => e.eventType === FINDING)!;
    const life = new LogLifecycle(legacy, app.snapshotStore, { pinnedEventTypes: [FINDING] });
    const through = await life.compact("e");
    expect(through).toBe(finding.sequence - 1);
    const after = await inner.read("e");
    expect(after.map((e) => e.sequence)).toEqual(
      before.filter((e) => e.sequence === 0 || e.sequence > through!).map((e) => e.sequence)
    );
    // A second pass has nothing more it can safely take.
    expect(await life.compact("e")).toBeNull();
    await resume(app, "e", "go1");
    await resume(app, "e", "go2");
    expect((await app.runtime.loadState("e"))?.status).toBe("completed");
  });

  it("refuses kernel event kinds as pinnedEventTypes", () => {
    const app = boot();
    expect(
      () =>
        new LogLifecycle(app.eventStore, app.snapshotStore, {
          pinnedEventTypes: [FINDING, "STEP_COMPLETED"],
        })
    ).toThrow(/STEP_COMPLETED/);
  });

  it("retention reads a log compacted past a kept event at its tip as the terminal execution it is", async () => {
    const app = boot();
    const at = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
      id: `r-${sequence}`,
      workflowId: FLOW,
      executionId: "r",
      eventType,
      sequence,
      timestamp: 10,
      payload,
    });
    await app.eventStore.append(at(0, "EXECUTION_STARTED", { input: { n: 1 } }));
    await app.eventStore.append(at(1, FINDING, { finding: "f" }));
    await app.eventStore.append(at(2, "EXECUTION_COMPLETED", { output: { n: 1 } }));
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    expect(await life.compact("r")).toBe(2);
    // [0, 1] is CONTIGUOUS, yet compacted: the checkpoint at 2 holds the completion.
    expect((await app.eventStore.read("r")).map((e) => e.sequence)).toEqual([0, 1]);
    expect(await life.evaluate("r", { terminalTtlMs: 0 }, 1_000)).toBe("reclaimable");
    expect(await life.compact("r")).toBeNull();
  });
});
