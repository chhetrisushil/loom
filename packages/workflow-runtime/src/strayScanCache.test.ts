import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, HumanEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ResumeRefusedError } from "./types";
import type { FlowRunner } from "./types";

// R1a — the process-local "this log scanned clean" memory must not outlive a pre-0104 writer
// appending to the same log (rolling upgrade, an old node running `recoverAbandoned`): a WARM
// runtime must answer exactly as a FRESH one does for the same log and request.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
const human = step$({ id: "h", name: "H", toolId: "human", inputSchema: io, outputSchema: io });

class SpyEventStore extends InMemoryAsyncEventStore {
  fullReads = 0;
  override async read(executionId: string) {
    this.fullReads++;
    return super.read(executionId);
  }
}

const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
  await ctx.suspend({ on: "go0" });
  await ctx.suspend({ on: "go1" });
  await ctx.run(human, {});
  await ctx.suspend({ on: "go2" });
  return {};
};

function boot(stores: { eventStore: SpyEventStore; snapshotStore: InMemoryAsyncSnapshotStore }) {
  const effects = new EffectRuntime();
  effects.register("human", new HumanEffect({ on: "Approve" }));
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    onWarn: () => {},
    // verifies only the operator override, so ordinary resumes are untouched
    resumeAuthenticator: {
      verify: (e) =>
        e.discardLegacyAnswers === undefined
          ? { status: "not-applicable" }
          : { status: "verified", actor: "ops", verifiedBy: "test" },
    },
  });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [human],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, definition };
}

/** What a pre-0104 node leaves behind after answering go1: a recovery {} then a human park. */
async function oldWorkerAppends(stores: { eventStore: SpyEventStore }) {
  let seq = ((await stores.eventStore.read("e")).at(-1) as EventEnvelope).sequence;
  const add = async (eventType: string, payload: unknown) => {
    seq++;
    await stores.eventStore.append({
      id: `old-${seq}`,
      workflowId: "f",
      executionId: "e",
      eventType,
      sequence: seq,
      timestamp: Date.now(),
      payload,
    });
  };
  await add("go1", { ok: 1 });
  await add("EXECUTION_RESUMED", { ok: 1 });
  await add("EXECUTION_RECOVERED", {});
  await add("EXECUTION_RESUMED", {});
  await add("STEP_STARTED", { stepId: "h", input: {} });
  await add("EXECUTION_SUSPENDED", { condition: { on: "Approve" } });
}

async function warmedUp() {
  const stores = {
    eventStore: new SpyEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const warm = boot(stores);
  await (await warm.runtime.start("f", {}, { executionId: "e" })).waitForSuspend();
  // the first resume scans the whole log (clean) and remembers it
  await (await warm.runtime.resume("e", { eventType: "go0", payload: {} })).waitForSuspend();
  return { stores, warm };
}

describe("stray-scan memory under a mixed-version writer (R1a)", () => {
  it("a warm runtime refuses exactly like a fresh one after an old worker appended a stray", async () => {
    const { stores, warm } = await warmedUp();
    await oldWorkerAppends(stores);

    const request = { eventType: "Approve", payload: { by: "bob" } };
    const fresh = boot(stores);
    const freshErr = await fresh.runtime.resume("e", request).catch((e: unknown) => e);
    expect(freshErr).toBeInstanceOf(ResumeRefusedError);
    expect((freshErr as ResumeRefusedError).reason).toBe("ambiguous-legacy-answers");

    const before = (await stores.eventStore.read("e")).length;
    const warmErr = await warm.runtime.resume("e", request).catch((e: unknown) => e);
    expect(warmErr).toBeInstanceOf(ResumeRefusedError);
    expect((warmErr as ResumeRefusedError).reason).toBe("ambiguous-legacy-answers");
    expect((await stores.eventStore.read("e")).length).toBe(before);
  });

  it("an unchanged log is still resumed without a whole-log read (the cache keeps its value)", async () => {
    const { stores, warm } = await warmedUp();
    const reads = stores.eventStore.fullReads;
    await (await warm.runtime.resume("e", { eventType: "go1", payload: {} })).waitForSuspend();
    expect(stores.eventStore.fullReads).toBe(reads);
  });

  it("a refused discardLegacyAnswers drops the clean memory (next resume re-scans)", async () => {
    const { stores, warm } = await warmedUp();
    await expect(
      warm.runtime.resume("e", {
        eventType: "go1",
        payload: {},
        discardLegacyAnswers: { stepId: "nope", count: 1 },
      })
    ).rejects.toThrow(/discardLegacyAnswers refused/);
    const reads = stores.eventStore.fullReads;
    await (await warm.runtime.resume("e", { eventType: "go1", payload: {} })).waitForSuspend();
    expect(stores.eventStore.fullReads).toBeGreaterThan(reads);
  });

  it("a warm refusal drops the clean memory too", async () => {
    const { stores, warm } = await warmedUp();
    await oldWorkerAppends(stores);
    const request = { eventType: "Approve", payload: { by: "bob" } };
    await expect(warm.runtime.resume("e", request)).rejects.toBeInstanceOf(ResumeRefusedError);
    const reads = stores.eventStore.fullReads;
    await expect(warm.runtime.resume("e", request)).rejects.toBeInstanceOf(ResumeRefusedError);
    expect(stores.eventStore.fullReads).toBeGreaterThan(reads);
  });
});
