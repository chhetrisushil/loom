import { flowContentHash, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { FlowCodeMismatchError } from "./types";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── K11.1 — flow-code versioning: never silently fold a log with changed code ─
//
// The sneaky path this closes: an execution suspends, a deploy changes the flow,
// and a resume — or a crash-recovery redispatch, which needs NO operator action —
// folds the old log with code that never wrote it. The recorded flowHash makes
// that a loud FlowCodeMismatchError instead; legacy logs (no hash) and explicit
// operator acks keep working.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const FLOW = "gated-flow";

const stepA = step$({
  id: "collect",
  name: "Collect",
  toolId: "collect-tool",
  inputSchema,
  outputSchema,
});
// The "deployed" v2 rebinds the step to a different tool — a structural change.
const stepA2 = step$({
  id: "collect",
  name: "Collect",
  toolId: "collect-tool-v2",
  inputSchema,
  outputSchema,
});

function makeFlow(step: typeof stepA): RegisteredFlow<In, Out> {
  const runner: FlowRunner<In, Out> = async (ctx, input) => {
    await ctx.run(step, input);
    await ctx.suspend({ on: "Approval" });
    return { done: true };
  };
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [step],
  };
  return { definition, runner };
}

function boot(step: typeof stepA, eventStore?: InMemoryAsyncEventStore) {
  const effects = new EffectRuntime();
  effects.register("collect-tool", new ToolEffect(async () => ({ done: false })));
  effects.register("collect-tool-v2", new ToolEffect(async () => ({ done: false })));
  const stores = {
    eventStore: eventStore ?? new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({ ...stores, effectRuntime: effects });
  const flow = makeFlow(step);
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, ...stores };
}

/** Start + run to the suspend gate, on flow v1. */
async function suspendedOnV1() {
  const v1 = boot(stepA);
  const handle = await v1.runtime.start(v1.flow, { n: 1 }, { executionId: "fh-1" });
  await handle.waitForSuspend();
  return v1;
}

describe("K11.1 — flow content hash recording", () => {
  it("records flowHash on EXECUTION_STARTED and folds it into variables._flowHash", async () => {
    const v1 = await suspendedOnV1();

    const events = await v1.eventStore.read("fh-1");
    const started = events.find((e: EventEnvelope) => e.eventType === "EXECUTION_STARTED");
    const expected = flowContentHash(makeFlow(stepA).definition);
    expect((started?.payload as { flowHash?: string }).flowHash).toBe(expected);

    const state = await v1.runtime.loadState("fh-1");
    expect(state?.variables._flowHash).toBe(expected);
  });
});

describe("K11.1 — resume/recovery across a deploy", () => {
  it("resumes normally when the registered code is unchanged", async () => {
    const v1 = await suspendedOnV1();
    const handle = await v1.runtime.resume("fh-1", { eventType: "Approval", payload: {} });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
  });

  it("REFUSES to resume when the flow's structure changed (loud, with the three exits)", async () => {
    const v1 = await suspendedOnV1();

    // "Deploy": fresh runtime over the same store, registered with flow v2.
    const v2 = boot(stepA2, v1.eventStore);
    const err = await v2.runtime
      .resume("fh-1", { eventType: "Approval", payload: {} })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FlowCodeMismatchError);
    expect(String(err)).toMatch(/PIN/);
    expect(String(err)).toMatch(/MIGRATE/);
    expect(String(err)).toMatch(/DRAIN/);
  });

  it("REFUSES a crash-recovery redispatch too — the no-operator path is also guarded", async () => {
    const v1 = await suspendedOnV1();
    const v2 = boot(stepA2, v1.eventStore);

    await expect(
      v2.runtime.resume("fh-1", { eventType: "EXECUTION_RECOVERED", payload: {} })
    ).rejects.toBeInstanceOf(FlowCodeMismatchError);
  });

  it("uses the snapshot-carried hash: the suspend snapshot alone is enough to refuse", async () => {
    // suspendedOnV1 saved a snapshot at the suspend point; sharing BOTH stores
    // makes resume fold snapshot + empty tail — the hash must come through the
    // snapshot state, not a re-read of EXECUTION_STARTED.
    const v1 = await suspendedOnV1();
    const effects = new EffectRuntime();
    effects.register("collect-tool-v2", new ToolEffect(async () => ({ done: false })));
    const shared = new WorkflowRuntime({
      eventStore: v1.eventStore,
      snapshotStore: v1.snapshotStore,
      effectRuntime: effects,
    });
    const flowV2 = makeFlow(stepA2);
    shared.registerFlow(flowV2.definition, flowV2.runner);

    await expect(
      shared.resume("fh-1", { eventType: "Approval", payload: {} })
    ).rejects.toBeInstanceOf(FlowCodeMismatchError);
  });

  it("pinning the original code resumes cleanly after a refusal", async () => {
    const v1 = await suspendedOnV1();
    const v2 = boot(stepA2, v1.eventStore);
    await expect(
      v2.runtime.resume("fh-1", { eventType: "Approval", payload: {} })
    ).rejects.toBeInstanceOf(FlowCodeMismatchError);

    // Exit (1): PIN — a runtime registered with the ORIGINAL flow code.
    const pinned = boot(stepA, v1.eventStore);
    const handle = await pinned.runtime.resume("fh-1", { eventType: "Approval", payload: {} });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
  });

  it("explicit operator-ack (allowFlowCodeMismatch) resumes across the mismatch", async () => {
    const v1 = await suspendedOnV1();
    const v2 = boot(stepA2, v1.eventStore);

    const handle = await v2.runtime.resume(
      "fh-1",
      { eventType: "Approval", payload: {} },
      { allowFlowCodeMismatch: true }
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed"); // step already completed → served from log
  });

  it("legacy logs with no recorded hash resume exactly as before (G2)", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const t0 = Date.now() - 100;
    // A pre-K11 log: EXECUTION_STARTED carries only the input.
    const seed = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
      id: `legacy-1-${sequence}`,
      workflowId: FLOW,
      executionId: "legacy-1",
      eventType,
      sequence,
      timestamp: t0 + sequence,
      payload,
    });
    await eventStore.append(seed(0, "EXECUTION_STARTED", { input: { n: 1 } }));
    await eventStore.append(seed(1, "STEP_STARTED", { stepId: "collect", input: { n: 1 } }));
    await eventStore.append(
      seed(2, "STEP_COMPLETED", { stepId: "collect", output: { done: false } })
    );
    await eventStore.append(seed(3, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }));

    // Changed code (v2) — but the log predates hashing, so no check applies.
    const v2 = boot(stepA2, eventStore);
    const handle = await v2.runtime.resume("legacy-1", { eventType: "Approval", payload: {} });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
  });
});
