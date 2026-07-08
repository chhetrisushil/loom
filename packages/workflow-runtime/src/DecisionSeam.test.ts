import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// M2 (Loom 2.0, P9) — the Decision seam. `ctx.decide` records an optimizer's choice
// as a durable DECISION_RECORDED event; on replay/resume the recorded choice is
// served and the optimizer is never re-consulted, so a single run replays purely
// (P2) even though outcomes may change run-to-run.

const inputSchema = z.object({ id: z.string() });
const outputSchema = z.object({ model: z.string() });

const finalizeStep = step$({
  id: "finalize",
  name: "Finalize",
  toolId: "finalize-tool",
  inputSchema: z.object({ model: z.string() }),
  outputSchema: z.object({ done: z.boolean() }),
});

function makeFlow(
  runner: FlowRunner<{ id: string }, { model: string }>
): RegisteredFlow<{ id: string }, { model: string }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "decide-flow",
      name: "Decide Flow",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [finalizeStep],
    },
    runner,
  };
}

describe("M2 — Decision seam (ctx.decide / DECISION_RECORDED)", () => {
  it("records a decision once; replay serves it without re-invoking the optimizer", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "finalize-tool",
      new ToolEffect(vi.fn().mockResolvedValue({ done: true }))
    );

    // The optimizer returns a DIFFERENT value each call — so if replay wrongly
    // re-ran it, the observed choice would change and the assertions would fail.
    let calls = 0;
    const optimizer = vi.fn(() => `model-${++calls}`);
    const seenChoices: string[] = [];

    const runner: FlowRunner<{ id: string }, { model: string }> = async (ctx) => {
      const model = await ctx.decide("route:model", () => optimizer(), { source: "test" });
      seenChoices.push(model);
      await ctx.suspend({ on: "Approved" });
      await ctx.run(finalizeStep, { model });
      return { model };
    };

    // ── First run: decide, then suspend. Optimizer consulted exactly once. ──
    const runtime1 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime1.registerFlow(makeFlow(runner).definition, runner);
    const handle1 = await runtime1.start(makeFlow(runner), { id: "x" });
    const suspended = await handle1.waitForSuspend();

    expect(suspended.status).toBe("suspended");
    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(seenChoices).toEqual(["model-1"]);

    // The choice is durably in the log.
    const events = await eventStore.read(handle1.executionId);
    const decision = events.find((e) => e.eventType === "DECISION_RECORDED");
    expect(decision?.payload).toMatchObject({
      decisionId: "route:model",
      choice: "model-1",
      source: "test",
    });

    // ── Resume on a fresh runtime sharing the stores. The flow re-runs from the
    // top; decide short-circuits from the log; the optimizer is NOT called again. ──
    const runtime2 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime2.registerFlow(makeFlow(runner).definition, runner);
    const handle2 = await runtime2.resume(handle1.executionId, {
      eventType: "Approved",
      payload: {},
    });
    const final = await handle2.waitForCompletion();

    expect(final.status).toBe("completed");
    expect(optimizer).toHaveBeenCalledTimes(1); // still exactly once
    expect(seenChoices).toEqual(["model-1", "model-1"]); // replay saw the SAME choice
    expect((final.variables._output as { model: string }).model).toBe("model-1");
  });
});
