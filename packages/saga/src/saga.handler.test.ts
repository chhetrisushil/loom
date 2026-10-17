import { handler$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SagaCompensationError, withSaga } from "./saga";

// Compensators declared with `handler$` and NO `toolId`: the runtime registers their effect
// under the declared step id, so the derived `<id>#compensate:<i>` journal id must still
// resolve its effect on the declared one.

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };

function build(opts: { grants?: Record<string, string[]>; failUndoB?: boolean } = {}) {
  const ledger: string[] = [];
  const h = (name: string, fail = false) =>
    handler$(async () => {
      ledger.push(name);
      if (fail) throw new Error(`${name} failed`);
      return {};
    });
  const doA = step$({ id: "do-a", name: "do-a", ...io, handler: h("do-a") });
  const undoA = step$({ id: "undo-a", name: "undo-a", ...io, handler: h("undo-a") });
  const doB = step$({ id: "do-b", name: "do-b", ...io, handler: h("do-b") });
  const undoB = step$({
    id: "undo-b",
    name: "undo-b",
    ...io,
    handler: h("undo-b", opts.failUndoB),
  });
  // Mixed: a toolId-backed compensator registered as an explicit effect.
  const doC = step$({ id: "do-c", name: "do-c", ...io, handler: h("do-c") });
  const undoC = step$({ id: "undo-c", name: "undo-c", toolId: "undo-c-tool", ...io });
  const boom = step$({ id: "boom", name: "boom", ...io, handler: h("boom", true) });

  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) =>
    withSaga(ctx, async (saga) => {
      await saga.run(doA, {}, undoA);
      await saga.run(doB, {}, undoB);
      await saga.run(doC, {}, undoC);
      await ctx.run(boom, {});
      return { ok: true };
    });
  const definition = {
    _tag: "FlowDefinition",
    id: "order-saga",
    name: "order-saga",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [doA, undoA, doB, undoB, doC, undoC, boom],
  } satisfies FlowDefinition<Record<string, never>, { ok: boolean }>;
  const flow = { definition, runner } as RegisteredFlow<Record<string, never>, { ok: boolean }>;

  const effects = new EffectRuntime(
    [],
    opts.grants === undefined ? {} : { authorizer: new GrantTable(opts.grants) }
  );
  effects.register(
    "undo-c-tool",
    new ToolEffect(async () => {
      ledger.push("undo-c");
      return {};
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  runtime.registerFlow(definition, runner);
  return { runtime, flow, eventStore, ledger };
}

const run = (b: ReturnType<typeof build>, id: string) =>
  b.runtime.start(b.flow, {}, { executionId: id }).then((h) => h.waitForCompletion());

describe("saga with handler$ compensators", () => {
  it("rolls back fully in reverse (handler$-only and mixed toolId), journaling each distinctly", async () => {
    const b = build();
    await expect(run(b, "h1")).rejects.toThrow(/boom failed/);
    expect(b.ledger).toEqual(["do-a", "do-b", "do-c", "boom", "undo-c", "undo-b", "undo-a"]);

    const done = (await b.eventStore.read("h1"))
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId)
      .filter((s) => s.includes("#compensate:"));
    expect(done).toEqual(["undo-c#compensate:2", "undo-b#compensate:1", "undo-a#compensate:0"]);
  });

  it("runs under strict grants keyed on the ORIGINAL ids, and a missing grant is still denied", async () => {
    const all = ["do-a", "undo-a", "do-b", "undo-b", "do-c", "undo-c-tool", "boom"];
    const ok = build({ grants: { "order-saga": all } });
    await expect(run(ok, "g1")).rejects.toThrow(/boom failed/);
    expect(ok.ledger).toEqual(["do-a", "do-b", "do-c", "boom", "undo-c", "undo-b", "undo-a"]);

    // No grant for undo-b: authority is NOT widened — that compensator is denied, the
    // others still run, and the original error is preserved as the cause.
    const denied = build({ grants: { "order-saga": all.filter((t) => t !== "undo-b") } });
    const err = await run(denied, "g2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SagaCompensationError);
    expect(((err as Error).cause as Error).message).toMatch(/boom failed/);
    expect((err as SagaCompensationError).compensationErrors).toHaveLength(1);
    expect(denied.ledger).toEqual(["do-a", "do-b", "do-c", "boom", "undo-c", "undo-a"]);
  });

  it("a failing compensator does not stop the rest and the original error survives as cause", async () => {
    const b = build({ failUndoB: true });
    const err = await run(b, "f1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SagaCompensationError);
    expect(((err as Error).cause as Error).message).toMatch(/boom failed/);
    expect(((err as SagaCompensationError).compensationErrors[0] as Error).message).toMatch(
      /undo-b failed/
    );
    expect(b.ledger).toEqual(["do-a", "do-b", "do-c", "boom", "undo-c", "undo-b", "undo-a"]);
  });
});
