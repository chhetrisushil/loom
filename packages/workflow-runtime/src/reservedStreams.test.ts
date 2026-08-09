import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

const io = z.object({});
const tick = step$({ id: "s0", name: "s0", toolId: "t", inputSchema: io, outputSchema: io });

function makeRuntime() {
  const effects = new EffectRuntime();
  effects.register("t", new ToolEffect(async () => ({})));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const flow: RegisteredFlow = {
    definition: {
      _tag: "FlowDefinition",
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [tick],
    },
    runner: (async (ctx) => {
      await ctx.run(tick, {});
      return {};
    }) as FlowRunner<unknown, unknown>,
  };
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, eventStore };
}

// The kernel reserves `__loom_*` for its own control streams (retention lifecycle, erasure).
// `isReservedStream` existed only as a FILTER — enumerators and retention sweeps skip these
// ids — and nothing rejected one on the way IN. An ingress adapter that maps a client id to
// the executionId verbatim (A2A does) therefore let an external caller start an execution
// inside the audit trail, where it was also invisible to every enumerator.
describe("reserved control streams are not writable by callers", () => {
  it("refuses to start an execution in a reserved stream", async () => {
    const { runtime, flow, eventStore } = makeRuntime();
    for (const id of ["__loom_lifecycle__", "__loom_erasure__", "__loom_anything"]) {
      await expect(runtime.start(flow, {}, { executionId: id })).rejects.toThrow(/reserved/);
      expect(await eventStore.read(id)).toEqual([]);
    }
  });

  it("refuses to resume into a reserved stream", async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.resume("__loom_lifecycle__", { eventType: "X", payload: {} })
    ).rejects.toThrow(/reserved/);
  });

  it("leaves ordinary ids — including ones merely containing the prefix — alone", async () => {
    const { runtime, flow } = makeRuntime();
    for (const id of ["exec-1", "my__loom_thing", "loom_x"]) {
      const handle = await runtime.start(flow, {}, { executionId: id });
      expect((await handle.waitForCompletion()).status).toBe("completed");
    }
  });

  it("still lets the kernel write its own control facts directly", async () => {
    // LogLifecycle appends control facts through the store, not through start() — the guard
    // must not break that.
    const { eventStore } = makeRuntime();
    await eventStore.append({
      id: "__loom_lifecycle__-0",
      workflowId: "__loom__",
      executionId: "__loom_lifecycle__",
      eventType: "EXECUTION_DELETED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    expect((await eventStore.read("__loom_lifecycle__")).length).toBe(1);
  });
});
