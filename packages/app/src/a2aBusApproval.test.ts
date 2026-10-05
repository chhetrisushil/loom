import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, viewDigest } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InProcessA2ABus, unsafeAutoApprove } from "./InProcessA2ABus";

// R13 — the bus must not approve on a human's behalf. It used to resume every parked gate with
// `{ approved: true, approvedBy: "auto" }` when no `onApproval` was supplied.

const io = z.any();

function make(gate = "Approval") {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  let ran = 0;
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
      const r = (await ctx.suspend({
        on: gate,
        ...(gate === "Approval" && { viewDigest: viewDigest({ drop: "users" }) }),
      })) as { approved?: boolean };
      if (r?.approved === true) ran++;
      return { approved: r?.approved === true };
    },
  };
  runtime.registerFlow(flow.definition as never, flow.runner as never);
  const bus = new InProcessA2ABus(runtime);
  bus.registerAgent({ name: "a", description: "a", capabilities: [] } as never);
  bus.registerCapability("cap", "a", flow as never);
  return { runtime, bus, eventStore, ran: () => ran };
}

describe("InProcessA2ABus approvals (R13)", () => {
  it("no onApproval: the gate STAYS suspended — nothing approves it", async () => {
    const { bus, runtime, eventStore, ran } = make();
    const r = await bus.dispatch("cap", {}, "go", { executionId: "x1" });
    expect(r.status).toBe("working");
    expect(r.suspended).toMatchObject({
      gate: "Approval",
      viewDigest: viewDigest({ drop: "users" }),
    });
    const state = await runtime.loadState("x1");
    expect(state?.status).toBe("suspended");
    expect(ran()).toBe(0);
    expect((await eventStore.read("x1")).map((e) => e.eventType)).not.toContain("APPROVAL_GRANTED");
    expect(JSON.stringify(await eventStore.read("x1"))).not.toContain('"auto"');
  });

  it("the legacy gate name the old auto-approve answered (ApprovalGranted) is no longer auto-approved", async () => {
    const { bus, runtime, ran } = make("ApprovalGranted");
    const r = await bus.dispatch("cap", {}, "go", { executionId: "x0" });
    expect(r.status).toBe("working");
    expect((await runtime.loadState("x0"))?.status).toBe("suspended");
    expect(ran()).toBe(0);
  });

  it("an explicit onApproval decides, and its decision is bound to the digest it was shown", async () => {
    const { bus, runtime, ran } = make();
    let seen: unknown;
    const r = await bus.dispatch("cap", {}, "go", {
      executionId: "x2",
      onApproval: async (req) => {
        seen = req;
        return { approved: true, approvedBy: "ops" };
      },
    });
    expect(r.status).toBe("completed");
    expect(seen).toMatchObject({ executionId: "x2", gate: "Approval" });
    expect(ran()).toBe(1);
    expect((await runtime.loadState("x2"))?.status).toBe("completed");
  });

  it("a parked task is resolved later with resolveApproval, still digest-bound", async () => {
    const { bus, ran } = make();
    const parked = await bus.dispatch("cap", {}, "go", { executionId: "x3" });
    expect(parked.status).toBe("working");
    const r = await bus.resolveApproval("x3", { approved: true, approvedBy: "ops" });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
  });

  it("unsafeAutoApprove is the loud opt-in for demos", async () => {
    const { bus, ran } = make();
    const r = await bus.dispatch("cap", {}, "go", {
      executionId: "x4",
      onApproval: unsafeAutoApprove,
    });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
  });
});
