import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryBranchRegistry } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LIFECYCLE_STREAM, LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ n: z.number() });

const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema, outputSchema });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema, outputSchema });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema, outputSchema });

const FLOW = "lifecycle-flow";

function completingFlow(): RegisteredFlow<{ n: number }, { n: number }> {
  const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
    await ctx.run(s1, input);
    await ctx.run(s2, input);
    await ctx.run(s3, input);
    return { n: input.n };
  };
  const definition: FlowDefinition<{ n: number }, { n: number }> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [s1, s2, s3],
  };
  return { definition, runner };
}

function boot(shared?: {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}) {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"]) effects.register(id, new ToolEffect(async () => ({ n: 0 })));
  const stores = shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({ ...stores, effectRuntime: effects });
  const flow = completingFlow();
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, ...stores };
}

describe("K10.1 — retention", () => {
  it("reclaims a terminal execution older than the TTL; keeps a fresh one", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "ret-1" });
    await handle.waitForCompletion();

    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    const endedAt = (await app.eventStore.read("ret-1")).at(-1)!.timestamp;

    // Within the window → kept.
    expect(await life.applyRetention("ret-1", { terminalTtlMs: 1_000 }, endedAt + 500)).toBe(
      "kept"
    );
    expect((await app.eventStore.read("ret-1")).length).toBeGreaterThan(0);

    // Past the window → reclaimed (events + snapshots gone).
    expect(await life.applyRetention("ret-1", { terminalTtlMs: 1_000 }, endedAt + 2_000)).toBe(
      "reclaimed"
    );
    expect(await app.eventStore.read("ret-1")).toEqual([]);
    expect(await app.snapshotStore.loadLatest("ret-1")).toBeNull();
    // Idempotent: a second sweep sees nothing.
    expect(await life.applyRetention("ret-1", { terminalTtlMs: 1_000 }, endedAt + 3_000)).toBe(
      "unknown"
    );
  });

  it("never reclaims a non-terminal (suspended) execution", async () => {
    const effects = new EffectRuntime();
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
    const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx) => {
      await ctx.suspend({ on: "Approval" });
      return { n: 0 };
    };
    const definition = {
      _tag: "FlowDefinition",
      id: "susp",
      name: "susp",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [],
    } as FlowDefinition<{ n: number }, { n: number }>;
    runtime.registerFlow(definition, runner);
    const handle = await runtime.start({ definition, runner }, { n: 1 }, { executionId: "susp-1" });
    await handle.waitForSuspend();

    const life = new LogLifecycle(eventStore, snapshotStore);
    expect(await life.applyRetention("susp-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "not-terminal"
    );
    expect((await eventStore.read("susp-1")).length).toBeGreaterThan(0);
  });

  it("A6 — archives before deleting", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 7 }, { executionId: "arc-1" });
    await handle.waitForCompletion();
    const original = await app.eventStore.read("arc-1");

    const archiveEvents = new InMemoryAsyncEventStore();
    const archiveSnaps = new InMemoryAsyncSnapshotStore();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: { eventStore: archiveEvents, snapshotStore: archiveSnaps },
    });

    expect(await life.applyRetention("arc-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    // Primary emptied; archive holds the full log → replay from archive is byte-identical.
    expect(await app.eventStore.read("arc-1")).toEqual([]);
    expect(await archiveEvents.read("arc-1")).toEqual(original);
    expect(foldEvents(await archiveEvents.read("arc-1")).status).toBe("completed");
  });

  it("reports 'unsupported' on a store without deleteExecution", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "u-1" });
    await handle.waitForCompletion();
    const noDelete = new Proxy(app.eventStore, {
      get(t, p, r) {
        if (p === "deleteExecution") return undefined;
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as InMemoryAsyncEventStore;
    const life = new LogLifecycle(noDelete, app.snapshotStore);
    expect(await life.applyRetention("u-1", { terminalTtlMs: 0 }, Date.now())).toBe("unsupported");
  });
});

