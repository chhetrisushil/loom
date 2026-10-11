import { flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";

// ── `ctx.decide` survives being passed as a value ─────────────────────────────
//
// Every helper that takes a decider takes it as an OPTION — `TieredMemory.recall
// ({ decide })`, `recallRelevant({ decide })` — and the documented spelling is
// `decide: ctx.decide`. Unbound, that loses its receiver and dies inside the
// context on `this.vm`, with a TypeError that names neither `decide` nor binding.
// Two call sites in `agentLoop$` carried a hand-written wrapper to dodge it.

describe("ctx.decide binding", () => {
  const Noop = step$({
    id: "noop",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    handler: handler$(async () => ({ ok: true })),
  });

  const definition = flow$({
    id: "decide-binding",
    name: "decide binding",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ choice: z.string() }),
    steps: [Noop],
  });

  it("works when handed to a helper as a bare function reference", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });

    // Exactly what an application writes — no wrapper lambda, no `.bind`.
    const useSomeoneElsesDecide = async (
      decide: <T>(id: string, decider: () => T | Promise<T>) => Promise<T>
    ): Promise<string> => decide("pick", () => "recorded");

    const handle = await runtime.start(
      { definition, runner: async (ctx) => ({ choice: await useSomeoneElsesDecide(ctx.decide) }) },
      {}
    );
    const state = await handle.waitForCompletion();
    expect((state.variables._output as { choice: string }).choice).toBe("recorded");

    const events = await eventStore.read(handle.executionId);
    expect(events.filter((e) => e.eventType === "DECISION_RECORDED")).toHaveLength(1);
  });
});
