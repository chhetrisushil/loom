import { step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
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

// ADR 0116 round 3 (P3 #6) — a late outcome written through the hash chain's conditional append
// extends the chain: the chain stays verifiable, the cached tail is not trusted across the
// write, and a refused write leaves the log (and the chain) untouched.

const noop = step$({
  id: "noop",
  name: "noop",
  toolId: "noop",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});
const runner: FlowRunner<Record<string, never>, { done: boolean }> = async (ctx) => {
  await ctx.decide("route", () => "opus");
  return { done: true };
};
const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "late",
    name: "late",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ done: z.boolean() }),
    steps: [noop],
  },
  runner,
} as RegisteredFlow<Record<string, never>, { done: boolean }>;

describe("recordOutcome through hashChainedEventStore", () => {
  it("extends the chain: two late outcomes land, the chain verifies, a duplicate writes nothing", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = hashChainedEventStore(inner);
    const rt = new WorkflowRuntime({
      eventStore: store,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    rt.registerFlow(flow.definition, flow.runner);
    await (await rt.start(flow, {}, { executionId: "e" })).waitForCompletion();
    expect(await store.verifyChain("e")).toMatchObject({ ok: true });
    const a = await rt.recordOutcome("e", { decisionId: "route", key: "k", score: 0.5 });
    const dup = await rt.recordOutcome("e", { decisionId: "route", key: "k", score: 0.5 });
    const b = await rt.recordOutcome("e", { decisionId: "route", key: "k2", score: 0.7 });
    expect([a.appended, dup.appended, b.appended]).toEqual([true, false, true]);
    expect(await store.verifyChain("e")).toMatchObject({ ok: true });
    const log = await inner.read("e");
    expect(log.map((e) => e.sequence)).toEqual(log.map((_, i) => i));
    expect(log.filter((e) => e.eventType === "OUTCOME_RECORDED")).toHaveLength(2);
    // every stored event carries the chain stamp, the late ones included
    for (const e of log) expect(e.metadata?.auditChain).toBeDefined();
  });

  it("verifyChain still verifies after restoreTerminalEvent writes the terminal event above a pre-0116 checkpoint", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = hashChainedEventStore(inner);
    const snapshots = new InMemoryAsyncSnapshotStore();
    const rt = new WorkflowRuntime({
      eventStore: store,
      snapshotStore: snapshots,
      effectRuntime: new EffectRuntime(),
    });
    rt.registerFlow(flow.definition, flow.runner);
    await (await rt.start(flow, {}, { executionId: "r" })).waitForCompletion();
    const state = (await rt.loadState("r"))!;
    await snapshots.save({
      id: "r-old-ckpt",
      executionId: "r",
      workflowId: state.workflowId,
      sequence: state.sequence,
      state,
      createdAt: 0,
    });
    await inner.truncatePrefix!("r", state.sequence); // the pre-0116 shape: [0] + checkpoint
    const life = new LogLifecycle(store, snapshots);
    expect(await life.restoreTerminalEvent("r", { apply: true })).toMatchObject({
      status: "restored",
    });
    expect(await store.verifyChain("r")).toMatchObject({ ok: true });
    expect((await inner.read("r")).at(-1)?.metadata?.auditChain).toBeDefined();
  });
});
