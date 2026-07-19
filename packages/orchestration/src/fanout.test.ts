import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { TypedFailure, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fanout$ } from "./fanout";
import { awaitChild, depthOf } from "./orchestration";

// ── ADR 0061 D4/D5 — fanout$ (the DE-1 residue) + the recursion depth guard ──

type In = { items: string[] };
type Out = { results: string[] };

const flowDef: FlowDefinition<In, Out> = {
  _tag: "FlowDefinition",
  id: "fanout-flow",
  name: "fanout-flow",
  version: "1.0.0",
  inputSchema: z.object({ items: z.array(z.string()) }) as z.ZodSchema<In>,
  outputSchema: z.object({ results: z.array(z.string()) }) as z.ZodSchema<Out>,
  steps: [],
};

const hydrate = step$({
  id: "hydrate",
  toolId: "hydrate",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
});

const runner: FlowRunner<In, Out> = async (ctx, input) => {
  const outs = await fanout$(ctx, hydrate, input.items, { limit: 2 });
  return { results: outs as string[] };
};

function boot(eventStore = new InMemoryAsyncEventStore()) {
  const effectRuntime = new EffectRuntime();
  const invocations: string[] = [];
  effectRuntime.register(
    "hydrate",
    new ToolEffect(async (input) => {
      invocations.push(input as string);
      return input;
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });
  runtime.registerFlow(flowDef, runner);
  const flow: RegisteredFlow<In, Out> = { definition: flowDef, runner };
  return { runtime, eventStore, invocations, flow };
}

const ITEMS = ["a", "b", "c", "d"];

describe("fanout$ (ADR 0061 D4)", () => {
  it("runs one step per item with `${id}#${i}` identity, results in input order", async () => {
    const { runtime, flow, eventStore, invocations } = boot();
    const handle = await runtime.start(flow, { items: ITEMS }, { executionId: "fan" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(invocations.sort()).toEqual([...ITEMS].sort()); // each item exactly once
    const stepIds = (await eventStore.read("fan"))
      .filter((e) => e.eventType === "STEP_COMPLETED" && e.payload !== null)
      .map((e) => (e.payload as { stepId?: string }).stepId)
      .filter((id) => id?.startsWith("hydrate#"));
    expect([...stepIds].sort()).toEqual(ITEMS.map((_, i) => `hydrate#${i}`).sort());
    // Results positional despite arbitrary completion interleaving.
    const output = (await eventStore.read("fan")).find(
      (e) => e.eventType === "EXECUTION_COMPLETED"
    );
    expect((output?.payload as { output: Out }).output.results).toEqual(ITEMS);
  });

  it("crash mid-fan-out: recovery re-executes ONLY the items whose frames never completed", async () => {
    // Reference log, then construct the durable residue of a crash where only
    // items 0 and 2 completed (1 and 3 in flight, events never persisted).
    const ref = boot();
    const handle = await ref.runtime.start(ref.flow, { items: ITEMS }, { executionId: "fan" });
    const refState = await handle.waitForCompletion();
    const events = await ref.eventStore.read("fan");

    const survivors = new Set(["hydrate#0", "hydrate#2"]);
    const prefix: EventEnvelope[] = [];
    let seq = 0;
    for (const e of events) {
      if (e.eventType === "EXECUTION_STARTED") {
        prefix.push({ ...e, sequence: seq++ });
      } else if (
        (e.eventType === "STEP_STARTED" || e.eventType === "STEP_COMPLETED") &&
        survivors.has((e.payload as { stepId: string }).stepId)
      ) {
        prefix.push({ ...e, sequence: seq++ });
      }
    }
    const store = new InMemoryAsyncEventStore();
    for (const e of prefix) await store.append(e);

    const recovery = boot(store);
    const folded = new ReplayVM(prefix, {
      executionId: "fan",
      workflowId: "fanout-flow",
      workflowVersion: "1.0.0",
    }).getState();
    const recovered = await recovery.runtime.restoreFromState(folded);
    const state = await recovered.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(recovery.invocations.sort()).toEqual(["b", "d"]); // only the missing frames
    expect(Object.keys(state.frames).sort()).toEqual(Object.keys(refState.frames).sort());
  });

  it("nested fanout composes: ids concatenate deterministically", async () => {
    const inner = step$({
      id: "leaf",
      toolId: "hydrate",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    });
    const nestedRunner: FlowRunner<In, Out> = async (ctx, input) => {
      const groups = await fanout$(
        ctx,
        { ...hydrate, id: "group" },
        input.items.slice(0, 2).map((g) => ({ item: g }))
      );
      void groups;
      const leaves = await Promise.all(
        input.items
          .slice(0, 2)
          .map((_, g) => fanout$(ctx, { ...inner, id: `leaf#${g}` }, [{ n: 0 }, { n: 1 }]))
      );
      void leaves;
      return { results: [] };
    };
    const store = new InMemoryAsyncEventStore();
    const { runtime } = (() => {
      const effectRuntime = new EffectRuntime();
      effectRuntime.register("hydrate", new ToolEffect(async (input) => input));
      const rt = new WorkflowRuntime({
        eventStore: store,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime,
      });
      rt.registerFlow(flowDef, nestedRunner);
      return { runtime: rt };
    })();
    const handle = await runtime.start(
      { definition: flowDef, runner: nestedRunner },
      { items: ITEMS },
      { executionId: "nested" }
    );
    await handle.waitForCompletion();
    const ids = (await store.read("nested"))
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(ids).toContain("leaf#0#0");
    expect(ids).toContain("leaf#1#1");
    expect(new Set(ids).size).toBe(ids.length); // no id collisions anywhere
  });
});

describe("awaitChild depth guard (ADR 0061 D5)", () => {
  const fakeCtx = (executionId: string) =>
    ({
      executionId,
      decide: async <T>(_id: string, decider: () => T) => decider(),
      suspend: async () => ({ output: "child-output" }),
    }) as unknown as Parameters<typeof awaitChild>[0];

  it("depthOf counts nesting levels", () => {
    expect(depthOf("root")).toBe(0);
    expect(depthOf("root::a")).toBe(1);
    expect(depthOf("root::a::b::c")).toBe(3);
  });

  it("allows spawns within maxDepth and fails typed beyond it", async () => {
    await expect(
      awaitChild(fakeCtx("root::repair"), { key: "again", flowId: "f", input: {}, maxDepth: 2 })
    ).resolves.toBe("child-output");

    try {
      await awaitChild(fakeCtx("root::repair::again"), {
        key: "more",
        flowId: "f",
        input: {},
        maxDepth: 2,
      });
      expect.unreachable("depth guard should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TypedFailure);
      expect((err as TypedFailure).channel).toBe("depthExceeded");
      expect((err as TypedFailure).payload).toEqual({
        childId: "root::repair::again::more",
        depth: 3,
        maxDepth: 2,
      });
    }
  });

  it("no maxDepth = unbounded (existing behavior unchanged, G2)", async () => {
    await expect(
      awaitChild(fakeCtx("r::a::b::c::d::e"), { key: "deep", flowId: "f", input: {} })
    ).resolves.toBe("child-output");
  });
});
