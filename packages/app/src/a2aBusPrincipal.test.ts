import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InProcessA2ABus, unsafeAutoApprove } from "./InProcessA2ABus";

// R3 round 1 (P1-1) — the bus's default dispatcher must not turn every caller into the system.

const io = z.any();
const alice = { actor: "alice", tenant: "t1" };
const mallory = { actor: "mallory", tenant: "t1" };

function make(busPrincipal?: Record<string, unknown>) {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    executionAuthorizer: executionAccessPolicy({
      rules: { resume: "owner", query: "owner", cancel: "owner" },
    }),
    executionAuthz: { requirePrincipal: true },
  });
  const flow = {
    definition: {
      _tag: "FlowDefinition" as const,
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
    },
    runner: async (ctx: { suspend: (c: unknown) => Promise<unknown> }) => {
      const r = await ctx.suspend({ on: "ApprovalGranted" });
      return { approved: r };
    },
  };
  runtime.registerFlow(flow.definition as never, flow.runner as never);
  const bus = new InProcessA2ABus(
    runtime,
    undefined,
    busPrincipal !== undefined ? { principal: busPrincipal } : {}
  );
  bus.registerAgent({ name: "a", description: "a", capabilities: [] } as never);
  bus.registerCapability("cap", "a", flow as never);
  return { runtime, bus };
}

describe("InProcessA2ABus under strict execution authz", () => {
  it("refuses a dispatch that names no principal", async () => {
    const { bus } = make();
    await expect(bus.dispatch("cap", {}, "go")).rejects.toMatchObject({
      name: "ExecutionDeniedError",
    });
  });

  it("works with a per-dispatch principal, and with a bus-level default", async () => {
    const a = make();
    const auto = { onApproval: unsafeAutoApprove };
    const r = await a.bus.dispatch("cap", {}, "go", { principal: alice, ...auto });
    expect(r.status).toBe("completed");
    const b = make(alice);
    expect((await b.bus.dispatch("cap", {}, "go", auto)).status).toBe("completed");
    // a per-dispatch principal overrides the bus default
    await expect(
      b.bus.dispatch("cap", {}, "go", { principal: mallory, executionId: "x", ...auto })
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("cannot approve another actor's gate: anonymous and a different principal are refused", async () => {
    const { runtime, bus } = make();
    const h = await runtime.start("f", {}, { executionId: "a2", principal: alice });
    await h.waitForSuspend();
    await expect(bus.dispatch("cap", {}, "go", { executionId: "a2" })).rejects.toMatchObject({
      name: "ExecutionDeniedError",
    });
    await expect(
      bus.dispatch("cap", {}, "go", { executionId: "a2", principal: mallory })
    ).rejects.toMatchObject({ name: "ExecutionDeniedError" });
    expect((await runtime.loadState("a2", { principal: alice }))?.status).toBe("suspended");
  });
});
