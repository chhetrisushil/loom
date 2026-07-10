import { step$ } from "@loom/core";
import { faultInjectingStore, splitmix64 } from "@loom/dst";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hashChainedEventStore } from "./hashChain";

// A two-step flow so the durable log has enough events to chain non-trivially.
const stepA = step$({
  id: "a",
  name: "A",
  toolId: "tool-a",
  inputSchema: z.object({}),
  outputSchema: z.object({ v: z.number() }),
});
const stepB = step$({
  id: "b",
  name: "B",
  toolId: "tool-b",
  inputSchema: z.object({ v: z.number() }),
  outputSchema: z.object({ v: z.number() }),
});

const runner: FlowRunner<Record<string, never>, { v: number }> = async (ctx) => {
  const a = await ctx.run(stepA, {});
  return ctx.run(stepB, { v: a.v });
};

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "chain-flow",
    name: "chain-flow",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ v: z.number() }),
    steps: [stepA, stepB],
  },
  runner,
} as RegisteredFlow<Record<string, never>, { v: number }>;

const EXEC = "chain-exec";

/**
 * Compose the stack the way production would: runtime → fault injector → hash chain →
 * base store. A crash swallows appends at the transport layer, so whatever DOES reach
 * the durable log must remain a valid, verifiable chain — and recovery must continue
 * that chain, not fork it.
 */
function buildStack(seed: bigint, crashRate: number) {
  const inner = new InMemoryAsyncEventStore();
  const chain = hashChainedEventStore(inner, { hmacSecret: "audit-secret" });
  const faults = faultInjectingStore(chain, {
    mode: "explore",
    rng: splitmix64(seed).fork("faults"),
    model: { crashBeforeAppend: crashRate },
  });
  const snapshots = new InMemoryAsyncSnapshotStore();
  const spawn = () => {
    const effects = new EffectRuntime();
    effects.register("tool-a", new ToolEffect(async () => ({ v: 1 })));
    effects.register(
      "tool-b",
      new ToolEffect(async (input: unknown) => ({ v: (input as { v: number }).v + 1 }))
    );
    const runtime = new WorkflowRuntime({
      eventStore: faults.store as never,
      snapshotStore: snapshots,
      effectRuntime: effects,
    });
    runtime.registerFlow(flow.definition, runner);
    return runtime;
  };
  return { inner, chain, faults, spawn };
}

describe("DST — hash chain survives seeded crash/recovery", () => {
  it("keeps a verifiable chain across the crash-schedule space", async () => {
    let sawCrash = false;
    for (let s = 1n; s <= 40n; s++) {
      const { inner, chain, faults, spawn } = buildStack(s, 0.2);

      const h1 = await spawn().start(flow, {}, { executionId: EXEC });
      await h1.waitForCompletion();

      const durable = await inner.read(EXEC);
      const terminal = durable.some((e) => e.eventType === "EXECUTION_COMPLETED");
      if (durable.length > 0 && !terminal) {
        faults.restore();
        const h2 = await spawn().resume(EXEC, { eventType: "EXECUTION_RECOVERED", payload: {} });
        await h2.waitForCompletion();
      }
      if (faults.crashed) sawCrash = true;

      // Whatever survived must be an intact, signed chain — no fork, no gap, no forgery.
      const v = await chain.verifyChain(EXEC);
      expect(v.ok, `chain broken @seed ${s}: ${v.reason} @${v.brokenAt}`).toBe(true);
    }
    expect(sawCrash).toBe(true); // the fault model really exercised crashes
  });
});
