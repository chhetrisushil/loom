import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── `start` takes what the caller already has ────────────────────────────────
//
// `registerFlow(definition, runner)` stores the pair, and `start` then demanded
// the pair BACK. So every caller who had just registered a flow rebuilt
// `{ definition, runner }` by hand to start it, and anyone who passed the
// definition — the obvious thing — got "Property 'runner' is missing in type
// FlowDefinition", which describes the shape rather than the mistake.

const definition: FlowDefinition<{ n: number }, { doubled: number }> = {
  _tag: "FlowDefinition",
  id: "double",
  name: "double",
  version: "1.0.0",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ doubled: z.number() }),
  steps: [],
};
const runner: FlowRunner<{ n: number }, { doubled: number }> = async (_ctx, input) => ({
  doubled: input.n * 2,
});

function boot() {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(definition, runner);
  return runtime;
}

describe("start accepts a definition, an id, or the pair", () => {
  it("starts from the definition a caller already registered", async () => {
    const state = await (await boot().start(definition, { n: 21 })).waitForCompletion();
    expect(state.status).toBe("completed");
  });

  it("starts from the flow id", async () => {
    const state = await (await boot().start("double", { n: 21 })).waitForCompletion();
    expect(state.status).toBe("completed");
  });

  it("still starts an UNREGISTERED flow from the pair", async () => {
    // The pair never required registration and must not start to: passing
    // { definition, runner } is how a test drives a one-off flow.
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    const pair: RegisteredFlow<{ n: number }, { doubled: number }> = { definition, runner };
    const state = await (await runtime.start(pair, { n: 1 })).waitForCompletion();
    expect(state.status).toBe("completed");
  });

  it("names the call that fixes an unregistered definition", async () => {
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    // The whole point: the error says what to DO, not what shape was expected.
    await expect(runtime.start(definition, { n: 1 })).rejects.toThrow(/call registerFlow/);
  });
});
