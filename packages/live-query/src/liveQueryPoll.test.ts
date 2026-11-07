import type { ExecutionState } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { liveQuery } from "./liveQuery";

// A wake-up lost across nodes is not sent later. These stores never deliver one, so the poll is
// the only way a subscription can learn of a new event.

const io = z.object({}).passthrough();
const runner: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return {};
};
const flow = {
  definition: {
    _tag: "FlowDefinition" as const,
    id: "poll-flow",
    name: "poll-flow",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  },
  runner,
};

function deafStore(): { store: EventStore; reads: () => number } {
  const inner = new InMemoryAsyncEventStore();
  let reads = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "subscribe") return async () => () => {};
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      if (prop !== "readFrom" && prop !== "head") return bound;
      return (...args: unknown[]) => {
        reads++;
        return bound(...args);
      };
    },
  }) as EventStore;
  return { store, reads: () => reads };
}

async function parked() {
  const { store, reads } = deafStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(flow.definition, flow.runner);
  const handle = await runtime.start(flow, {}, { executionId: "x" });
  await handle.waitForSuspend();
  return { store, reads, runtime };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("liveQuery safety-net poll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a completion whose wake-up was lost still reaches the subscriber", async () => {
    const { store, runtime } = await parked();
    const statuses: string[] = [];
    const unsubscribe = await liveQuery({
      eventStore: store,
      reader: runtime,
      pollMs: 10,
    }).subscribe("x", (state: ExecutionState) => statuses.push(state.status));
    const resumed = await runtime.resume("x", { eventType: "GO", payload: {} });
    await resumed.waitForCompletion();
    await until(() => statuses.includes("completed"));
    expect(statuses[0]).toBe("suspended");
    unsubscribe();
  });

  it("a quiet poll emits nothing, and reads stop after unsubscribe", async () => {
    const { store, runtime, reads } = await parked();
    vi.useFakeTimers();
    const emitted: ExecutionState[] = [];
    const unsubscribe = await liveQuery({
      eventStore: store,
      reader: runtime,
      pollMs: 1000,
    }).subscribe("x", (state) => emitted.push(state));
    expect(emitted).toHaveLength(1);

    const before = reads();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads() - before).toBeGreaterThan(0);
    expect(reads() - before).toBeLessThanOrEqual(6); // at most two reads per interval
    expect(emitted).toHaveLength(1);

    unsubscribe();
    const after = reads();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads()).toBe(after);
  });

  it("stops polling once the state is terminal", async () => {
    const { store, runtime, reads } = await parked();
    const resumed = await runtime.resume("x", { eventType: "GO", payload: {} });
    await resumed.waitForCompletion();
    vi.useFakeTimers();
    const unsubscribe = await liveQuery({
      eventStore: store,
      reader: runtime,
      pollMs: 1000,
    }).subscribe("x", () => {});
    const before = reads();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads()).toBe(before);
    unsubscribe();
  });

  it("pollMs: 0 turns it off", async () => {
    const { store, runtime, reads } = await parked();
    vi.useFakeTimers();
    const unsubscribe = await liveQuery({
      eventStore: store,
      reader: runtime,
      pollMs: 0,
    }).subscribe("x", () => {});
    const before = reads();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(before);
    unsubscribe();
  });

  it("a poll that fails reports through onError and keeps the subscription alive", async () => {
    const { store, runtime } = await parked();
    const errors: unknown[] = [];
    const boom = new Error("read failed");
    const original = store.readFrom.bind(store);
    let failing = true;
    const flaky = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "readFrom") {
          return async (id: string, from: number) => {
            if (failing) throw boom;
            return original(id, from);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const statuses: string[] = [];
    const unsubscribe = await liveQuery({
      eventStore: flaky,
      reader: runtime,
      pollMs: 10,
      onError: (err) => errors.push(err),
    }).subscribe("x", (state) => statuses.push(state.status));
    await until(() => errors.length > 0);
    expect(errors[0]).toBe(boom);
    failing = false;
    const resumed = await runtime.resume("x", { eventType: "GO", payload: {} });
    await resumed.waitForCompletion();
    await until(() => statuses.includes("completed"));
    unsubscribe();
  });
});
