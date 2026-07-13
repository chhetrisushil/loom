import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { diffRuns, recordedStepOutputs, replayAsFixture, scoreRun } from "./eval";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const aStep = step$({ id: "a", name: "A", toolId: "a-tool", ...io });
const bStep = step$({ id: "b", name: "B", toolId: "b-tool", ...io });

const runner: FlowRunner<unknown, { done: boolean }> = async (ctx) => {
  await ctx.run(aStep, {});
  await ctx.run(bStep, {});
  return { done: true };
};
const flow: RegisteredFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "two-step",
    name: "Two Step",
    version: "1.0.0",
    ...io,
    steps: [aStep, bStep],
  },
  runner: runner as FlowRunner<unknown, unknown>,
} as RegisteredFlow;

/** Run the flow to completion and return its recorded event log (the fixture). */
async function recordRun(aOut: unknown, bOut: unknown): Promise<EventEnvelope[]> {
  const effects = new EffectRuntime();
  effects.register("a-tool", new ToolEffect(async () => aOut));
  effects.register("b-tool", new ToolEffect(async () => bOut));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  runtime.registerFlow(flow.definition, flow.runner);
  const handle = await runtime.start(flow, {});
  await handle.waitForCompletion();
  return eventStore.read(handle.executionId);
}

describe("@loom/eval", () => {
  let golden: EventEnvelope[];
  beforeEach(async () => {
    golden = await recordRun({ cpu: 87 }, { fixed: true });
  });

  it("replayAsFixture reconstructs the terminal state with no live calls", () => {
    const state = replayAsFixture(golden);
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ done: true });
    expect(state.frames.a?.output).toEqual({ cpu: 87 });
  });

  it("recordedStepOutputs extracts each step's recorded output", () => {
    expect(recordedStepOutputs(golden)).toEqual({ a: { cpu: 87 }, b: { fixed: true } });
  });

  it("diffRuns is empty for identical logs (golden regression passes)", async () => {
    const again = await recordRun({ cpu: 87 }, { fixed: true });
    expect(diffRuns(golden, again)).toEqual([]);
  });

  it("diffRuns flags a changed step output", async () => {
    const changed = await recordRun({ cpu: 42 }, { fixed: true });
    const diffs = diffRuns(golden, changed);
    expect(diffs.some((d) => d.kind === "step-output" && d.stepId === "a")).toBe(true);
  });

  it("scoreRun runs named scorers over the folded outcome", () => {
    const state = replayAsFixture(golden);
    const results = scoreRun(state, [
      (s) => ({ name: "completed", score: s.status === "completed" ? 1 : 0 }),
      (s) => ({ name: "ran-both", score: Object.keys(s.frames).length === 2 ? 1 : 0 }),
    ]);
    expect(results).toEqual([
      { name: "completed", score: 1 },
      { name: "ran-both", score: 1 },
    ]);
  });
});
