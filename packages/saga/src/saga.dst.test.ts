import { step$ } from "@loom/core";
import { faultInjectingStore, splitmix64 } from "@loom/dst";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withSaga } from "./saga";

// A failing saga driven under seeded crash faults: whatever the crash schedule, the
// durable log must never show a compensator completed twice (rollback is exactly-once
// per step) — the crash-mid-compensation property.

const empty = z.object({});
const mk = (id: string) =>
  step$({ id, name: id, toolId: id, inputSchema: empty, outputSchema: empty });
const reserve = mk("reserve");
const unreserve = mk("unreserve");
const charge = mk("charge");
const refund = mk("refund");
const ship = mk("ship");

const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) =>
  withSaga(ctx, async (saga) => {
    await saga.run(reserve, {}, unreserve);
    await saga.run(charge, {}, refund);
    await ctx.run(ship, {}); // throws → rollback
    return { ok: true };
  });

const flow = {
  definition: {
    _tag: "FlowDefinition" as const,
    id: "order-saga",
    name: "order-saga",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [reserve, unreserve, charge, refund, ship],
  },
  runner,
} as RegisteredFlow<Record<string, never>, { ok: boolean }>;

function spawnRuntime(
  store: InMemoryAsyncEventStore | ReturnType<typeof faultInjectingStore>["store"],
  snapshots: InMemoryAsyncSnapshotStore
) {
  const effects = new EffectRuntime();
  for (const id of ["reserve", "unreserve", "charge", "refund"]) {
    effects.register(id, new ToolEffect(async () => ({})));
  }
  effects.register(
    "ship",
    new ToolEffect(async () => {
      throw new Error("ship failed");
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: store as never,
    snapshotStore: snapshots,
    effectRuntime: effects,
  });
  runtime.registerFlow(flow.definition, runner);
  return runtime;
}

const EXEC = "saga-dst";

describe("DST — saga rollback under seeded crashes", () => {
  it("never double-compensates, across the crash-schedule space", async () => {
    let sawCrash = false;
    for (let s = 1n; s <= 40n; s++) {
      const inner = new InMemoryAsyncEventStore();
      const snapshots = new InMemoryAsyncSnapshotStore();
      const faults = faultInjectingStore(inner, {
        mode: "explore",
        rng: splitmix64(s).fork("faults"),
        model: { crashBeforeAppend: 0.12 },
      });

      const h1 = await spawnRuntime(faults.store, snapshots).start(flow, {}, { executionId: EXEC });
      await h1.waitForCompletion().catch(() => {}); // the saga fails by design

      const durable = await inner.read(EXEC);
      const terminal = durable.some(
        (e) => e.eventType === "EXECUTION_FAILED" || e.eventType === "EXECUTION_COMPLETED"
      );
      if (durable.length > 0 && !terminal) {
        faults.restore();
        await spawnRuntime(faults.store, snapshots)
          .resume(EXEC, { eventType: "EXECUTION_RECOVERED", payload: {} })
          .then((h) => h.waitForCompletion())
          .catch(() => {});
      }
      if (faults.crashed) sawCrash = true;

      // No step (forward OR compensation) completed more than once in the durable log.
      const completions = new Map<string, number>();
      for (const e of await inner.read(EXEC)) {
        if (e.eventType !== "STEP_COMPLETED") continue;
        const id = (e.payload as { stepId: string }).stepId;
        completions.set(id, (completions.get(id) ?? 0) + 1);
      }
      for (const [id, n] of completions) {
        expect(n, `step ${id} completed ${n}× @seed ${s}`).toBeLessThanOrEqual(1);
      }
    }
    expect(sawCrash).toBe(true);
  });
});
