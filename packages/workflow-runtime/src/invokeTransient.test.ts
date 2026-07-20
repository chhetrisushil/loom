import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { WorkflowRuntime } from "./WorkflowRuntime";

// R1 end-to-end: the acceptance criterion says a call to invokeTransient against
// an in-memory event store must leave the store EMPTY — zero appended envelopes —
// while returning the effect's result. The EffectRuntime holds no store, so this
// is what makes the guarantee observable: we run through the top-level runtime
// (which DOES own a store used by durable runs) and prove the store never grew.

function makeRuntime() {
  const eventStore = new InMemoryAsyncEventStore();
  const effectRuntime = new EffectRuntime();
  effectRuntime.register(
    "read-telemetry",
    new ToolEffect(async (input: { window: string }) => ({
      rows: 3,
      window: input.window,
    }))
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });
  return { runtime, eventStore };
}

describe("WorkflowRuntime.invokeTransient (R1 end-to-end)", () => {
  it("returns the effect result and appends zero envelopes to the store", async () => {
    const { runtime, eventStore } = makeRuntime();

    const result = await runtime.invokeTransient("read-telemetry", { window: "5m" });

    expect(result).toEqual({ rows: 3, window: "5m" });
    // The load-bearing guarantee: no execution, no events, anywhere.
    expect(await eventStore.listExecutions()).toEqual([]);
    expect(await eventStore.read("transient:read-telemetry")).toEqual([]);
  });

  it("many transient calls still leave the store empty", async () => {
    const { runtime, eventStore } = makeRuntime();

    for (let i = 0; i < 25; i++) {
      await runtime.invokeTransient("read-telemetry", { window: "1m" });
    }

    expect(await eventStore.listExecutions()).toEqual([]);
  });
});
