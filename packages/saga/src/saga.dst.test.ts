import { handler$, step$ } from "@loom/core";
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

type Kind = "toolId" | "handler";

function makeSaga(kind: Kind) {
  const mk = (id: string) =>
    kind === "toolId"
      ? step$({ id, name: id, toolId: id, inputSchema: empty, outputSchema: empty })
      : step$({
          id,
          name: id,
          inputSchema: empty,
          outputSchema: empty,
          handler: handler$(async () => {
            if (id === "ship") throw new Error("ship failed");
            return {};
          }),
        });
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
    if (kind === "toolId") {
      // handler$ steps register themselves from the declared definition.
      for (const id of ["reserve", "unreserve", "charge", "refund"]) {
        effects.register(id, new ToolEffect(async () => ({})));
      }
      effects.register(
        "ship",
        new ToolEffect(async () => {
          throw new Error("ship failed");
        })
      );
    }
    const runtime = new WorkflowRuntime({
      eventStore: store as never,
      snapshotStore: snapshots,
      effectRuntime: effects,
    });
    runtime.registerFlow(flow.definition, runner);
    return runtime;
  }
  return { flow, spawnRuntime };
}

const EXEC = "saga-dst";

describe.each(["toolId", "handler"] as const)(
  "DST — saga rollback under seeded crashes (%s compensators)",
  (kind) => {
    const { flow, spawnRuntime } = makeSaga(kind);
    it("compensates each step exactly once, across the crash-schedule space", async () => {
      let sawCrash = false;
      let failedRuns = 0;
      for (let s = 1n; s <= 40n; s++) {
        const inner = new InMemoryAsyncEventStore();
        const snapshots = new InMemoryAsyncSnapshotStore();
        const faults = faultInjectingStore(inner, {
          mode: "explore",
          rng: splitmix64(s).fork("faults"),
          model: { crashBeforeAppend: 0.12 },
        });

        const h1 = await spawnRuntime(faults.store, snapshots).start(
          flow,
          {},
          { executionId: EXEC }
        );
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
        // Not vacuous: a run that reached its failure compensated BOTH steps, exactly once.
        const finalLog = await inner.read(EXEC);
        if (finalLog.some((e) => e.eventType === "EXECUTION_FAILED")) {
          expect(completions.get("refund#compensate:1"), `refund @seed ${s}`).toBe(1);
          expect(completions.get("unreserve#compensate:0"), `unreserve @seed ${s}`).toBe(1);
          failedRuns++;
        }
      }
      expect(sawCrash).toBe(true);
      expect(failedRuns).toBeGreaterThan(0);
    });
  }
);

// A compensator that FAILED (an untyped STEP_FAILED) is not a completion: crash right
// after it is journaled, resume, and it is re-run (documented at-least-once) while the
// compensator that COMPLETED before it is served from the log, not re-run.
describe("DST — crash after a failed compensator", () => {
  it("re-runs the failed compensator on resume, never the completed one", async () => {
    const { flow, spawnRuntime: _unused } = makeSaga("toolId");
    void _unused;
    const calls: Record<string, number> = {};
    let unreserveFails = true;
    const inner = new InMemoryAsyncEventStore();
    const snapshots = new InMemoryAsyncSnapshotStore();
    let crashed = false;
    let armed = true;
    const crashing = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== "append") {
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return async (envelope: Parameters<typeof inner.append>[0]) => {
          if (crashed && armed) return; // the process is dead: swallow the tail
          await inner.append(envelope);
          const p = envelope.payload as { stepId?: string };
          if (
            armed &&
            envelope.eventType === "STEP_FAILED" &&
            p.stepId === "unreserve#compensate:0"
          ) {
            crashed = true; // durable up to and including the failed compensator
          }
        };
      },
    });
    const spawn = (store: object) => {
      const effects = new EffectRuntime();
      for (const id of ["reserve", "unreserve", "charge", "refund", "ship"]) {
        effects.register(
          id,
          new ToolEffect(async () => {
            calls[id] = (calls[id] ?? 0) + 1;
            if (id === "ship") throw new Error("ship failed");
            if (id === "unreserve" && unreserveFails) throw new Error("unreserve failed");
            return {};
          })
        );
      }
      const rt = new WorkflowRuntime({
        eventStore: store as never,
        snapshotStore: snapshots,
        effectRuntime: effects,
      });
      rt.registerFlow(flow.definition, flow.runner);
      return rt;
    };

    const h1 = await spawn(crashing).start(flow, {}, { executionId: EXEC });
    await h1.waitForCompletion().catch(() => {});
    expect(crashed).toBe(true);
    expect(calls.unreserve).toBe(1);
    expect(calls.refund).toBe(1);

    armed = false; // reboot
    unreserveFails = false;
    await spawn(inner)
      .resume(EXEC, { eventType: "EXECUTION_RECOVERED", payload: {} })
      .then((h) => h.waitForCompletion())
      .catch(() => {});

    expect(calls.unreserve).toBe(2); // the failed compensator was retried
    expect(calls.refund).toBe(1); // the completed one was not re-run
    const done = (await inner.read(EXEC))
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(done.filter((id) => id === "refund#compensate:1")).toHaveLength(1);
    expect(done.filter((id) => id === "unreserve#compensate:0")).toHaveLength(1);
  });
});
