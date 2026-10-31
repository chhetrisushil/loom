import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryArchiveStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  LogLifecycle,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hashChainedEventStore } from "./hashChain";

// ADR 0138 - the audit chain verifies ACROSS a compaction: compaction moves the prefix to the
// archive, and `verifyChain(id, { archived })` stitches it back. Without the archived events the
// same chain reports the break (truthfully), and tampering with an archived event is detected.

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });
const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  const a = await ctx.run(s1, input);
  await ctx.suspend({ on: "go" });
  const b = await ctx.run(s2, a);
  return b;
};
const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "chain-compact",
    name: "chain-compact",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [s1, s2],
  },
  runner,
} as RegisteredFlow<{ n: number }, { n: number }>;

async function boot(hmacSecret?: string) {
  const inner = new InMemoryAsyncEventStore();
  const store = hashChainedEventStore(inner, {
    allowCompaction: true,
    ...(hmacSecret !== undefined && { hmacSecret }),
  });
  const snapshots = new InMemoryAsyncSnapshotStore();
  const effects = new EffectRuntime();
  effects.register("t1", new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  effects.register("t2", new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  const rt = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: snapshots,
    effectRuntime: effects,
  });
  rt.registerFlow(flow.definition, flow.runner);
  const life = new LogLifecycle(store, snapshots, {
    compactionArchive: new InMemoryArchiveStore(),
  });
  return { inner, store, snapshots, rt, life };
}

describe("hash chain across a compaction (ADR 0138)", () => {
  it("verifies end to end using readArchived; the surviving log alone breaks, truthfully", async () => {
    const { store, rt, life } = await boot("audit-secret");
    await (await rt.start(flow, { n: 1 }, { executionId: "c" })).waitForSuspend();
    expect(await store.verifyChain("c")).toMatchObject({ ok: true });

    expect(await life.compact("c")).not.toBeNull();

    const archived = await life.readArchived("c");
    expect(archived.length).toBeGreaterThan(0);
    const across = await store.verifyChain("c", { archived });
    expect(across).toMatchObject({ ok: true, signaturesChecked: true });
    // the verified length is the WHOLE original log, not just the survivors
    expect(across.length).toBe((await life.readWithArchive("c")).length);

    // and it keeps verifying as the execution continues past the compaction
    await (await rt.resume("c", { eventType: "go", payload: { answer: 1 } })).waitForCompletion();
    expect(await store.verifyChain("c", { archived: await life.readArchived("c") })).toMatchObject({
      ok: true,
    });
    // the gap is real: the surviving log alone, now with events above it, no longer chains
    expect(await store.verifyChain("c")).toMatchObject({ ok: false });
  });

  it("an edit to an ARCHIVED event is detected by the chain (the archive is evidence, not a cache)", async () => {
    const { store, rt, life } = await boot();
    await (await rt.start(flow, { n: 1 }, { executionId: "t" })).waitForSuspend();
    await life.compact("t");
    const archived = await life.readArchived("t");
    const forged = archived.map((e, i) =>
      i === 1 ? { ...e, payload: { ...(e.payload as object), forged: true } } : e
    );
    const result = await store.verifyChain("t", { archived: forged });
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(archived[1]!.sequence);
    // dropping an archived event is a break as well
    const dropped = archived.filter((_, i) => i !== 1);
    expect(await store.verifyChain("t", { archived: dropped })).toMatchObject({ ok: false });
  });

  it("without the opt-in the chained store still refuses compaction (the ADR 0037 behaviour)", async () => {
    const chained = hashChainedEventStore(new InMemoryAsyncEventStore());
    expect(chained.truncatePrefix).toBeUndefined();
  });
});

describe("H1 - the chain head survives a compaction, so a restarted writer keeps chaining", () => {
  it("compacting through the tip then appending from a FRESH chained store (cold cache) verifies across", async () => {
    const { inner, snapshots, rt, life } = await boot("s");
    await (await rt.start(flow, { n: 1 }, { executionId: "r" })).waitForSuspend();
    const tip = (await inner.read("r")).at(-1)!.sequence;
    const through = await life.compact("r");
    expect(through).not.toBeNull();
    // the chain head (the log's tip event) was NOT removed, whatever `through` asked for
    expect((await inner.read("r")).map((e) => e.sequence)).toContain(tip);

    // "restart": a new chained store over the same durable inner has an empty hash cache
    const fresh = hashChainedEventStore(inner, { allowCompaction: true, hmacSecret: "s" });
    const effects = new EffectRuntime();
    effects.register("t1", new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
    effects.register("t2", new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
    const rt2 = new WorkflowRuntime({
      eventStore: fresh,
      snapshotStore: snapshots,
      effectRuntime: effects,
    });
    rt2.registerFlow(flow.definition, flow.runner);
    await (await rt2.resume("r", { eventType: "go", payload: { answer: 1 } })).waitForCompletion();

    const life2 = new LogLifecycle(fresh, snapshots, {
      compactionArchive: life.compactionArchive!,
    });
    const result = await fresh.verifyChain("r", { archived: await life2.readArchived("r") });
    expect(result).toMatchObject({ ok: true });
  });

  it("truncatePrefixKeeping clamps the same way", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner, { allowCompaction: true });
    for (let i = 0; i < 4; i++) {
      await chained.append({
        id: `k-${i}`,
        workflowId: "w",
        executionId: "k",
        eventType: i === 0 ? "EXECUTION_STARTED" : "E",
        sequence: i,
        timestamp: 1,
        payload: {},
      });
    }
    await chained.truncatePrefixKeeping!("k", 3, []); // through the tip
    expect((await inner.read("k")).map((e) => e.sequence)).toEqual([0, 3]);
    await chained.truncatePrefix!("k", 3);
    expect((await inner.read("k")).map((e) => e.sequence)).toEqual([0, 3]); // nothing left to remove below the head
  });
});

describe("M2 - verifyChain compares a duplicate sequence byte-exact", () => {
  it("an archived copy that differs from the surviving log's copy is reported, not silently overridden", async () => {
    const { store, rt, life, inner } = await boot();
    await (await rt.start(flow, { n: 1 }, { executionId: "d" })).waitForSuspend();
    await life.compact("d");
    const archived = await life.readArchived("d");
    const tip = (await inner.read("d")).at(-1)!;
    expect(archived.some((e) => e.sequence === tip.sequence)).toBe(true); // the clamp leaves a duplicate
    // identical duplicate: verifies
    expect(await store.verifyChain("d", { archived })).toMatchObject({ ok: true });
    // a forged archived copy of the duplicated sequence: reported at that sequence
    const forged = archived.map((e) =>
      e.sequence === tip.sequence ? { ...e, payload: { ...(e.payload as object), forged: 1 } } : e
    );
    const result = await store.verifyChain("d", { archived: forged });
    expect(result).toMatchObject({ ok: false, brokenAt: tip.sequence });
    expect(result.reason).toMatch(/differ/);
  });
});
