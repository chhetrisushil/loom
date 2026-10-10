import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { testSurface } from "./testSurface";
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
  inputSchema: z.object({ cpu: z.number(), logs: z.array(z.string()) }),
  outputSchema: z.object({ fixed: z.boolean() }),
});

function makeFlow(
  runner: FlowRunner<{ incidentId: string }, { resolved: boolean }>
): RegisteredFlow<{ incidentId: string }, { resolved: boolean }> {
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

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "loom-wf-test-"));
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
  const effectRuntime = new EffectRuntime();

  const metricsFn = overrides?.metricsFn ?? vi.fn().mockResolvedValue({ cpu: 87 });
  const logsFn = overrides?.logsFn ?? vi.fn().mockResolvedValue({ logs: ["OOM"] });
  const remediationFn = overrides?.remediationFn ?? vi.fn().mockResolvedValue({ fixed: true });

  effectRuntime.register(
    "metrics-tool",
    new ToolEffect(metricsFn as (input: unknown) => Promise<unknown>)
  );
  effectRuntime.register(
    "logs-tool",
    new ToolEffect(logsFn as (input: unknown) => Promise<unknown>)
  );
  effectRuntime.register(
    "remediation-tool",
    new ToolEffect(remediationFn as (input: unknown) => Promise<unknown>)
  );

  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });

  return { runtime, eventStore, snapshotStore, effectRuntime, metricsFn, logsFn, remediationFn };
}

describe("WorkflowRuntime — basic execution", () => {
  it("runs a 3-step flow to completion", async () => {
    const { runtime } = makeRuntime();

    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(fetchMetricsStep, { incidentId: "i1" });
      await ctx.run(fetchLogsStep, { incidentId: "i1" });
      await ctx.run(applyRemediationStep, { cpu: 87, logs: ["OOM"] });
      return { resolved: true };
    };

    const handle = await runtime.start(makeFlow(runner), { incidentId: "i1" });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.frames["fetch-metrics"]?.status).toBe("completed");
    expect(state.frames["fetch-logs"]?.status).toBe("completed");
    expect(state.frames["apply-remediation"]?.status).toBe("completed");
  });

  it("replays completed steps — effect NOT called again", async () => {
    const metricsFn = vi.fn().mockResolvedValue({ cpu: 87 });
    const { runtime } = makeRuntime({ metricsFn });

    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(fetchMetricsStep, { incidentId: "i2" });
      return { resolved: true };
    };

    await (await runtime.start(makeFlow(runner), { incidentId: "i2" })).waitForCompletion();
    expect(metricsFn).toHaveBeenCalledTimes(1);
  });
});

describe("WorkflowRuntime — agent-surface (ctx.ui)", () => {
  it("ctx.ui.* emits durable SURFACE_PATCH events with the right patches", async () => {
    const events: { eventType: string; payload: unknown }[] = [];
    const eventStore = new SqliteEventStore(dbPath);
    const snapshotStore = new SqliteSnapshotStore(`${dbPath}-snap`);
    const effectRuntime = new EffectRuntime();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime,
      surface: testSurface,
      onEvent: (e) => events.push({ eventType: e.eventType, payload: e.payload }),
    });

    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      ctx.ui.set("phase", "investigating");
      ctx.ui.merge("stats", { items: 3 });
      ctx.ui.append("log", "started");
      ctx.ui.increment("steps");
      return { resolved: true };
    };

    await (await runtime.start(makeFlow(runner), { incidentId: "ui-1" })).waitForCompletion();

    const patchEvents = events.filter((e) => e.eventType === "SURFACE_PATCH");
    expect(patchEvents).toHaveLength(4);
    expect(
      patchEvents.map((e) => (e.payload as { patches: { op: string }[] }).patches[0]?.op)
    ).toEqual(["set", "merge", "append", "increment"]);
    expect(patchEvents[0]?.payload).toEqual({
      surface: "ui",
      patches: [{ op: "set", path: "phase", value: "investigating" }],
    });
  });
});

