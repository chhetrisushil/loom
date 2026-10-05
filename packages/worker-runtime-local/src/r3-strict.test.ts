import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// R3 — a worker explicitly handed the system grant (a recovery/timer re-drive target) keeps working
// when the runtime fails closed on principal-less calls (and the app's own anonymous call must not).
describe("LocalWorkerRuntime under fail-closed execution authz", () => {
  it("starts, suspends, resumes and cancels via the system grant", async () => {
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      executionAuthorizer: executionAccessPolicy(),
      executionAuthz: { requirePrincipal: true },
    });
    const io = { inputSchema: z.any(), outputSchema: z.any() };
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.suspend({ on: "GO" });
      return { ok: true };
    };
    runtime.registerFlow(
      { _tag: "FlowDefinition", id: "f", name: "f", version: "1.0.0", ...io, steps: [] } as never,
      runner
    );
    const worker = new LocalWorkerRuntime(runtime, { system: runtime.systemOptions().system! });
    const lease = await worker.allocate({ executionId: "x1" });
    const first = await worker.execute(lease, {
      executionId: "x1",
      workflowId: "f",
      flowId: "f",
      input: {},
    });
    expect(first.status).toBe("suspended");
    const second = await worker.execute(lease, {
      executionId: "x1",
      workflowId: "f",
      flowId: "f",
      resumeEvent: { eventType: "GO", payload: {} },
    });
    expect(second.status).toBe("completed");
    await worker.execute(lease, { executionId: "x2", workflowId: "f", flowId: "f", input: {} });
    expect(await worker.cancel("x2", "stop")).toBe(true);
    await expect(runtime.loadState("x1")).rejects.toMatchObject({ name: "ExecutionDeniedError" });
  });
});
