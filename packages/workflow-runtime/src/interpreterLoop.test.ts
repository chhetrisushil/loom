import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── ADR 0061 — the interpreter pattern crash matrix (DE-5) ───────────────────
//
// A statically compiled flow issuing ctx.run inside a loop bounded by
// runtime-loaded plan data, ids minted `apply#${i}` per the identity rule.
// Crash simulation is PREFIX CONSTRUCTION: a process death after k applied
// steps leaves exactly EXECUTION_STARTED + k × (STEP_STARTED, STEP_COMPLETED)
// durable (status still "running" — no terminal event). Recovery folds that
// prefix and re-dispatches via restoreFromState; the identity rule guarantees
// the re-run re-derives the same id sequence from the logged input, so only
// the unfinished steps invoke the effect.

type In = { plan: string[] };
type Out = { applied: string[] };

const flowDef: FlowDefinition<In, Out> = {
  _tag: "FlowDefinition",
  id: "interpreter",
  name: "interpreter",
  version: "1.0.0",
  inputSchema: z.object({ plan: z.array(z.string()) }) as z.ZodSchema<In>,
  outputSchema: z.object({ applied: z.array(z.string()) }) as z.ZodSchema<Out>,
  steps: [], // the interpreter's steps are dynamic — deliberately outside the static list
};

const runner: FlowRunner<In, Out> = async (ctx, input) => {
  const applied: string[] = [];
  for (const [i, item] of input.plan.entries()) {
    const out = await ctx.run(
      step$({
        id: `apply#${i}`,
        toolId: "apply",
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
      }),
      { item }
    );
    applied.push((out as { item: string }).item);
  }
  return { applied };
};

function boot(eventStore = new InMemoryAsyncEventStore()) {
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const effectRuntime = new EffectRuntime();
  const invocations: Array<{ item: string }> = [];
  effectRuntime.register(
    "apply",
    new ToolEffect(async (input) => {
      invocations.push(input as { item: string });
      return input;
    })
  );
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
  const flow: RegisteredFlow<In, Out> = { definition: flowDef, runner };
  runtime.registerFlow(flowDef, runner);
  return { runtime, eventStore, invocations, flow };
}

const PLAN = ["a", "b", "c", "d"];

/** Timestamps vary run-to-run; identity/structure must not. */
function stripTimes(frames: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(frames).map(([id, f]) => {
      const { startedAt, firstStartedAt, completedAt, ...rest } = f as Record<string, unknown>;
      return [id, rest];
    })
  );
}

async function referenceRun() {
  const ref = boot();
  const handle = await ref.runtime.start(ref.flow, { plan: PLAN }, { executionId: "interp" });
  const state = await handle.waitForCompletion();
  return { state, events: await ref.eventStore.read("interp"), invocations: ref.invocations };
}

describe("interpreter-pattern crash matrix (ADR 0061)", () => {
  it("applies the whole plan, one invocation per dynamically-minted step id", async () => {
    const { state, events, invocations } = await referenceRun();
    expect(state.status).toBe("completed");
    expect(invocations.map((i) => i.item)).toEqual(PLAN);
    const started = events.filter((e) => e.eventType === "STEP_STARTED");
    expect(started.map((e) => (e.payload as { stepId: string }).stepId)).toEqual(
      PLAN.map((_, i) => `apply#${i}`)
    );
  });

  it.each([0, 1, 2, 3, 4])(
    "crash after %i applied step(s): recovery re-executes only the remainder and folds identically",
    async (k) => {
      const ref = await referenceRun();

      // The durable residue of a process death after k applied steps.
      const prefix: EventEnvelope[] = ref.events.slice(0, 1 + 2 * k);
      const store = new InMemoryAsyncEventStore();
      for (const e of prefix) await store.append(e);

      const recovery = boot(store);
      const folded = new ReplayVM(prefix, {
        executionId: "interp",
        workflowId: "interpreter",
        workflowVersion: "1.0.0",
      }).getState();
      expect(folded.status).toBe("running"); // no terminal event — a real crash, not a failure

      const handle = await recovery.runtime.restoreFromState(folded);
      const state = await handle.waitForCompletion();

      expect(state.status).toBe("completed");
      // Only the unfinished steps ran.
      expect(recovery.invocations.map((i) => i.item)).toEqual(PLAN.slice(k));
      // The recovered fold matches the uncrashed one (identity is a pure
      // function of the logged plan).
      expect(stripTimes(state.frames)).toEqual(stripTimes(ref.state.frames));
      // And the completed log's step sequence is identical.
      const started = (await store.read("interp")).filter((e) => e.eventType === "STEP_STARTED");
      expect(started.map((e) => (e.payload as { stepId: string }).stepId)).toEqual(
        PLAN.map((_, i) => `apply#${i}`)
      );
    }
  );

  it("crash after ALL steps but before EXECUTION_COMPLETED: recovery invokes nothing", async () => {
    const ref = await referenceRun();
    const prefix = ref.events.slice(0, 1 + 2 * PLAN.length); // everything but the terminal event
    const store = new InMemoryAsyncEventStore();
    for (const e of prefix) await store.append(e);

    const recovery = boot(store);
    const handle = await recovery.runtime.restoreFromState(
      new ReplayVM(prefix, {
        executionId: "interp",
        workflowId: "interpreter",
        workflowVersion: "1.0.0",
      }).getState()
    );
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(recovery.invocations).toHaveLength(0); // pure replay — every frame substituted
    expect(stripTimes(state.frames)).toEqual(stripTimes(ref.state.frames));
  });
});
