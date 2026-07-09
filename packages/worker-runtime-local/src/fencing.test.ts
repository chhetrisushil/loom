import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage } from "@loom/worker-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// K9.4 — the zombie-worker scenario fencing exists for: worker A is dispatched an
// execution, stalls (partition / presumed dead), the execution is re-dispatched to
// worker B under a NEWER fence token, B completes it — and then A wakes up and
// tries to write. A's stale-fenced append must be rejected at the shared store, so
// the durable log contains exactly one version of history (B's).

const FLOW = "fenced-flow";
const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });

const slowStep = step$({
  id: "slow",
  name: "Slow",
  toolId: "slow-tool",
  inputSchema,
  outputSchema,
});

const runner: FlowRunner<{ n: number }, { done: boolean }> = async (ctx, input) => {
  return await ctx.run(slowStep, { n: input.n });
};

function flowDef(): RegisteredFlow<{ n: number }, { done: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: FLOW,
      name: FLOW,
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [slowStep],
    },
    runner,
  } as RegisteredFlow<{ n: number }, { done: boolean }>;
}

const pkg: ExecutionPackage = {
  executionId: "fence-1",
  workflowId: FLOW,
  flowId: FLOW,
  input: { n: 1 },
};

function bootNode(
  eventStore: InMemoryAsyncEventStore,
  snapshotStore: InMemoryAsyncSnapshotStore,
  slowFn: () => Promise<{ done: boolean }>,
  onStorageError?: (executionId: string, err: unknown) => void
) {
  const effects = new EffectRuntime();
  effects.register("slow-tool", new ToolEffect(slowFn));
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    ...(onStorageError !== undefined && { onStorageError }),
  });
  runtime.registerFlow(flowDef().definition, runner);
  return new LocalWorkerRuntime(runtime);
}

async function waitFor(pred: () => Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !(await pred()); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("worker fencing (K9.4)", () => {
  it("allocate() acquires a monotonic fence from a fencing store", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshots = new InMemoryAsyncSnapshotStore();
    const worker = bootNode(eventStore, snapshots, async () => ({ done: true }));

    const leaseA = await worker.allocate({ executionId: "x" });
    const leaseB = await worker.allocate({ executionId: "x" });
    expect(leaseA.fence).toBe(1);
    expect(leaseB.fence).toBe(2);
  });

  it("a re-dispatched execution fences out its zombie predecessor's writes", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshots = new InMemoryAsyncSnapshotStore();

    // Node A: the slow step blocks on a deferred we control — a stall, not a crash.
    let releaseA!: () => void;
    const stalled = new Promise<{ done: boolean }>((resolve) => {
      releaseA = () => resolve({ done: true });
    });
    const storageErrors: unknown[] = [];
    const workerA = bootNode(
      eventStore,
      snapshots,
      () => stalled,
      (_id, err) => storageErrors.push(err)
    );

    const leaseA = await workerA.allocate({ executionId: pkg.executionId });
    expect(leaseA.fence).toBe(1);
    const resultA = workerA.execute(leaseA, pkg); // don't await — it stalls in the step

    // Wait until A's STEP_STARTED is durable, then declare A dead and re-dispatch.
    await waitFor(async () => {
      const events = await eventStore.read(pkg.executionId);
      return events.some((e: EventEnvelope) => e.eventType === "STEP_STARTED");
    });

    // Node B: fresh runtime over the SAME stores; allocate → fence 2; recovery
    // resume re-runs the in-flight step (undeclared tool → legacy re-run).
    const workerB = bootNode(eventStore, snapshots, async () => ({ done: true }));
    const leaseB = await workerB.allocate({ executionId: pkg.executionId });
    expect(leaseB.fence).toBe(2);
    const resultB = await workerB.execute(leaseB, pkg);
    expect(resultB.status).toBe("completed");
    expect(resultB.output).toEqual({ done: true });

    // The zombie wakes up and tries to write its STEP_COMPLETED under fence 1.
    releaseA();
    await expect(resultA).rejects.toThrow(); // A's run dies on the rejected write
    await waitFor(async () => storageErrors.length > 0);
    expect(String(storageErrors[0])).toMatch(/stale fence/);

    // Exactly ONE version of history: B's completion, none of A's post-fence writes.
    const events = await eventStore.read(pkg.executionId);
    const completions = events.filter((e: EventEnvelope) => e.eventType === "STEP_COMPLETED");
    expect(completions.length).toBe(1);
    const fenced = completions[0]?.metadata as { fence?: number };
    expect(fenced.fence).toBe(2);
    expect(
      events.filter((e: EventEnvelope) => e.eventType === "EXECUTION_COMPLETED").length
    ).toBe(1);
  });

  it("keeps working with no fencing involved on a non-fencing store (G2)", async () => {
    // SqliteEventStore has no acquireFence — simulate with a store wrapper that
    // hides the method, proving the worker path degrades to a plain lease.
    const inner = new InMemoryAsyncEventStore();
    const unfenced = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "acquireFence") return undefined;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const snapshots = new InMemoryAsyncSnapshotStore();
    const worker = bootNode(unfenced as InMemoryAsyncEventStore, snapshots, async () => ({
      done: true,
    }));

    const lease = await worker.allocate({ executionId: pkg.executionId });
    expect(lease.fence).toBeUndefined();
    const result = await worker.execute(lease, pkg);
    expect(result.status).toBe("completed");
    // No fence metadata stamped anywhere.
    const events = await inner.read(pkg.executionId);
    expect(events.every((e: EventEnvelope) => e.metadata?.fence === undefined)).toBe(true);
  });
});