describe("WorkflowRuntime — ctx.ui is injected, not built in (ADR 0114)", () => {
  it("a bare runtime (no `surface` dep) throws a clear error naming the dep on ctx.ui", async () => {
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    let message = "";
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      try {
        (ctx as unknown as { ui: unknown }).ui;
      } catch (e) {
        message = (e as Error).message;
      }
      return { resolved: true };
    };
    await (await runtime.start(makeFlow(runner), { incidentId: "bare" })).waitForCompletion();
    expect(message).toMatch(/ctx\.ui is not available/);
    expect(message).toMatch(/surface/);
    expect(message).toMatch(/ADR 0114/);
  });
});

describe("WorkflowRuntime — suspend and resume", () => {
  it("suspends after 2 steps, then resumes correctly (Phase 5 done criteria)", async () => {
    const metricsFn1 = vi.fn().mockResolvedValue({ cpu: 87 });
    const logsFn1 = vi.fn().mockResolvedValue({ logs: ["OOM"] });

    const { runtime: runtime1, eventStore } = makeRuntime({
      metricsFn: metricsFn1,
      logsFn: logsFn1,
    });

    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
      ctx,
      input
    ) => {
      const metrics = await ctx.run(fetchMetricsStep, { incidentId: input.incidentId });
      const logs = await ctx.run(fetchLogsStep, { incidentId: input.incidentId });
      await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
      await ctx.run(applyRemediationStep, {
        cpu: (metrics as { cpu: number }).cpu,
        logs: (logs as { logs: string[] }).logs,
      });
      return { resolved: true };
    };

    runtime1.registerFlow(makeFlow(runner).definition, runner);

    const handle1 = await runtime1.start(makeFlow(runner), { incidentId: "cpu-001" });
    const executionId = handle1.executionId;
    const suspendState = await handle1.waitForSuspend();

    expect(suspendState.status).toBe("suspended");
    expect(suspendState.suspendedOn?.on).toBe("ApprovalGranted");
    expect(metricsFn1).toHaveBeenCalledTimes(1);
    expect(logsFn1).toHaveBeenCalledTimes(1);

    eventStore.close();

    const metricsFn2 = vi.fn().mockResolvedValue({ cpu: 87 });
    const logsFn2 = vi.fn().mockResolvedValue({ logs: ["OOM"] });
    const remediationFn2 = vi.fn().mockResolvedValue({ fixed: true });

    const {
      runtime: runtime2,
      eventStore: eventStore2,
      snapshotStore: snapshotStore2,
    } = makeRuntime({
      metricsFn: metricsFn2,
      logsFn: logsFn2,
      remediationFn: remediationFn2,
    });

    runtime2.registerFlow(makeFlow(runner).definition, runner);

    const handle2 = await runtime2.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approver: "alice" },
    });
    const finalState = await handle2.waitForCompletion();

    expect(finalState.status).toBe("completed");
    expect(metricsFn2).toHaveBeenCalledTimes(0);
    expect(logsFn2).toHaveBeenCalledTimes(0);
    expect(remediationFn2).toHaveBeenCalledTimes(1);

    eventStore2.close();
    snapshotStore2.close();
  });
});

