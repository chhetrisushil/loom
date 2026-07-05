import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteBranchRegistry, SqliteEventStore } from "@loom/event-runtime";
import { SqliteSnapshotStore } from "@loom/snapshot-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

const inputSchema = z.object({ incidentId: z.string() });
const outputSchema = z.object({ resolved: z.boolean() });

const fetchMetricsStep = step$({
  id: "fetch-metrics",
  name: "Fetch Metrics",
  toolId: "metrics-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({ cpu: z.number() }),
});
const fetchLogsStep = step$({
  id: "fetch-logs",
  name: "Fetch Logs",
  toolId: "logs-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({ logs: z.array(z.string()) }),
});
const applyRemediationStep = step$({
  id: "apply-remediation",
  name: "Apply Remediation",
  toolId: "remediation-tool",
  inputSchema: z.object({ cpu: z.number() }),
  outputSchema: z.object({ fixed: z.boolean() }),
});

// A flow that fetches metrics + logs, suspends on approval, then remediates.
// The suspend point is the natural fork point.
const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx, input) => {
  const metrics = await ctx.run(fetchMetricsStep, { incidentId: input.incidentId });
  await ctx.run(fetchLogsStep, { incidentId: input.incidentId });
  await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
  await ctx.run(applyRemediationStep, { cpu: (metrics as { cpu: number }).cpu });
  return { resolved: true };
};

function makeFlow(): RegisteredFlow<{ incidentId: string }, { resolved: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "investigate-incident",
      name: "Investigate Incident",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [fetchMetricsStep, fetchLogsStep, applyRemediationStep],
    },
    runner,
  };
}

/** Fields that legitimately differ between a parent event and its forked copy. */
function normalize(e: EventEnvelope) {
  const { id: _id, executionId: _execId, metadata: _meta, ...rest } = e;
  return rest;
}

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "loom-fork-test-"));
  dbPath = join(dbDir, "loom.db");
});
afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function makeRuntime(overrides?: {
  metricsFn?: () => Promise<unknown>;
  logsFn?: () => Promise<unknown>;
  remediationFn?: () => Promise<unknown>;
}) {
  const eventStore = new SqliteEventStore(dbPath);
  const snapshotStore = new SqliteSnapshotStore(`${dbPath}-snap`);
  const branchRegistry = new SqliteBranchRegistry(`${dbPath}-branch`);
  const effectRuntime = new EffectRuntime();

  const metricsFn = overrides?.metricsFn ?? vi.fn().mockResolvedValue({ cpu: 87 });
  const logsFn = overrides?.logsFn ?? vi.fn().mockResolvedValue({ logs: ["OOM"] });
  const remediationFn = overrides?.remediationFn ?? vi.fn().mockResolvedValue({ fixed: true });

  effectRuntime.register(
    "metrics-tool",
    new ToolEffect(metricsFn as (i: unknown) => Promise<unknown>)
  );
  effectRuntime.register("logs-tool", new ToolEffect(logsFn as (i: unknown) => Promise<unknown>));
  effectRuntime.register(
    "remediation-tool",
    new ToolEffect(remediationFn as (i: unknown) => Promise<unknown>)
  );

  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime, branchRegistry });
  runtime.registerFlow(makeFlow().definition, runner);

  return { runtime, eventStore, snapshotStore, branchRegistry, metricsFn, logsFn, remediationFn };
}

