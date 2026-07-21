import type { ExecutionState, FlowDefinition } from "@loom/core";
import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHILD_FAILED, type ChildSupervisor, awaitChild, superviseChildren } from "./orchestration";

// A child that always throws → EXECUTION_FAILED.
const boomRunner: FlowRunner<{ n: number }, { v: number }> = async () => {
  throw new Error("kaboom");
};
const boomFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "boom",
    name: "boom",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<{ n: number }, { v: number }>,
  runner: boomRunner,
} as RegisteredFlow;

// Parent A: awaits a failing child WITHOUT catching → the throw fails the parent.
const uncaughtParent: FlowRunner<{ n: number }, { v: number }> = async (ctx, input) =>
  awaitChild<{ v: number }>(ctx, { key: "c", flowId: "boom", input });
const uncaughtFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "uncaught",
    name: "uncaught",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<{ n: number }, { v: number }>,
  runner: uncaughtParent,
} as RegisteredFlow;

// Parent B: catches childFailed and settles with a fallback → the parent COMPLETES.
type CaughtOut = { fell_back: boolean; channel: string; failedChildId: string };
const caughtParent: FlowRunner<{ n: number }, CaughtOut> = async (ctx, input) => {
  try {
    await awaitChild(ctx, { key: "c", flowId: "boom", input });
    return { fell_back: false, channel: "", failedChildId: "" };
  } catch (err) {
    if (err instanceof TypedFailure && err.channel === CHILD_FAILED) {
      const p = err.payload as { childId: string; status: string };
      return { fell_back: true, channel: err.channel, failedChildId: p.childId };
    }
    throw err;
  }
};
const caughtFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "caught",
    name: "caught",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({
      fell_back: z.boolean(),
      channel: z.string(),
      failedChildId: z.string(),
    }),
    steps: [],
  } satisfies FlowDefinition<{ n: number }, CaughtOut>,
  runner: caughtParent,
} as RegisteredFlow;

// Grandparent: awaits `uncaught` (which fails), does NOT catch → failure propagates up.
const grandRunner: FlowRunner<{ n: number }, { v: number }> = async (ctx, input) =>
  awaitChild<{ v: number }>(ctx, { key: "u", flowId: "uncaught", input });
const grandFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "grand",
    name: "grand",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<{ n: number }, { v: number }>,
  runner: grandRunner,
} as RegisteredFlow;

function build() {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  for (const f of [boomFlow, uncaughtFlow, caughtFlow, grandFlow]) {
    runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
  }
  holder.supervisor = superviseChildren({
    runtime,
    flows: {
      boom: boomFlow,
      uncaught: uncaughtFlow,
      caught: caughtFlow,
      grand: grandFlow,
    },
  });
  return runtime;
}

const outputOf = (s: ExecutionState): unknown => s.variables._output;

async function waitTerminal(rt: WorkflowRuntime, id: string, tries = 400): Promise<ExecutionState> {
  for (let i = 0; i < tries; i++) {
    const s = await rt.loadState(id);
    if (s?.status === "completed" || s?.status === "failed") return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${id} (last=${(await rt.loadState(id))?.status})`);
}

describe("awaitChild — failure propagation", () => {
  it("an uncaught child failure fails the parent instead of hanging it", async () => {
    const rt = build();
    await rt.start(uncaughtFlow, { n: 1 }, { executionId: "U" });
    const parent = await waitTerminal(rt, "U");
    expect(parent.status).toBe("failed");
  }, 20000);

  it("the parent can catch childFailed and settle with a fallback", async () => {
    const rt = build();
    await rt.start(caughtFlow, { n: 1 }, { executionId: "C" });
    const parent = await waitTerminal(rt, "C");
    expect(parent.status).toBe("completed");
    expect(outputOf(parent)).toEqual({
      fell_back: true,
      channel: CHILD_FAILED,
      failedChildId: "C::c",
    });
  }, 20000);

  it("propagates up the tree: a failed grandchild fails the parent, which fails the grandparent", async () => {
    const rt = build();
    await rt.start(grandFlow, { n: 1 }, { executionId: "G" });
    const grand = await waitTerminal(rt, "G");
    expect(grand.status).toBe("failed");
    // The middle execution failed too (its uncaught awaitChild throw), i.e. the failure
    // climbed G::u → G rather than stranding either level suspended.
    expect((await rt.loadState("G::u"))?.status).toBe("failed");
    expect((await rt.loadState("G::u::c"))?.status).toBe("failed");
  }, 20000);
});
