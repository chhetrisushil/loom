import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

class CountingSnapshotStore implements SnapshotStore {
  readonly saves: Snapshot[] = [];
  async save(s: Snapshot): Promise<void> {
    this.saves.push(s);
  }
  async loadLatest(id: string): Promise<Snapshot | null> {
    const m = this.saves.filter((s) => s.executionId === id);
    return m.length ? (m[m.length - 1] ?? null) : null;
  }
  async loadAt(): Promise<Snapshot | null> {
    return null;
  }
  async loadLatestBefore(): Promise<Snapshot | null> {
    return null;
  }
  async close(): Promise<void> {}
}

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const STEPS = Array.from({ length: 6 }, (_, i) =>
  step$({ id: `s${i}`, name: `S${i}`, toolId: "t", ...io })
);
const runner: FlowRunner<unknown, { done: boolean }> = async (ctx) => {
  for (const s of STEPS) await ctx.run(s, {});
  return { done: true };
};
const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "long",
    name: "Long",
    version: "1.0.0",
    ...io,
    steps: STEPS,
  },
  runner,
} as RegisteredFlow;

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("snapshot cadence (bounds the replay tail)", () => {
  it("takes mid-run snapshots every N events when snapshotEvery is set", async () => {
    const effects = new EffectRuntime();
    effects.register("t", new ToolEffect(async () => ({})));
    const snapshotStore = new CountingSnapshotStore();
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore,
      effectRuntime: effects,
      snapshotEvery: 3,
    });
    runtime.registerFlow(flow.definition, flow.runner);

    const state = await (await runtime.start(flow, {})).waitForCompletion();
    await tick(); // let fire-and-forget checkpoint saves drain

    expect(state.status).toBe("completed");
    // 6 steps ⇒ 14 events (started + 6×2 + completed); every 3 ⇒ several checkpoints.
    expect(snapshotStore.saves.length).toBeGreaterThan(0);
    // At least one checkpoint was mid-run (sequence strictly before the terminal one).
    const maxSaved = Math.max(...snapshotStore.saves.map((s) => s.sequence));
    expect(maxSaved).toBeLessThan(state.sequence);
    // Every checkpoint is on the configured cadence. (14 events, every 3 ⇒ the terminal
    // tail is 1, short of the cadence, so no settle checkpoint is added here either.)
    for (const s of snapshotStore.saves) expect(s.sequence % 3).toBe(0);
  });

  it("takes NO mid-run snapshots by default (snapshotEvery unset)", async () => {
    const effects = new EffectRuntime();
    effects.register("t", new ToolEffect(async () => ({})));
    const snapshotStore = new CountingSnapshotStore();
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore,
      effectRuntime: effects,
    });
    runtime.registerFlow(flow.definition, flow.runner);

    await (await runtime.start(flow, {})).waitForCompletion();
    await tick();
    expect(snapshotStore.saves).toHaveLength(0); // unchanged default behavior
  });
});

// ── The pathological case the exact-multiple trigger could not handle ─────────
//
// A snapshot store slow relative to the commit rate. The execution races to completion
// inside the window of a single in-flight save, so the cadence trigger fires at most once
// however long the log gets — and fixing the trigger alone does not help, because by the
// time the save resolves there are no commits left to trigger on. What bounds the read is
// the settle-time checkpoint.

class SlowSnapshotStore implements SnapshotStore {
  readonly saves: Snapshot[] = [];
  constructor(private readonly delayMs: number) {}
  async save(s: Snapshot): Promise<void> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.saves.push(s);
  }
  async loadLatest(id: string): Promise<Snapshot | null> {
    const m = this.saves
      .filter((s) => s.executionId === id)
      .sort((a, b) => a.sequence - b.sequence);
    return m.length ? (m[m.length - 1] ?? null) : null;
  }
  async loadAt(): Promise<Snapshot | null> {
    return null;
  }
  async loadLatestBefore(): Promise<Snapshot | null> {
    return null;
  }
  async close(): Promise<void> {}
}

const LONG_STEPS = Array.from({ length: 40 }, (_, i) =>
  step$({ id: `L${i}`, name: `L${i}`, toolId: "t", ...io })
);
const longFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "very-long",
    name: "Very Long",
    version: "1.0.0",
    ...io,
    steps: LONG_STEPS,
  },
  runner: async (ctx) => {
    for (const s of LONG_STEPS) await ctx.run(s, {});
    return { done: true };
  },
} as RegisteredFlow;

describe("snapshot cadence — an execution faster than its snapshot store", () => {
  const runLong = async (snapshotStore: SnapshotStore) => {
    const effects = new EffectRuntime();
    effects.register("t", new ToolEffect(async () => ({})));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore,
      effectRuntime: effects,
      snapshotEvery: 2,
    });
    runtime.registerFlow(longFlow.definition, longFlow.runner);
    const state = await (await runtime.start(longFlow, {})).waitForCompletion();
    await tick();
    return state;
  };

  it("checkpoints at the tip on completion, so a settled execution folds a bounded tail", async () => {
    const snapshotStore = new SlowSnapshotStore(15);
    const state = await runLong(snapshotStore);
    // 40 steps ⇒ 82 events. The cadence trigger manages at most one save in that window.
    expect(state.sequence).toBe(81);
    const latest = await snapshotStore.loadLatest(state.executionId);
    expect(latest).not.toBeNull();
    // The point: whatever cadence managed, the settled execution has a checkpoint AT the
    // tip, so a later read folds an empty tail instead of the whole log.
    expect(latest?.sequence).toBe(state.sequence);
  });

  it("does not add a settle checkpoint when the tail is shorter than the cadence", async () => {
    // The 6-step flow is 14 events (sequences 0..13). With snapshotEvery 8 the cadence
    // fires once, at sequence 8; the remaining tail is 5, short of the cadence, so
    // completion adds NOTHING. The extra write lands only where it would pay.
    const snapshotStore = new SlowSnapshotStore(0);
    const effects = new EffectRuntime();
    effects.register("t", new ToolEffect(async () => ({})));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore,
      effectRuntime: effects,
      snapshotEvery: 8,
    });
    runtime.registerFlow(flow.definition, flow.runner);
    const state = await (await runtime.start(flow, {})).waitForCompletion();
    await tick();
    expect(state.sequence).toBe(13);
    expect(snapshotStore.saves.map((s) => s.sequence)).toEqual([8]);
    // Specifically: no checkpoint at the terminal sequence.
    expect(snapshotStore.saves.some((s) => s.sequence === state.sequence)).toBe(false);
  });

  it("stays inert when snapshotEvery is unset, even on a long execution", async () => {
    const snapshotStore = new SlowSnapshotStore(0);
    const effects = new EffectRuntime();
    effects.register("t", new ToolEffect(async () => ({})));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore,
      effectRuntime: effects,
    });
    runtime.registerFlow(longFlow.definition, longFlow.runner);
    await (await runtime.start(longFlow, {})).waitForCompletion();
    await tick();
    expect(snapshotStore.saves).toHaveLength(0); // unchanged default behavior
  });
});
