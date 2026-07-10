import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { ExecutionContext, FlowRunner, RegisteredFlow } from "./types";

// #80 — the ExecutionContext.decide interface must advertise the ADR 0030 D1 opts, so a
// caller with a `ctx` typed as ExecutionContext can pass them without a cast. This test
// annotates the runner param as ExecutionContext, so it ONLY COMPILES if the interface
// carries the fields — a compile-time guarantee — and asserts they are recorded at runtime.

function makeRuntime(): WorkflowRuntime {
  return new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
}

function flowOf(runner: FlowRunner<unknown, unknown>): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      steps: [],
    },
    runner,
  };
}

describe("ExecutionContext.decide — D1 materialization opts (#80)", () => {
  it("accepts + records the D1 fields through the ExecutionContext type", async () => {
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
      await ctx.decide("route", () => "opus", {
        source: "reasoning",
        alternatives: ["haiku", "opus"],
        estimatedCostUsd: 0.12,
        estimatedLatencyMs: 800,
        confidence: 0.9,
      });
      return {};
    };
    const state = await (await makeRuntime().start(flowOf(runner), {})).waitForCompletion();
    const decisions = state.variables._decisions as Record<string, Record<string, unknown>>;
    expect(decisions.route).toMatchObject({
      choice: "opus",
      source: "reasoning",
      alternatives: ["haiku", "opus"],
      estimatedCostUsd: 0.12,
      estimatedLatencyMs: 800,
      confidence: 0.9,
    });
  });
});
