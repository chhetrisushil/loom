import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemorySecretResolver, redactionMiddleware, secretRef } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// K10.3 end-to-end: a redaction marker keeps a secret out of the durable log
// entirely, while the tool still receives the resolved value.

const SECRET = "sk_live_TOPSECRET_should_never_be_logged";

const io = {
  inputSchema: z.object({ amount: z.number(), apiKey: z.any() }),
  outputSchema: z.object({ txId: z.string() }),
};
const chargeStep = step$({ id: "charge", name: "Charge", toolId: "charge-tool", ...io });
const FLOW = "redacted-flow";

function boot() {
  const resolver = new InMemorySecretResolver(new Map([["stripe-key", SECRET]]));
  const effects = new EffectRuntime([redactionMiddleware({ resolver })]);
  let toolSawSecret = false;
  effects.register(
    "charge-tool",
    new ToolEffect(async (input: unknown) => {
      toolSawSecret = (input as { apiKey?: string }).apiKey === SECRET;
      return { txId: "tx_123" };
    })
  );

  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    ctx.run(chargeStep, { amount: 42, apiKey: secretRef("stripe-key") });
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    ...io,
    steps: [chargeStep],
  };
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  runtime.registerFlow(definition, runner);
  return {
    runtime,
    flow: { definition, runner } as RegisteredFlow,
    eventStore,
    sawSecret: () => toolSawSecret,
  };
}

describe("K10.3 — the secret never enters the durable log", () => {
  it("the tool gets the resolved secret; NO event payload contains it, but the reference is logged", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, {}, { executionId: "red-1" });
    await handle.waitForCompletion();

    expect(app.sawSecret()).toBe(true); // redaction resolved the ref for the tool

    const events = await app.eventStore.read("red-1");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET); // the secret is nowhere in the log
    expect(serialized).toContain("stripe-key"); // the reference is what was logged

    const started = events.find((e: EventEnvelope) => e.eventType === "STEP_STARTED");
    const input = (started?.payload as { input: { apiKey: unknown } }).input;
    expect(input.apiKey).toEqual({ __loomSecret: "stripe-key" });

    const completed = events.find((e: EventEnvelope) => e.eventType === "STEP_COMPLETED");
    expect(completed?.payload).toMatchObject({ output: { txId: "tx_123" } });

    // Replay folds fine — the secret was never needed to reconstruct state.
    expect((await app.runtime.loadState("red-1"))?.status).toBe("completed");
  });
});
