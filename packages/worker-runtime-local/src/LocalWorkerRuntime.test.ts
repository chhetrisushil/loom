import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage } from "@loom/worker-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

const incidentSchema = z.object({ incidentId: z.string() });
const resolvedSchema = z.object({ resolved: z.boolean() });

const metricsStep = step$({
  id: "fetch-metrics",
  name: "Fetch Metrics",
  toolId: "metrics-tool",
  inputSchema: incidentSchema,
  outputSchema: z.object({ cpu: z.number() }),
});
const remediationStep = step$({
  id: "apply-remediation",
  name: "Apply Remediation",
  toolId: "remediation-tool",
  inputSchema: incidentSchema,
  outputSchema: z.object({ fixed: z.boolean() }),
});

const FLOW_ID = "investigate-incident";

function makeFlow(
  runner: FlowRunner<{ incidentId: string }, { resolved: boolean }>
): RegisteredFlow<{ incidentId: string }, { resolved: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: FLOW_ID,
      name: "Investigate Incident",
      version: "1.0.0",
      inputSchema: incidentSchema,
      outputSchema: resolvedSchema,
      steps: [metricsStep, remediationStep],
    },
    runner,
  };
}

function makeRuntime(fns?: {
  metricsFn?: () => Promise<unknown>;
  remediationFn?: () => Promise<unknown>;
}) {
  const effectRuntime = new EffectRuntime();
  const metricsFn = fns?.metricsFn ?? vi.fn().mockResolvedValue({ cpu: 87 });
  const remediationFn = fns?.remediationFn ?? vi.fn().mockResolvedValue({ fixed: true });
  effectRuntime.register("metrics-tool", new ToolEffect(metricsFn as never));
  effectRuntime.register("remediation-tool", new ToolEffect(remediationFn as never));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });
  return { runtime, metricsFn, remediationFn };
}

const pkg = (over: Partial<ExecutionPackage> & { executionId: string }): ExecutionPackage => ({
  workflowId: FLOW_ID,
  flowId: FLOW_ID,
  ...over,
});

describe("LocalWorkerRuntime", () => {
  let worker: LocalWorkerRuntime;
  let runtime: WorkflowRuntime;

  const straightThrough: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
    ctx
  ) => {
    await ctx.run(metricsStep, { incidentId: "i1" });
    await ctx.run(remediationStep, { incidentId: "i1" });
    return { resolved: true };
  };

  const withApprovalGate: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
    ctx: WorkflowContext,
    input
  ) => {
    await ctx.run(metricsStep, { incidentId: input.incidentId });
    await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
    await ctx.run(remediationStep, { incidentId: input.incidentId });
    return { resolved: true };
  };

  beforeEach(() => {
    ({ runtime } = makeRuntime());
    worker = new LocalWorkerRuntime(runtime);
  });

  it("runs a fresh package to completion and mirrors output", async () => {
    runtime.registerFlow(makeFlow(straightThrough).definition, straightThrough);

    const lease = await worker.allocate({ executionId: "exec-1" });
    const result = await worker.execute(
      lease,
      pkg({ executionId: "exec-1", input: { incidentId: "i1" } })
    );
    await worker.release(lease);

    expect(result.status).toBe("completed");
    expect(result.executionId).toBe("exec-1");
    expect(result.state.status).toBe("completed");
    expect(result.output).toEqual({ resolved: true });
    expect(result.lastSequence).toBeGreaterThan(0);
  });

  it("returns status:suspended (a normal outcome) at an approval gate", async () => {
    runtime.registerFlow(makeFlow(withApprovalGate).definition, withApprovalGate);

    const lease = await worker.allocate({ executionId: "exec-2" });
    const result = await worker.execute(
      lease,
      pkg({ executionId: "exec-2", input: { incidentId: "cpu-1" } })
    );

    expect(result.status).toBe("suspended");
    expect(result.suspendedOn?.on).toBe("ApprovalGranted");
    expect(result.output).toBeUndefined();
  });

  it("resumes a suspended execution via a fresh package with resumeEvent", async () => {
    runtime.registerFlow(makeFlow(withApprovalGate).definition, withApprovalGate);

    const lease = await worker.allocate({ executionId: "exec-3" });
    const suspended = await worker.execute(
      lease,
      pkg({ executionId: "exec-3", input: { incidentId: "cpu-1" } })
    );
    expect(suspended.status).toBe("suspended");

    const resumed = await worker.execute(
      lease,
      pkg({
        executionId: "exec-3",
        resumeEvent: {
          eventType: "ApprovalGranted",
          payload: { approved: true, approvedBy: "alice" },
        },
      })
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual({ resolved: true });
  });

  it("throws when the package references an unregistered flow", async () => {
    const lease = await worker.allocate({ executionId: "exec-4" });
    await expect(
      worker.execute(lease, pkg({ executionId: "exec-4", flowId: "missing", input: {} }))
    ).rejects.toThrow(/No flow registered/);
  });
});
