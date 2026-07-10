import type { ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { liveQuery } from "./liveQuery";

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ n: z.number() });
type IO = { n: number };

const runner: FlowRunner<IO, IO> = async (ctx, input) => {
  await ctx.suspend({ on: "GO" });
  return input;
};

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "lq-flow",
    name: "lq-flow",
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [],
  } satisfies FlowDefinition<IO, IO>,
  runner,
} as RegisteredFlow<IO, IO>;

function build() {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(flow.definition, runner);
  return { eventStore, runtime };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("liveQuery", () => {
  it("snapshot folds the current state on demand", async () => {
    const { eventStore, runtime } = build();
    const lq = liveQuery({ eventStore, reader: runtime });
    expect(await lq.snapshot("missing")).toBeNull();

    await (await runtime.start(flow, { n: 3 }, { executionId: "e1" })).waitForSuspend();
    expect((await lq.snapshot("e1"))?.status).toBe("suspended");
  });

  it("subscribe pushes the current state, then again as events land", async () => {
    const { eventStore, runtime } = build();
    const lq = liveQuery({ eventStore, reader: runtime });

    await (await runtime.start(flow, { n: 3 }, { executionId: "e1" })).waitForSuspend();

    const seen: ExecutionState[] = [];
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    expect(seen.at(-1)?.status).toBe("suspended"); // immediate current state

    await (await runtime.resume("e1", { eventType: "GO", payload: {} })).waitForCompletion();
    await tick();
    expect(seen.at(-1)?.status).toBe("completed"); // pushed on the resume/complete events
    unsub();
  });

  it("stops delivering after unsubscribe", async () => {
    const { eventStore, runtime } = build();
    const lq = liveQuery({ eventStore, reader: runtime });
    await (await runtime.start(flow, { n: 3 }, { executionId: "e1" })).waitForSuspend();

    const seen: ExecutionState[] = [];
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    const countAtUnsub = seen.length;
    unsub();

    await (await runtime.resume("e1", { eventType: "GO", payload: {} })).waitForCompletion();
    await tick();
    expect(seen.length).toBe(countAtUnsub); // no further deliveries
  });
});