describe("WorkflowRuntime.fork", () => {
  it("materializes child state identical to the parent at the fork point (modulo executionId)", async () => {
    const { runtime } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { incidentId: "i1" });
    const suspendState = await handle.waitForSuspend();
    const S = suspendState.sequence;

    const child = await runtime.fork(handle.executionId, S, { branchName: "spec/alt" });

    expect(child.executionId).not.toBe(handle.executionId);
    expect(child.forkSequence).toBe(S);
    expect(child.state.executionId).toBe(child.executionId);
    // Everything except executionId matches the parent's state at S.
    expect({ ...child.state, executionId: handle.executionId }).toEqual(suspendState);
    expect(child.state.frames["fetch-metrics"]?.status).toBe("completed");
    expect(child.state.frames["fetch-logs"]?.status).toBe("completed");
    expect(child.state.status).toBe("suspended");
  });

  it("leaves the parent log byte-identical (isolation)", async () => {
    const { runtime, eventStore } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { incidentId: "i2" });
    const suspendState = await handle.waitForSuspend();
    const before = eventStore.read(handle.executionId);

    const child = await runtime.fork(handle.executionId, suspendState.sequence, {
      branchName: "spec/alt",
    });
    // Drive the child forward so it appends its own events.
    await (
      await runtime.resume(child.executionId, { eventType: "ApprovalGranted", payload: {} })
    ).waitForCompletion();

    const after = eventStore.read(handle.executionId);
    expect(after).toEqual(before);
    // Parent is still suspended and never remediated.
    expect(after[after.length - 1]!.eventType).toBe("EXECUTION_SUSPENDED");
  });

  it("copies the prefix verbatim (0..S match) and diverges after S", async () => {
    const { runtime, eventStore } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { incidentId: "i3" });
    const suspendState = await handle.waitForSuspend();
    const S = suspendState.sequence;
    const parentPrefix = eventStore.read(handle.executionId);

    const child = await runtime.fork(handle.executionId, S, { branchName: "spec/alt" });
    await (
      await runtime.resume(child.executionId, { eventType: "ApprovalGranted", payload: {} })
    ).waitForCompletion();

    const childEvents = eventStore.read(child.executionId);
    const childPrefix = childEvents.filter((e) => e.sequence <= S);
    // Prefix folds identically — every field except id/executionId/metadata matches.
    expect(childPrefix.map(normalize)).toEqual(parentPrefix.map(normalize));
    // Provenance recorded in the copied events' metadata.
    expect(childPrefix[0]!.metadata?.forkedFrom).toBe(handle.executionId);
    // Divergence: the child has post-S events the parent never got.
    expect(childEvents.some((e) => e.sequence > S)).toBe(true);
    expect(childEvents.map((e) => e.eventType)).toContain("EXECUTION_COMPLETED");
  });

  it("resumes the child cheaply — pre-fork effects are NOT re-run", async () => {
    const { runtime, metricsFn, logsFn, remediationFn } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { incidentId: "i4" });
    const suspendState = await handle.waitForSuspend();
    expect(metricsFn).toHaveBeenCalledTimes(1);
    expect(logsFn).toHaveBeenCalledTimes(1);

    const child = await runtime.fork(handle.executionId, suspendState.sequence, {
      branchName: "spec/alt",
    });
    const finalState = await (
      await runtime.resume(child.executionId, { eventType: "ApprovalGranted", payload: {} })
    ).waitForCompletion();

    expect(finalState.status).toBe("completed");
    // Completed prefix steps short-circuit to cached output — effects run once total.
    expect(metricsFn).toHaveBeenCalledTimes(1);
    expect(logsFn).toHaveBeenCalledTimes(1);
    // Only the post-fork step actually executes.
    expect(remediationFn).toHaveBeenCalledTimes(1);
  });

  it("records lineage and a movable ref; promote picks a winner", async () => {
    const { runtime, branchRegistry } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { incidentId: "i5" });
    const suspendState = await handle.waitForSuspend();
    branchRegistry.putRef({
      name: "main",
      executionId: handle.executionId,
      tip: suspendState.sequence,
      createdAt: 1,
      updatedAt: 1,
    });

    const child = await runtime.fork(handle.executionId, suspendState.sequence, {
      branchName: "spec/alt",
    });

    expect(branchRegistry.getLineage(child.executionId)).toMatchObject({
      parentExecutionId: handle.executionId,
      forkSequence: suspendState.sequence,
    });
    expect(branchRegistry.getRef("spec/alt")!.executionId).toBe(child.executionId);

    branchRegistry.promote("spec/alt", "main");
    expect(branchRegistry.getRef("main")!.executionId).toBe(child.executionId);
  });

  it("rejects an out-of-range fork point", async () => {
    const { runtime } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { incidentId: "i6" });
    const suspendState = await handle.waitForSuspend();
    await expect(runtime.fork(handle.executionId, suspendState.sequence + 100)).rejects.toThrow(
      /Invalid fork point/
    );
    await expect(runtime.fork("nonexistent", 0)).rejects.toThrow(/No execution found/);
  });
});
