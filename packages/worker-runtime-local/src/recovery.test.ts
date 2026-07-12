import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import type { ExecutionPackage } from "@loom/worker-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

const incidentSchema = z.object({ incidentId: z.string() });
const resolvedSchema = z.object({ resolved: z.boolean() });
const stepA = step$({
  id: "step-a",
  name: "A",
  toolId: "tool-a",
  inputSchema: incidentSchema,
  outputSchema: z.object({ cpu: z.number() }),
});
const stepB = step$({
  id: "step-b",
  name: "B",
  toolId: "tool-b",
  inputSchema: incidentSchema,
  outputSchema: z.object({ fixed: z.boolean() }),
});
const FLOW = "two-step";
const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx, input) => {
  await ctx.run(stepA, { incidentId: input.incidentId });
  await ctx.run(stepB, { incidentId: input.incidentId });
  return { resolved: true };
};
function flowDef() {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: FLOW,
      name: FLOW,
      version: "1.0.0",
      inputSchema: incidentSchema,
      outputSchema: resolvedSchema,
      steps: [stepA, stepB],
    },
    runner,
  } as RegisteredFlow<{ incidentId: string }, { resolved: boolean }>;
}

const pkg: ExecutionPackage = {
  executionId: "rec-1",
  workflowId: FLOW,
  flowId: FLOW,
  input: { incidentId: "i1" },
};

describe("failure recovery — worker rebuilds from durable state, no restart", () => {
  let dbDir: string;
  let eventsPath: string;
  let snapsPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "loom-recovery-"));
    eventsPath = join(dbDir, "events.db");
    snapsPath = join(dbDir, "snapshots.db");
  });
  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  function bootInstance(bFn: () => Promise<unknown>, aFn: () => Promise<unknown>) {
    const effects = new EffectRuntime();
    effects.register("tool-a", new ToolEffect(aFn as never));
    effects.register("tool-b", new ToolEffect(bFn as never));
    const eventStore = new SqliteEventStore(eventsPath);
    const snapshotStore = new SqliteSnapshotStore(snapsPath);
    const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
    runtime.registerFlow(flowDef().definition, runner);
    return { runtime, eventStore, snapshotStore };
  }

  it("resumes a crashed, mid-flight execution on a fresh instance — step A not re-run", async () => {
    // Instance A: step A resolves and persists; step B hangs forever → the flow
    // never reaches a terminal event. We detect A's step-A completion, then
    // abandon the instance (simulating a hard crash), leaving durable status
    // "running".
    const aFn1 = vi.fn(async () => ({ cpu: 87 }));
    const bHang = vi.fn(() => new Promise<never>(() => {}));
    const a = bootInstance(bHang, aFn1);
    const workerA = new LocalWorkerRuntime(a.runtime);

    const leaseA = await workerA.allocate({ executionId: pkg.executionId });
    // Don't await — it hangs in step B on purpose.
    void workerA.execute(leaseA, pkg);

    // Wait until step A is durably committed.
    const sawStepA = async (): Promise<boolean> => {
      const events = await a.eventStore.read(pkg.executionId);
      return events.some(
        (e: EventEnvelope) =>
          e.eventType === "STEP_COMPLETED" && (e.payload as { stepId?: string }).stepId === "step-a"
      );
    };
    for (let i = 0; i < 200 && !(await sawStepA()); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await sawStepA()).toBe(true);
    a.eventStore.close();
    a.snapshotStore.close();

    // Instance B: fresh runtime over the SAME SQLite files. Step A here MUST NOT
    // run (it's already completed); step B now succeeds.
    const aFn2 = vi.fn(async () => ({ cpu: 999 }));
    const bFn2 = vi.fn(async () => ({ fixed: true }));
    const b = bootInstance(bFn2, aFn2);
    const workerB = new LocalWorkerRuntime(b.runtime);

    // Redispatch the SAME fresh-start package (as a crash-recovery would): the
    // worker sees durable "running" state and resumes instead of restarting.
    const leaseB = await workerB.allocate({ executionId: pkg.executionId });
    const result = await workerB.execute(leaseB, pkg);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ resolved: true });
    expect(aFn2).toHaveBeenCalledTimes(0); // completed step A was replayed from events
    expect(bFn2).toHaveBeenCalledTimes(1); // only the in-flight tail ran

    // No restart: exactly one EXECUTION_STARTED in the durable log.
    const events = await b.eventStore.read(pkg.executionId);
    expect(events.filter((e: EventEnvelope) => e.eventType === "EXECUTION_STARTED").length).toBe(1);
    b.eventStore.close();
    b.snapshotStore.close();
  });

  it("is idempotent on a lost-response redispatch of an already-completed execution", async () => {
    const aFn = vi.fn(async () => ({ cpu: 87 }));
    const bFn = vi.fn(async () => ({ fixed: true }));
    const inst = bootInstance(bFn, aFn);
    const worker = new LocalWorkerRuntime(inst.runtime);

    const lease = await worker.allocate({ executionId: pkg.executionId });
    const first = await worker.execute(lease, pkg);
    expect(first.status).toBe("completed");

    // Redispatch the same package (worker "responded" but caller lost it and retried).
    const second = await worker.execute(lease, pkg);
    expect(second.status).toBe("completed");
    expect(second.output).toEqual({ resolved: true });
    // No effect re-ran and no second EXECUTION_STARTED.
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
    const events = await inst.eventStore.read(pkg.executionId);
    expect(events.filter((e: EventEnvelope) => e.eventType === "EXECUTION_STARTED").length).toBe(1);
    inst.eventStore.close();
    inst.snapshotStore.close();
  });
});
