import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import { LocalDispatcher } from "@loom/dispatcher";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import type { ExecutionResult } from "@loom/worker-runtime";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { createWorkerServer } from "@loom/worker-server";
import type { WorkerServer } from "@loom/worker-server";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CloudRunWorkerRuntime } from "./CloudRunWorkerRuntime";
import type { CloudRunConfig, CloudRunPlatform } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────────
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
const GATED = "investigate-gated";
const withGate: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
  ctx: WorkflowContext,
  input
) => {
  await ctx.run(metricsStep, { incidentId: input.incidentId });
  await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
  await ctx.run(remediationStep, { incidentId: input.incidentId });
  return { resolved: true };
};
function gatedFlow(): RegisteredFlow<{ incidentId: string }, { resolved: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: GATED,
      name: GATED,
      version: "1.0.0",
      inputSchema: incidentSchema,
      outputSchema: resolvedSchema,
      steps: [metricsStep, remediationStep],
    },
    runner: withGate,
  } as RegisteredFlow<{ incidentId: string }, { resolved: boolean }>;
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}
const cannedResult: ExecutionResult = {
  executionId: "e1",
  status: "completed",
  lastSequence: 1,
  state: {
    executionId: "e1",
    workflowId: GATED,
    workflowVersion: "1.0.0",
    status: "completed",
    frames: {},
    variables: {},
    sequence: 1,
    startedAt: 0,
    updatedAt: 0,
  },
};

describe("CloudRunWorkerRuntime — placement & sizing", () => {
  it("maps a heavy planning lane to 4 vCPU / 8 GiB via the default policy", async () => {
    const seen: CloudRunConfig[] = [];
    const platform: CloudRunPlatform = {
      async resolveEndpoint(config) {
        seen.push(config);
        return "http://worker.invalid";
      },
    };
    const worker = new CloudRunWorkerRuntime(platform, {
      fetchImpl: vi.fn(async () => okResponse(cannedResult)),
    });
    const dispatcher = new LocalDispatcher(worker);

    await dispatcher.dispatch(
      { executionId: "e1", workflowId: GATED, flowId: GATED, input: {} },
      { lane: "planning" }
    );
    await dispatcher.dispatch(
      { executionId: "e2", workflowId: GATED, flowId: GATED, input: {} },
      { lane: "projection", estimatedCpu: 1 }
    );

    expect(seen[0]).toEqual({ cpu: 4, memoryMb: 8192 });
    expect(seen[1]).toEqual({ cpu: 1, memoryMb: 512 });
  });

  it("rejects when a dispatch exceeds requestTimeoutMs", async () => {
    const platform: CloudRunPlatform = {
      async resolveEndpoint() {
        return "http://worker.invalid";
      },
    };
    const neverResolves = () => new Promise<never>(() => {});
    const worker = new CloudRunWorkerRuntime(platform, {
      requestTimeoutMs: 20,
      fetchImpl: neverResolves as never,
    });
    const lease = await worker.allocate({ executionId: "e1" });
    await expect(
      worker.execute(lease, { executionId: "e1", workflowId: GATED, flowId: GATED, input: {} })
    ).rejects.toThrow(/timed out after 20ms/);
  });
});

// ── Integration: instance-recycling platform (scale-to-zero + cold start) ──────
//
// Each resolveEndpoint boots a FRESH WorkflowRuntime (fresh in-memory state) over
// the SAME SQLite files, and release() tears that instance down. So the suspend
// and the resume are served by two different "cold" instances that share only
// the durable stores — the strongest proof the worker is stateless.

class RecyclingCloudRunPlatform implements CloudRunPlatform {
  requestedConfigs: CloudRunConfig[] = [];
  instanceCount = 0;
  private live: { server: WorkerServer; close: () => void } | undefined;
  readonly logs = { log: () => {} };

  constructor(private readonly dbDir: string) {}

  async resolveEndpoint(config: CloudRunConfig): Promise<string> {
    this.requestedConfigs.push(config);
    this.instanceCount++;
    const effects = new EffectRuntime();
    effects.register("metrics-tool", new ToolEffect(async () => ({ cpu: 87 })));
    effects.register("remediation-tool", new ToolEffect(async () => ({ fixed: true })));
    const eventStore = new SqliteEventStore(join(this.dbDir, "events.db"));
    const snapshotStore = new SqliteSnapshotStore(join(this.dbDir, "snapshots.db"));
    const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
    runtime.registerFlow(gatedFlow().definition, withGate);
    const server = createWorkerServer(new LocalWorkerRuntime(runtime));
    await server.start();
    this.live = {
      server,
      close: () => {
        void eventStore.close();
        void snapshotStore.close();
      },
    };
    return server.url;
  }

  async release(): Promise<void> {
    if (this.live) {
      await this.live.server.stop();
      this.live.close();
      this.live = undefined;
    }
  }
}

describe("CloudRunWorkerRuntime — integration (recycled instances, shared stores)", () => {
  let dbDir: string;
  let platform: RecyclingCloudRunPlatform;
  let dispatcher: LocalDispatcher;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "loom-cloudrun-"));
    platform = new RecyclingCloudRunPlatform(dbDir);
    dispatcher = new LocalDispatcher(new CloudRunWorkerRuntime(platform));
  });
  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("survives suspend→resume across two cold instances", async () => {
    const suspended = await dispatcher.dispatch({
      executionId: "cr-1",
      workflowId: GATED,
      flowId: GATED,
      input: { incidentId: "cpu-1" },
    });
    expect(suspended.status).toBe("suspended");

    const resumed = await dispatcher.dispatch({
      executionId: "cr-1",
      workflowId: GATED,
      flowId: GATED,
      resumeEvent: { eventType: "ApprovalGranted", payload: { approved: true, approvedBy: "op" } },
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toEqual({ resolved: true });
    // Two dispatches ⇒ two freshly-booted instances that shared only SQLite.
    expect(platform.instanceCount).toBe(2);
  });
});
