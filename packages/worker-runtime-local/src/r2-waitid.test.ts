import { LocalDispatcher } from "@loom/dispatcher";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// ADR 0110 D3 — a dispatched resume names the wait it answers; the package must not drop `waitId`.

describe("a resume package carries its waitId to the runtime", () => {
  it("answers the addressed wait of a multi-wait park", async () => {
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      inboxEnabled: true,
    });
    const io = { inputSchema: z.any(), outputSchema: z.any() };
    runtime.registerFlow(
      { _tag: "FlowDefinition", id: "f", name: "f", version: "1.0.0", ...io, steps: [] } as never,
      async (ctx) => {
        const r = await ctx.select([{ gate: "G" }, { gate: "G" }]);
        return { arm: r.arm };
      }
    );
    await (await runtime.start("f", {}, { executionId: "a1" })).waitForSuspend();
    const d = new LocalDispatcher(
      new LocalWorkerRuntime(runtime, { system: runtime.systemOptions().system } as never)
    );
    await d.dispatch({
      executionId: "a1",
      workflowId: "f",
      flowId: "f",
      resumeEvent: { eventType: "G", waitId: "#1", payload: { ok: 1 } },
    } as never);
    const s = await runtime.loadState("a1", runtime.systemOptions());
    expect(s?.status).toBe("completed");
    expect(s?.variables._output).toEqual({ arm: 1 });
  });
});
