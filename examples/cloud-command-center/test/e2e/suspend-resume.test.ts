import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoomApp } from "@loom/app";
import { ToolEffect } from "@loom/effect-runtime";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { createTestApp } from "@loom/testing";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigateIncidentFlow } from "../../src/flows/InvestigateIncident";
import { IncidentProjection } from "../../src/projections/IncidentProjection";
import { MetricsProjection } from "../../src/projections/MetricsProjection";

const INCIDENT_ID = "cpu-001";

const MOCK_METRICS = {
  cpu: { current: 87, threshold: 80 },
  memory: { usedMb: 14000, totalMb: 16000 },
  connections: { active: 450, max: 500 },
};

const MOCK_LOGS = {
  logs: [
    { level: "error", message: "OOM killer invoked", timestamp: Date.now() - 5000 },
    { level: "error", message: "Connection pool exhausted", timestamp: Date.now() - 3000 },
  ],
};

const MOCK_REMEDIATION = {
  success: true,
  summary: "Pod restarted successfully, CPU normalized to 32%",
  appliedAt: Date.now(),
};

interface Runtimes {
  app: LoomApp;
  workflowRuntime: WorkflowRuntime;
  projectionRuntime: InMemoryProjectionRuntime;
}

// `createTestApp` is the same `defineConfig` wiring production uses; a SQLite
// `dir` gives durable stores so a fresh app instance can resume a suspended
// execution (the whole point of this e2e).
function createRuntimes(dir: string): Runtimes {
  const projectionRuntime = new InMemoryProjectionRuntime();
  projectionRuntime.register(MetricsProjection);
  projectionRuntime.register(IncidentProjection);

  const app = createTestApp({
    storage: sqliteStorage({ dir }),
    projectionRuntime,
    flows: [InvestigateIncidentFlow as RegisteredFlow],
  });

  // The AI-triage step has no co-located handler$ (its effect is provided at
  // wiring time), so register a fast deterministic stub here. This keeps the
  // suspend/resume e2e focused and quick — no LLM streaming delay.
  app.runtime.register(
    "ai-triage-tool",
    new ToolEffect(async () => ({
      analysis: "Root cause: connection-pool starvation. Restart the pod.",
    }))
  );

  return { app, workflowRuntime: app.runtime, projectionRuntime };
}

describe("InvestigateIncident — full suspend/resume e2e", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loom-e2e-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch (_e) {
      // ignore cleanup errors
    }
  });

  it("phase 1: executes steps 1+2, emits approval event, and suspends", async () => {
    const metricsSpy = vi.fn().mockResolvedValue(MOCK_METRICS);
    const logsSpy = vi.fn().mockResolvedValue(MOCK_LOGS);

    const { app, workflowRuntime, projectionRuntime } = createRuntimes(tmpDir);
    const eventStore = app.stores.eventStore;
    workflowRuntime.register("metrics-tool", new ToolEffect(metricsSpy));
    workflowRuntime.register("logs-tool", new ToolEffect(logsSpy));

    const handle = await workflowRuntime.start(InvestigateIncidentFlow, {
      incidentId: INCIDENT_ID,
    });

    const state = await handle.waitForSuspend();

    expect(state.status).toBe("suspended");
    expect(state.suspendedOn?.on).toBe("ApprovalGranted");

    expect(metricsSpy).toHaveBeenCalledTimes(1);
    expect(logsSpy).toHaveBeenCalledTimes(1);

    const events = await eventStore.read(handle.executionId);
    expect(events.length).toBeGreaterThanOrEqual(6);

    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("EXECUTION_STARTED");
    expect(eventTypes).toContain("STEP_COMPLETED");
    expect(eventTypes).toContain("APPROVAL_REQUESTED");
    expect(eventTypes).toContain("EXECUTION_SUSPENDED");

    const incidentState = projectionRuntime.getState<{ pendingApproval: boolean; status: string }>(
      "incident",
      handle.executionId
    );
    expect(incidentState.pendingApproval).toBe(true);
    expect(incidentState.status).toBe("awaiting_approval");
  }, 10000);

  it("phase 2: new runtime instance resumes without re-running steps 1+2", async () => {
    const metricsSpy1 = vi.fn().mockResolvedValue(MOCK_METRICS);
    const logsSpy1 = vi.fn().mockResolvedValue(MOCK_LOGS);

    const runtime1 = createRuntimes(tmpDir);
    runtime1.workflowRuntime.register("metrics-tool", new ToolEffect(metricsSpy1));
    runtime1.workflowRuntime.register("logs-tool", new ToolEffect(logsSpy1));
    runtime1.workflowRuntime.register(
      "remediation-tool",
      new ToolEffect(vi.fn().mockResolvedValue(MOCK_REMEDIATION))
    );

    const handle1 = await runtime1.workflowRuntime.start(InvestigateIncidentFlow, {
      incidentId: INCIDENT_ID,
    });
    await handle1.waitForSuspend();
    const executionId = handle1.executionId;

    await runtime1.app.close();

    const metricsSpy2 = vi.fn().mockResolvedValue(MOCK_METRICS);
    const logsSpy2 = vi.fn().mockResolvedValue(MOCK_LOGS);
    const remediationSpy2 = vi.fn().mockResolvedValue(MOCK_REMEDIATION);

    const runtime2 = createRuntimes(tmpDir);
    runtime2.workflowRuntime.register("metrics-tool", new ToolEffect(metricsSpy2));
    runtime2.workflowRuntime.register("logs-tool", new ToolEffect(logsSpy2));
    runtime2.workflowRuntime.register("remediation-tool", new ToolEffect(remediationSpy2));

    const handle2 = await runtime2.workflowRuntime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "ops-team" },
    });

    const finalState = await handle2.waitForCompletion();

    expect(finalState.status).toBe("completed");

    expect(metricsSpy2).toHaveBeenCalledTimes(0);
    expect(logsSpy2).toHaveBeenCalledTimes(0);
    expect(remediationSpy2).toHaveBeenCalledTimes(1);

    const incidentState = runtime2.projectionRuntime.getState<{ status: string; summary?: string }>(
      "incident",
      executionId
    );
    expect(incidentState.status).toBe("resolved");
    expect(incidentState.summary).toContain("CPU normalized");

    await runtime2.app.close();
  }, 15000);
});
