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
    // Every checkpoint is on the configured cadence.
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
