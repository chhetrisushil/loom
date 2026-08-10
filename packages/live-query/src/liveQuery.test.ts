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

// ── A background re-fold that fails must not take the process down ───────────
//
// `subscribe` re-folds on every event from inside the store's subscribe callback. Nothing
// awaits that call, so a rejection escaping it is UNHANDLED — and Node terminates the
// process by default. A store read that fails, or an `onState` callback that throws, is an
// ordinary bad day; it must cost one update, not the node.

describe("liveQuery — a failing background re-fold", () => {
  const stateFor = (id: string): ExecutionState =>
    ({ executionId: id, status: "running", sequence: 1 }) as ExecutionState;

  /** A reader that succeeds for the first fold and rejects for every one after it. */
  function flakyReader(fail: { now: boolean }) {
    return {
      loadState: async (id: string): Promise<ExecutionState | null> => {
        if (fail.now) throw new Error("store unavailable");
        return stateFor(id);
      },
    };
  }

  it("reports the failure and stays subscribed instead of rejecting", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const fail = { now: false };
    const errors: unknown[] = [];
    const lq = liveQuery({
      eventStore,
      reader: flakyReader(fail),
      onError: (e) => errors.push(e),
    });

    const seen: ExecutionState[] = [];
    const unsubscribe = await lq.subscribe("x1", (s) => seen.push(s));
    expect(seen).toHaveLength(1); // the initial fold, awaited by us

    fail.now = true;
    await eventStore.append({
      id: "e1",
      workflowId: "w",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0)); // let the background fold settle

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("store unavailable");

    // Still live: a later event folds again once the store recovers.
    fail.now = false;
    await eventStore.append({
      id: "e2",
      workflowId: "w",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 1,
      timestamp: 2,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBeGreaterThan(1);
    unsubscribe();
  });

  it("still surfaces a first-fold failure to the caller, who awaited it", async () => {
    // The distinction the fix rests on: only the BACKGROUND fold is caught. The initial
    // one is awaited by `subscribe`'s caller and stays theirs to handle.
    const lq = liveQuery({
      eventStore: new InMemoryAsyncEventStore(),
      reader: flakyReader({ now: true }),
    });
    await expect(lq.subscribe("x1", () => {})).rejects.toThrow("store unavailable");
  });
});
