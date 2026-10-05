import { LocalDispatcher } from "@loom/dispatcher";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// R3 round 1 (P1-1) — a dispatcher-routed caller must NOT silently become the system identity.

const alice = { actor: "alice", tenant: "t1" };
const mallory = { actor: "mallory", tenant: "t1" };
const io = { inputSchema: z.any(), outputSchema: z.any() };

async function build() {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    executionAuthorizer: executionAccessPolicy({
      rules: { resume: "owner", query: "owner", cancel: "owner" },
    }),
    executionAuthz: { requirePrincipal: true },
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    const r = (await ctx.suspend({ on: "GO" })) as unknown;
    return { approved: r };
  };
  runtime.registerFlow(
    { _tag: "FlowDefinition", id: "f", name: "f", version: "1.0.0", ...io, steps: [] } as never,
    runner
  );
  const h = await runtime.start("f", {}, { executionId: "a1", principal: alice });
  await h.waitForSuspend();
  return runtime;
}
const pkg = (executionId: string, extra: object = {}) => ({
  executionId,
  workflowId: "f",
  flowId: "f",
  ...extra,
});

describe("P1-1 — LocalWorkerRuntime holds no system grant by default", () => {
  it("an anonymous dispatch cannot read (query bypass) or approve another actor's execution", async () => {
    const runtime = await build();
    const d = new LocalDispatcher(new LocalWorkerRuntime(runtime));
    await expect(d.dispatch(pkg("a1"))).rejects.toMatchObject({ name: "ExecutionDeniedError" });
    await expect(
      d.dispatch(pkg("a1", { resumeEvent: { eventType: "GO", payload: { by: "anon" } } }))
    ).rejects.toMatchObject({ name: "ExecutionDeniedError" });
    expect((await runtime.loadState("a1", { principal: alice }))?.status).toBe("suspended");
  });

  it("a dispatch carrying the owner's principal works; another actor's principal is refused", async () => {
    const runtime = await build();
    const d = new LocalDispatcher(new LocalWorkerRuntime(runtime));
    await expect(d.dispatch(pkg("a1", { principal: mallory }))).rejects.toMatchObject({
      name: "ExecutionDeniedError",
    });
    const fresh = await d.dispatch(pkg("a2", { input: {}, principal: alice }));
    expect(fresh.status).toBe("suspended");
    const done = await d.dispatch(
      pkg("a2", { resumeEvent: { eventType: "GO", payload: 1 }, principal: alice })
    );
    expect(done.status).toBe("completed");
  });

  it("an explicit trusted `system` option serves principal-less packages (recovery targets) but a package principal still wins", async () => {
    const runtime = await build();
    const worker = new LocalWorkerRuntime(runtime, { system: runtime.systemOptions().system! });
    expect(worker.runsAsSystem).toBe(true);
    const d = new LocalDispatcher(worker);
    expect((await d.dispatch(pkg("a1"))).status).toBe("suspended"); // re-drive: no principal
    await expect(d.dispatch(pkg("a1", { principal: mallory }))).rejects.toMatchObject({
      name: "ExecutionDeniedError",
    });
    expect(new LocalWorkerRuntime(runtime).runsAsSystem).toBe(false);
  });

  it("cancel through a worker with no grant is refused under strict (false), granted works", async () => {
    const runtime = await build();
    expect(await new LocalWorkerRuntime(runtime).cancel("a1", "x")).toBe(false);
    expect(
      await new LocalWorkerRuntime(runtime, { system: runtime.systemOptions().system! }).cancel(
        "a1",
        "x"
      )
    ).toBe(true);
  });
});
