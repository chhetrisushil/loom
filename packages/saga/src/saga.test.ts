import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withSaga } from "./saga";

const empty = z.object({});
const mkStep = (id: string) =>
  step$({ id, name: id, toolId: id, inputSchema: empty, outputSchema: empty });

const reserve = mkStep("reserve");
const unreserve = mkStep("unreserve");
const charge = mkStep("charge");
const refund = mkStep("refund");
const ship = mkStep("ship");

type In = { fail: boolean };

/** A saga flow: reserve → charge → ship, each forward step with a compensator. */
const runner: FlowRunner<In, { ok: boolean }> = async (ctx, input) =>
  withSaga(ctx, async (saga) => {
    await saga.run(reserve, {}, unreserve);
    await saga.run(charge, {}, refund);
    if (input.fail) await ctx.run(ship, {}); // the "ship" tool throws
    return { ok: true };
  });

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "order-saga",
    name: "order-saga",
    version: "1.0.0",
    inputSchema: z.object({ fail: z.boolean() }),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [reserve, unreserve, charge, refund, ship],
  } satisfies FlowDefinition<In, { ok: boolean }>,
  runner,
} as RegisteredFlow<In, { ok: boolean }>;

function build() {
  const ledger: string[] = [];
  const effects = new EffectRuntime();
  for (const id of ["reserve", "unreserve", "charge", "refund"]) {
    effects.register(
      id,
      new ToolEffect(async () => {
        ledger.push(id);
        return {};
      })
    );
  }
  effects.register(
    "ship",
    new ToolEffect(async () => {
      ledger.push("ship");
      throw new Error("ship failed");
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  runtime.registerFlow(flow.definition, runner);
  return { runtime, eventStore, ledger };
}

describe("withSaga", () => {
  it("on success, runs no compensators (byte-identical — forward steps only)", async () => {
    const { runtime, eventStore, ledger } = build();
    const h = await runtime.start(flow, { fail: false }, { executionId: "ok" });
    const state = await h.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(ledger).toEqual(["reserve", "charge"]); // no undo
    const events = await eventStore.read("ok");
    // No compensation frames were ever recorded.
    expect(
      events.some((e) => String((e.payload as { stepId?: string }).stepId).includes("#compensate:"))
    ).toBe(false);
  });

  it("on failure, runs compensators in REVERSE and re-throws", async () => {
    const { runtime, ledger } = build();
    const h = await runtime.start(flow, { fail: true }, { executionId: "bad" });
    await expect(h.waitForCompletion()).rejects.toThrow(/ship failed/);

    // Forward: reserve, charge, ship(throws). Rollback (reverse): refund, unreserve.
    expect(ledger).toEqual(["reserve", "charge", "ship", "refund", "unreserve"]);
  });

  it("records the rollback as durable, replay-safe steps", async () => {
    const { runtime, eventStore } = build();
    await runtime
      .start(flow, { fail: true }, { executionId: "bad2" })
      .then((h) => h.waitForCompletion())
      .catch(() => {});

    const events = await eventStore.read("bad2");
    const completedComp = events
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId)
      .filter((id) => id.includes("#compensate:"));
    // Both compensators completed durably (so a resume/recovery would serve them
    // from the log rather than re-running the undo).
    expect(completedComp.sort()).toEqual(["refund#compensate:1", "unreserve#compensate:0"]);
    expect(events.some((e) => e.eventType === "EXECUTION_FAILED")).toBe(true);
  });
});
