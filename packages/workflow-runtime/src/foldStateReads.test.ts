import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// `foldState` reads: snapshot first, then a BOUNDED tail — never the whole log.
//
// The regression these pin is a performance one with a correctness trap attached. Reading
// the full log up front made snapshots bound fold CPU but not I/O; removing that read
// naively resurrects swept executions, because LogLifecycle's
// `snapshotStore.deleteExecution?.()` is optional and can leave an orphaned snapshot.

/** An EventStore that counts calls and the rows each read returned. */
function countingStore(inner: EventStore) {
  const calls = { read: 0, readFrom: 0, readRange: 0 };
  let rowsRead = 0;
  const store: EventStore = {
    append: (e) => inner.append(e),
    read: async (id) => {
      calls.read++;
      const rows = await inner.read(id);
      rowsRead += rows.length;
      return rows;
    },
    readFrom: async (id, from) => {
      calls.readFrom++;
      const rows = await inner.readFrom(id, from);
      rowsRead += rows.length;
      return rows;
    },
    readRange: async (id, from, to) => {
      calls.readRange++;
      const rows = await inner.readRange!(id, from, to);
      rowsRead += rows.length;
      return rows;
    },
    subscribe: (id, h) => inner.subscribe(id, h),
    close: () => inner.close(),
  };
  return {
    store,
    calls,
    rows: () => rowsRead,
    reset: () => {
      calls.read = 0;
      calls.readFrom = 0;
      calls.readRange = 0;
      rowsRead = 0;
    },
  };
}

const io = z.object({ n: z.number() });

// Distinct step ids per iteration: step identity (ADR 0061) means a repeated `ctx.run`
// with the SAME id replays the existing frame rather than emitting another STEP_* pair,
// so reusing one step would produce a 4-event log however long the loop.
function benchFlow(steps: number): RegisteredFlow<{ n: number }, { n: number }> {
  const defs = Array.from({ length: steps }, (_, i) =>
    step$({ id: `s${i}`, name: `s${i}`, toolId: "tick-tool", inputSchema: io, outputSchema: io })
  );
  const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
    for (const [i, def] of defs.entries()) await ctx.run(def, { n: i });
    return input;
  };
  return {
    definition: {
      _tag: "FlowDefinition",
      id: `fold-reads-${steps}`,
      name: "Fold Reads",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: defs,
    },
    runner,
  };
}

function makeRuntime(eventStore: EventStore, snapshotStore: SnapshotStore, snapshotEvery?: number) {
  const effectRuntime = new EffectRuntime();
  effectRuntime.register("tick-tool", new ToolEffect(async (input) => input));
  return new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime,
    ...(snapshotEvery !== undefined && { snapshotEvery }),
  });
}

describe("foldState — bounded reads", () => {
  it("does NOT read the whole log when a snapshot covers it", async () => {
    const counting = countingStore(new InMemoryAsyncEventStore());
    const snapshots = new InMemoryAsyncSnapshotStore();
    // snapshotEvery: 2 over a 20-step flow → 42 events, snapshotted near the tip.
    const runtime = makeRuntime(counting.store, snapshots, 2);
    const flow = benchFlow(20);
    runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
    const handle = await runtime.start(flow, { n: 0 });
    await handle.waitForCompletion();

    const total = (await counting.store.read(handle.executionId)).length;
    expect(total).toBe(42); // 2*20 + 2

    counting.reset();
    const state = await runtime.loadState(handle.executionId);
    expect(state?.status).toBe("completed");

    // The whole point: no full-log read, and rows touched is a small bounded number —
    // one anchor row plus whatever tail the snapshot did not cover, NOT all 42.
    expect(counting.calls.read).toBe(0);
    expect(counting.rows()).toBeLessThan(total);
    expect(counting.rows()).toBeLessThanOrEqual(5);
  });

  it("stays O(1)-ish in reads as the log grows — the liveQuery compounding case", async () => {
    const measure = async (steps: number): Promise<number> => {
      const counting = countingStore(new InMemoryAsyncEventStore());
      const runtime = makeRuntime(counting.store, new InMemoryAsyncSnapshotStore(), 2);
      const flow = benchFlow(steps);
      runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
      const handle = await runtime.start(flow, { n: 0 });
      await handle.waitForCompletion();
      counting.reset();
      await runtime.loadState(handle.executionId);
      return counting.rows();
    };
    // A 4x longer log must not cost 4x the rows. Before the fix both were O(log).
    const short = await measure(10);
    const long = await measure(40);
    expect(long).toBeLessThanOrEqual(short + 2);
  });

  it("still returns null for an unknown execution", async () => {
    const runtime = makeRuntime(new InMemoryAsyncEventStore(), new InMemoryAsyncSnapshotStore());
    expect(await runtime.loadState("never-existed")).toBeNull();
  });

  it("returns null for a swept execution even when an ORPHANED snapshot survives", async () => {
    // The correctness trap. A retention sweep deletes events; LogLifecycle then calls
    // `snapshotStore.deleteExecution?.()`, which is OPTIONAL — so a store without it
    // leaves the snapshot behind. Folding that orphan would hand back erased state.
    const events = new InMemoryAsyncEventStore();
    const snapshots = new InMemoryAsyncSnapshotStore();
    const runtime = makeRuntime(events, snapshots, 2);
    const flow = benchFlow(4);
    runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
    const handle = await runtime.start(flow, { n: 0 });
    await handle.waitForCompletion();
    expect(await snapshots.loadLatest(handle.executionId)).not.toBeNull();

    // Sweep the events only — exactly what a snapshot store lacking deleteExecution leaves.
    await events.deleteExecution?.(handle.executionId);
    expect(await snapshots.loadLatest(handle.executionId)).not.toBeNull();

    expect(await runtime.loadState(handle.executionId)).toBeNull();
  });

  it("folds correctly from a snapshot plus tail (state is unchanged by the reordering)", async () => {
    const withSnapshots = makeRuntime(
      new InMemoryAsyncEventStore(),
      new InMemoryAsyncSnapshotStore(),
      2
    );
    const without = makeRuntime(new InMemoryAsyncEventStore(), new InMemoryAsyncSnapshotStore());
    const flow = benchFlow(6);
    const states: { status?: string; sequence?: number; frames: string[] }[] = [];
    for (const runtime of [withSnapshots, without]) {
      runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
      const handle = await runtime.start(flow, { n: 0 });
      await handle.waitForCompletion();
      const state = await runtime.loadState(handle.executionId);
      states.push({
        status: state?.status,
        sequence: state?.sequence,
        frames: Object.keys(state?.frames ?? {}).sort(),
      });
    }
    // Snapshotted and un-snapshotted runs fold to the same observable state.
    expect(states[0]).toEqual(states[1]);
  });
});