describe("WorkflowRuntime — cancellation", () => {
  it("cancel() aborts an in-flight effect, records EXECUTION_CANCELLED, and rejects completion — fast", async () => {
    const events: string[] = [];
    const eventStore = new SqliteEventStore(dbPath);
    const snapshotStore = new SqliteSnapshotStore(`${dbPath}-snap`);
    const effectRuntime = new EffectRuntime();

    // A long-running effect that resolves only when its signal aborts, so we can
    // measure how quickly cancellation propagates.
    let observedAbort = false;
    const slowFn = (_input: unknown, ctx: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = ctx.signal;
        if (signal === undefined) return; // never settles; the test would time out
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        });
      });

    effectRuntime.register("metrics-tool", new ToolEffect(slowFn));

    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime,
      onEvent: (e) => events.push(e.eventType),
    });

    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
      ctx,
      input
    ) => {
      await ctx.run(fetchMetricsStep, { incidentId: input.incidentId });
      return { resolved: true };
    };

    const handle = await runtime.start(makeFlow(runner), { incidentId: "cancel-1" });

    // Let the effect start and register its abort listener.
    await new Promise((r) => setTimeout(r, 5));

    handle.cancel(new Error("user cancelled"));
    await expect(handle.waitForCompletion()).rejects.toThrow("user cancelled");

    expect(observedAbort).toBe(true);
    expect(handle.getState().status).toBe("cancelled");
    expect(events).toContain("EXECUTION_CANCELLED");
    expect(events).not.toContain("EXECUTION_FAILED");
    // Cancellation must NOT block on the effect: `slowFn` never self-resolves, so the run completing
    // at all (within the test timeout) is the proof the abort propagated — no wall-clock bound.

    eventStore.close();
    snapshotStore.close();
  });

  it("cancel() is idempotent and records the event only once", async () => {
    const events: string[] = [];
    const eventStore = new SqliteEventStore(dbPath);
    const snapshotStore = new SqliteSnapshotStore(`${dbPath}-snap`);
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "metrics-tool",
      new ToolEffect(
        (_i: unknown, ctx: { signal?: AbortSignal }) =>
          new Promise((_res, rej) =>
            ctx.signal?.addEventListener("abort", () => rej(new Error("x")))
          )
      )
    );
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime,
      onEvent: (e) => events.push(e.eventType),
    });
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
      ctx,
      input
    ) => {
      await ctx.run(fetchMetricsStep, { incidentId: input.incidentId });
      return { resolved: true };
    };
    const handle = await runtime.start(makeFlow(runner), { incidentId: "cancel-2" });
    await new Promise((r) => setTimeout(r, 5));

    handle.cancel();
    handle.cancel();
    handle.cancel();
    await expect(handle.waitForCompletion()).rejects.toThrow();

    expect(events.filter((e) => e === "EXECUTION_CANCELLED")).toHaveLength(1);
    eventStore.close();
    snapshotStore.close();
  });
});

describe("WorkflowRuntime — parallel steps", () => {
  it("executes parallel steps concurrently", async () => {
    const callOrder: string[] = [];
    const metricsFn = vi.fn().mockImplementation(async () => {
      callOrder.push("metrics-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("metrics-end");
      return { cpu: 42 };
    });
    const logsFn = vi.fn().mockImplementation(async () => {
      callOrder.push("logs-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("logs-end");
      return { logs: [] };
    });

    const { runtime } = makeRuntime({ metricsFn, logsFn });

    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
      ctx,
      input
    ) => {
      await ctx.parallel([
        [fetchMetricsStep, { incidentId: input.incidentId }],
        [fetchLogsStep, { incidentId: input.incidentId }],
      ]);
      return { resolved: true };
    };

    const handle = await runtime.start(makeFlow(runner), { incidentId: "parallel-test" });
    await handle.waitForCompletion();

    expect(callOrder).toContain("metrics-start");
    expect(callOrder).toContain("logs-start");
    expect(callOrder[0]).toMatch(/start/);
    expect(callOrder[1]).toMatch(/start/);
  });

  it("parallel with limit:1 serializes execution but preserves result order", async () => {
    const callOrder: string[] = [];
    const metricsFn = vi.fn().mockImplementation(async () => {
      callOrder.push("metrics-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("metrics-end");
      return { cpu: 42 };
    });
    const logsFn = vi.fn().mockImplementation(async () => {
      callOrder.push("logs-start");
      await new Promise((r) => setTimeout(r, 1));
      callOrder.push("logs-end");
      return { logs: ["x"] };
    });

    const { runtime } = makeRuntime({ metricsFn, logsFn });

    let results: unknown[] = [];
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
      ctx,
      input
    ) => {
      results = await ctx.parallel(
        [
          [fetchMetricsStep, { incidentId: input.incidentId }],
          [fetchLogsStep, { incidentId: input.incidentId }],
        ],
        { limit: 1 }
      );
      return { resolved: true };
    };

    await (await runtime.start(makeFlow(runner), { incidentId: "limit-1" })).waitForCompletion();

    // limit:1 forces full serialization — metrics fully completes before logs starts.
    expect(callOrder).toEqual(["metrics-start", "metrics-end", "logs-start", "logs-end"]);
    // Results stay in INPUT order regardless (deterministic replay).
    expect(results).toEqual([{ cpu: 42 }, { logs: ["x"] }]);
  });
});
