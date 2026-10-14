import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage } from "@loom/worker-runtime";
import { LeaseHeldError, StartLeaseHeldError, WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// ADR 0130 D11 (S7c): the worker attempt is a driver. Lease THEN fence; a stand-down takes no fence.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
const runner: FlowRunner<unknown, unknown> = async (ctx) => ctx.run(echo, { a: 1 });
const reg = {
  definition: {
    _tag: "FlowDefinition",
    id: "wf",
    name: "wf",
    version: "1.0.0",
    ...io,
    steps: [echo],
  },
  runner,
} as unknown as RegisteredFlow;

function rig() {
  const calls: string[] = [];
  class Events extends InMemoryAsyncEventStore {
    override async acquireFence(id: string) {
      calls.push(`fence:${id}`);
      return super.acquireFence(id);
    }
  }
  class Leases extends InMemoryLeaseStore {
    override async acquireMany(...a: Parameters<NonNullable<InMemoryLeaseStore["acquireMany"]>>) {
      calls.push(`lease.acquire:${[...a[0]].join(",")}`);
      return super.acquireMany(...a);
    }
    override async releaseMany(...a: Parameters<NonNullable<InMemoryLeaseStore["releaseMany"]>>) {
      calls.push(`lease.release:${[...a[0]].join(",")}`);
      return super.releaseMany(...a);
    }
  }
  const leases = new Leases();
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async (i: unknown) => i));
  const runtime = new WorkflowRuntime({
    eventStore: new Events(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    heartbeat: { leaseStore: leases, nodeId: "w1", every: () => () => {} },
  });
  runtime.registerFlow(reg.definition, reg.runner);
  return { runtime, calls, leases, worker: new LocalWorkerRuntime(runtime) };
}
const pkg = (executionId: string): ExecutionPackage => ({
  executionId,
  workflowId: "wf",
  flowId: "wf",
  input: {},
});

describe("LocalWorkerRuntime holds a heartbeat lease (S7c)", () => {
  it("allocate takes the lease BEFORE the fence; the attempt releases it", async () => {
    const r = rig();
    const lease = await r.worker.allocate({ executionId: "e1" });
    const res = await r.worker.execute(lease, pkg("e1"));
    await r.worker.release(lease);
    expect(res.status).toBe("completed");
    const a = r.calls.findIndex((c) => c === "lease.acquire:e1");
    const f = r.calls.findIndex((c) => c === "fence:e1");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(f).toBeGreaterThan(a);
    expect(await r.leases.get("e1")).toBeNull();
  });

  it("stands down without taking the fence when another live owner holds the lease on a REAL stream", async () => {
    const r = rig();
    const h = await r.runtime.start(reg, {}, { executionId: "e2" }); // a real stream (sequence 0)
    await h.waitForCompletion();
    await r.leases.acquire("e2", "other:1", 60_000);
    r.calls.length = 0;
    await expect(r.worker.allocate({ executionId: "e2" })).rejects.toBeInstanceOf(LeaseHeldError);
    expect(r.calls.some((c) => c.startsWith("fence:"))).toBe(false);
  });

  it("a lease held with NO sequence 0 (a ghost) is a RETRYABLE stand-down, not a superseded refusal (S7c review P1-2)", async () => {
    const r = rig();
    await r.leases.acquire("e4", "crashed:1", 60_000);
    const err = await r.worker.allocate({ executionId: "e4" }).then(
      () => undefined,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(StartLeaseHeldError);
    expect(err).not.toBeInstanceOf(LeaseHeldError);
    expect(r.calls.some((c) => c.startsWith("fence:"))).toBe(false);
  });

  it("release without execute drops the hold", async () => {
    const r = rig();
    const lease = await r.worker.allocate({ executionId: "e3" });
    expect(await r.leases.get("e3")).not.toBeNull();
    await r.worker.release(lease);
    expect(await r.leases.get("e3")).toBeNull();
  });
});
