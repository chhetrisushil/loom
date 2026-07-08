import { step$ } from "@loom/core";
import type { EventEnvelope, TaskDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// M1 (Loom 2.0) regression: `ctx.execute(task)` is the generalized primitive and
// `ctx.run(step)` is a thin alias for the 'step' task kind. This proves the two
// paths are behaviourally identical (same event stream) and that `execute` also
// accepts a raw TaskDefinition, routing by toolId exactly like a step.

const inputSchema = z.object({ id: z.string() });
const outputSchema = z.object({ ok: z.boolean() });

const stepA = step$({
  id: "step-a",
  name: "Step A",
  toolId: "tool-a",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ a: z.number() }),
});

const stepB = step$({
  id: "step-b",
  name: "Step B",
  toolId: "tool-b",
  inputSchema: z.object({ a: z.number() }),
  outputSchema: z.object({ b: z.number() }),
});

function makeFlow(
  runner: FlowRunner<{ id: string }, { ok: boolean }>
): RegisteredFlow<{ id: string }, { ok: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "parity-flow",
      name: "Parity Flow",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [stepA, stepB],
    },
    runner,
  };
}

function makeRuntime() {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const effectRuntime = new EffectRuntime();
  effectRuntime.register("tool-a", new ToolEffect(vi.fn().mockResolvedValue({ a: 1 })));
  effectRuntime.register("tool-b", new ToolEffect(vi.fn().mockResolvedValue({ b: 2 })));
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
  return { runtime, eventStore };
}

// Strip volatile, run-specific fields (id/executionId/timestamp) so two runs with
// different execution ids can be compared for structural equality of the log.
function normalize(events: EventEnvelope[]) {
  return events.map((e) => ({ eventType: e.eventType, sequence: e.sequence, payload: e.payload }));
}

describe("M1 — ctx.execute / ctx.run parity", () => {
  it("run(step) and execute(step) produce an identical event stream", async () => {
    const viaRun = makeRuntime();
    const runRunner: FlowRunner<{ id: string }, { ok: boolean }> = async (ctx) => {
      const a = await ctx.run(stepA, { id: "x" });
      await ctx.run(stepB, { a: a.a });
      return { ok: true };
    };
    const runHandle = await viaRun.runtime.start(makeFlow(runRunner), { id: "x" });
    await runHandle.waitForCompletion();
    const runEvents = normalize(await viaRun.eventStore.read(runHandle.executionId));

    const viaExecute = makeRuntime();
    const executeRunner: FlowRunner<{ id: string }, { ok: boolean }> = async (ctx) => {
      const a = await ctx.execute(stepA, { id: "x" });
      await ctx.execute(stepB, { a: a.a });
      return { ok: true };
    };
    const execHandle = await viaExecute.runtime.start(makeFlow(executeRunner), { id: "x" });
    await execHandle.waitForCompletion();
    const execEvents = normalize(await viaExecute.eventStore.read(execHandle.executionId));

    expect(execEvents).toEqual(runEvents);
  });

  it("execute accepts a raw TaskDefinition and routes by toolId", async () => {
    const { runtime, eventStore } = makeRuntime();
    const echoTask: TaskDefinition<{ id: string }, { a: number }> = {
      _tag: "TaskDefinition",
      kind: "tool",
      id: "echo",
      toolId: "tool-a", // reuse the registered effect
    };
    const runner: FlowRunner<{ id: string }, { ok: boolean }> = async (ctx) => {
      const r = await ctx.execute(echoTask, { id: "x" });
      expect(r).toEqual({ a: 1 });
      return { ok: true };
    };
    const handle = await runtime.start(makeFlow(runner), { id: "x" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    // The task frame is keyed by the task id, and its effect ran (routed by toolId).
    expect(state.frames.echo?.status).toBe("completed");
    expect(state.frames.echo?.output).toEqual({ a: 1 });

    const events = await eventStore.read(handle.executionId);
    expect(events.some((e) => e.eventType === "STEP_STARTED")).toBe(true);
    expect(events.some((e) => e.eventType === "STEP_COMPLETED")).toBe(true);
  });
});