describe("K10.4 — compaction (fold(snapshot, suffix) === fold(events))", () => {
  it("bounds the log and preserves the fold + resume", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 5 }, { executionId: "comp-1" });
    await handle.waitForCompletion();

    const before = await app.eventStore.read("comp-1");
    const foldBefore = foldEvents(before);
    expect(before.length).toBeGreaterThan(3);

    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    const through = await life.compact("comp-1");
    expect(through).toBe(before.at(-1)!.sequence);

    // The log is bounded (only the bootstrap anchor + nothing after the tip)…
    const after = await app.eventStore.read("comp-1");
    expect(after.length).toBeLessThan(before.length);
    expect(after[0]?.sequence).toBe(0); // sequence 0 preserved

    // …and the snapshot + surviving suffix fold to the SAME state (the invariant).
    const snap = await app.snapshotStore.loadLatest("comp-1");
    const suffix = await app.eventStore.readFrom("comp-1", snap!.sequence + 1);
    const foldAfter = foldEvents(suffix, snap!.state);
    expect(foldAfter).toEqual(foldBefore);

    // loadState (the resume path) reconstructs the completed terminal state.
    expect((await app.runtime.loadState("comp-1"))?.status).toBe("completed");
  });

  it("is a no-op on an execution with nothing beyond the bootstrap", async () => {
    const app = boot();
    const eventStore = app.eventStore;
    await eventStore.append({
      id: "tiny-0",
      workflowId: FLOW,
      executionId: "tiny",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: { n: 1 } },
    });
    const life = new LogLifecycle(eventStore, app.snapshotStore);
    expect(await life.compact("tiny")).toBeNull();
  });
});

describe("K10.1 R5 — branch guard + control facts", () => {
  it("refuses to delete a parent with a live descendant branch (blocked-by-branch)", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "parent-1" });
    await handle.waitForCompletion();

    const branchRegistry = new InMemoryBranchRegistry();
    await branchRegistry.recordLineage({
      executionId: "child-1",
      parentExecutionId: "parent-1",
      forkSequence: 1,
    });
    // The child is "live" — it has events.
    await app.eventStore.append({
      id: "c0",
      workflowId: FLOW,
      executionId: "child-1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: { n: 1 } },
    });

    const life = new LogLifecycle(app.eventStore, app.snapshotStore, { branchRegistry });
    expect(await life.applyRetention("parent-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "blocked-by-branch"
    );
    // The parent's events are untouched.
    expect((await app.eventStore.read("parent-1")).length).toBeGreaterThan(0);
  });

  it("K10.6 — the pin predicate exempts an otherwise-reclaimable execution", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "pin-1" });
    await handle.waitForCompletion();

    const consulted: string[] = [];
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinned: async (executionId) => {
        consulted.push(executionId);
        return executionId === "pin-1";
      },
    });

    // Pinned → exempt; nothing archived, nothing deleted.
    expect(await life.applyRetention("pin-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "pinned"
    );
    expect(consulted).toEqual(["pin-1"]);
    expect((await app.eventStore.read("pin-1")).length).toBeGreaterThan(0);
    expect(await app.eventStore.read(LIFECYCLE_STREAM)).toEqual([]); // no archive/delete facts

    // A second execution the predicate does NOT pin reclaims normally.
    const handle2 = await app.runtime.start(app.flow, { n: 2 }, { executionId: "pin-2" });
    await handle2.waitForCompletion();
    expect(await life.applyRetention("pin-2", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    expect(await app.eventStore.read("pin-2")).toEqual([]);
  });

  it("K10.6 — the pin gate runs before TTL-eligible archive copies (archive untouched)", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "pin-arc" });
    await handle.waitForCompletion();

    const archiveEvents = new InMemoryAsyncEventStore();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: { eventStore: archiveEvents },
      pinned: () => true,
    });
    expect(await life.applyRetention("pin-arc", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "pinned"
    );
    expect(await archiveEvents.read("pin-arc")).toEqual([]); // pin means NO copy either
  });

  it("journals EXECUTION_DELETED to the lifecycle stream on reclaim", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "del-1" });
    await handle.waitForCompletion();

    const now = Date.now() + 1e9;
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    expect(await life.applyRetention("del-1", { terminalTtlMs: 0 }, now)).toBe("reclaimed");

    const lifecycleLog = await app.eventStore.read(LIFECYCLE_STREAM);
    const folded = foldEvents(lifecycleLog).variables._lifecycle as {
      op: string;
      executionId: string;
    }[];
    expect(folded).toContainEqual({ op: "deleted", executionId: "del-1", at: now });
  });
});
