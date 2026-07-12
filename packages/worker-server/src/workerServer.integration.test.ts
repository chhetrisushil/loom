import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import { LocalDispatcher } from "@loom/dispatcher";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { RemoteWorkerRuntime } from "@loom/worker-runtime-remote";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkerServer } from "./createWorkerServer";
import type { WorkerServer } from "./createWorkerServer";

// ── Integration: local dispatch → HTTP worker → shared SQLite stores → replay ──
//
// Proves the Step-2 seam end to end: a RemoteWorkerRuntime (HTTP) behind the
// same LocalDispatcher, hitting a stateless worker whose runtime is backed by
// SQLite. Because the worker holds no execution state, a suspend followed by a
// resume — two independent POST /execute calls — works purely by rebuilding from
// the shared stores.

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

const STRAIGHT_FLOW = "investigate-straight";
const GATED_FLOW = "investigate-gated";

const straightThrough: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
  await ctx.run(metricsStep, { incidentId: "i1" });
  await ctx.run(remediationStep, { incidentId: "i1" });
  return { resolved: true };
};

const withGate: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
  ctx: WorkflowContext,
  input
) => {
  await ctx.run(metricsStep, { incidentId: input.incidentId });
  await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
  await ctx.run(remediationStep, { incidentId: input.incidentId });
  return { resolved: true };
};

function flow(id: string, runner: FlowRunner<{ incidentId: string }, { resolved: boolean }>) {
  return {
    definition: {
      _tag: "FlowDefinition",
      id,
      name: id,
      version: "1.0.0",
      inputSchema: incidentSchema,
      outputSchema: resolvedSchema,
      steps: [metricsStep, remediationStep],
    },
    runner,
  } as RegisteredFlow<{ incidentId: string }, { resolved: boolean }>;
}

describe("worker-server integration (local dispatch → HTTP worker → SQLite)", () => {
  let dbDir: string;
  let runtime: WorkflowRuntime;
  let server: WorkerServer;
  let dispatcher: LocalDispatcher;

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "loom-worker-"));
    const effectRuntime = new EffectRuntime();
    effectRuntime.register("metrics-tool", new ToolEffect(async () => ({ cpu: 87 })));
    effectRuntime.register("remediation-tool", new ToolEffect(async () => ({ fixed: true })));

    // The worker's "code bundle": a runtime with flows registered + SQLite stores.
    runtime = new WorkflowRuntime({
      eventStore: new SqliteEventStore(join(dbDir, "events.db")),
      snapshotStore: new SqliteSnapshotStore(join(dbDir, "snapshots.db")),
      effectRuntime,
    });
    runtime.registerFlow(flow(STRAIGHT_FLOW, straightThrough).definition, straightThrough);
    runtime.registerFlow(flow(GATED_FLOW, withGate).definition, withGate);

    server = createWorkerServer(new LocalWorkerRuntime(runtime));
    await server.start();

    // The caller side: same dispatcher API, but placement is now the HTTP worker.
    dispatcher = new LocalDispatcher(new RemoteWorkerRuntime(server.url));
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("exposes /health", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ healthy: true });
  });

  it("runs a straight-through flow to completion over HTTP", async () => {
    const result = await dispatcher.dispatch({
      executionId: "http-1",
      workflowId: STRAIGHT_FLOW,
      flowId: STRAIGHT_FLOW,
      input: { incidentId: "i1" },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ resolved: true });
    // Folded state came back intact across the JSON boundary.
    expect(result.state.frames["fetch-metrics"]?.status).toBe("completed");
    expect(result.state.frames["apply-remediation"]?.status).toBe("completed");
  });

  it("suspends then resumes across two independent POSTs (stateless worker)", async () => {
    const suspended = await dispatcher.dispatch({
      executionId: "http-2",
      workflowId: GATED_FLOW,
      flowId: GATED_FLOW,
      input: { incidentId: "cpu-1" },
    });
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspendedOn?.on).toBe("ApprovalGranted");

    // A fresh dispatch with a resumeEvent — the worker rebuilds from SQLite.
    const resumed = await dispatcher.dispatch({
      executionId: "http-2",
      workflowId: GATED_FLOW,
      flowId: GATED_FLOW,
      resumeEvent: {
        eventType: "ApprovalGranted",
        payload: { approved: true, approvedBy: "alice" },
      },
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual({ resolved: true });
  });

  it("matches in-process LocalWorkerRuntime folded state (frames + status)", async () => {
    // Same flow, run in-process against a separate runtime/store.
    const localEffects = new EffectRuntime();
    localEffects.register("metrics-tool", new ToolEffect(async () => ({ cpu: 87 })));
    localEffects.register("remediation-tool", new ToolEffect(async () => ({ fixed: true })));
    const localRuntime = new WorkflowRuntime({
      eventStore: new SqliteEventStore(join(dbDir, "local-events.db")),
      snapshotStore: new SqliteSnapshotStore(join(dbDir, "local-snapshots.db")),
      effectRuntime: localEffects,
    });
    localRuntime.registerFlow(flow(STRAIGHT_FLOW, straightThrough).definition, straightThrough);
    const localWorker = new LocalWorkerRuntime(localRuntime);
    const lease = await localWorker.allocate({ executionId: "local-1" });
    const localResult = await localWorker.execute(lease, {
      executionId: "local-1",
      workflowId: STRAIGHT_FLOW,
      flowId: STRAIGHT_FLOW,
      input: { incidentId: "i1" },
    });

    const remoteResult = await dispatcher.dispatch({
      executionId: "http-3",
      workflowId: STRAIGHT_FLOW,
      flowId: STRAIGHT_FLOW,
      input: { incidentId: "i1" },
    });

    const shape = (s: typeof localResult.state) => ({
      status: s.status,
      frames: Object.fromEntries(
        Object.entries(s.frames).map(([k, f]) => [k, { status: f.status, output: f.output }])
      ),
      output: s.variables._output,
    });
    expect(shape(remoteResult.state)).toEqual(shape(localResult.state));
  });
});
