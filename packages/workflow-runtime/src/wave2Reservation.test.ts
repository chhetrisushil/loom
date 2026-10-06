import type { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecutionJournal } from "./ExecutionJournal";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";
import { guardUserspaceEmit } from "./userspaceEmit";

// Wave 2 (W2-0) — what the kernel does with the reserved shapes while NO writer exists.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;

function boot(runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>) {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onWarn: () => {},
  });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [] as ReturnType<typeof step$>[],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, definition, runner };
}

describe("userspace cannot write the reserved kinds (guardUserspaceEmit)", () => {
  it("refuses EXECUTION_CONTINUED, MESSAGE_CONSUMED and PARALLEL_COMPLETED by name", () => {
    for (const kind of ["EXECUTION_CONTINUED", "MESSAGE_CONSUMED", "PARALLEL_COMPLETED"]) {
      expect(() => guardUserspaceEmit(kind, { anything: 1 })).toThrow(/kernel event type/);
    }
  });

  it("refuses an OUTCOME_RECORDED that claims recordedBy or late (ADR 0116)", () => {
    expect(() => guardUserspaceEmit("OUTCOME_RECORDED", { key: "k", recordedBy: "ops" })).toThrow(
      /recordOutcome/
    );
    expect(() => guardUserspaceEmit("OUTCOME_RECORDED", { key: "k", late: true })).toThrow(
      /recordOutcome/
    );
    expect(guardUserspaceEmit("OUTCOME_RECORDED", { key: "k", success: true })).toEqual({
      key: "k",
      success: true,
    });
  });

  it("validates RESOURCE_METERED.custom (ADR 0115)", () => {
    const ok = guardUserspaceEmit("RESOURCE_METERED", { custom: { gpu_seconds: 3 } });
    expect(ok).toEqual({ custom: { gpu_seconds: 3 } });
    const bad: unknown[] = [
      "x",
      [1],
      null,
      { "Bad Name": 1 },
      { constructor: 1 },
      { prototype: 1 },
      { a: -1 },
      { a: 1e16 },
      { a: Number.POSITIVE_INFINITY },
      { a: "1" },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`d${i}`, 1])),
      JSON.parse('{"__proto__": 1}'),
    ];
    for (const custom of bad) {
      expect(
        () => guardUserspaceEmit("RESOURCE_METERED", { custom }),
        JSON.stringify(custom)
      ).toThrow(/RESOURCE_METERED refused/);
    }
  });
});

describe("the journal stamps metadata.kernel on exactly the kinds whose fold requires it", () => {
  const build = (eventType: string, metadata?: Record<string, unknown>) =>
    ExecutionJournal.bootstrapEnvelope(
      { executionId: "x", workflowId: "f" },
      eventType,
      {},
      {
        ...(metadata !== undefined && { metadata }),
        fence: 2,
      }
    );

  it("stamps the three kinds, alongside the fence", () => {
    for (const kind of ["EXECUTION_CONTINUED", "MESSAGE_CONSUMED", "PARALLEL_COMPLETED"]) {
      expect(build(kind).metadata).toEqual({ fence: 2, kernel: true });
    }
  });

  it("stamps nothing else, and caller metadata cannot add the stamp to another kind via the journal", () => {
    expect(build("STEP_STARTED").metadata).toEqual({ fence: 2 });
    expect(build("EXECUTION_STARTED").metadata).toEqual({ fence: 2 });
  });

  it("commit() stamps too (the path a writer will use)", async () => {
    const store = new InMemoryAsyncEventStore();
    const vm = new ReplayVM([], { executionId: "x", workflowId: "f", workflowVersion: "1" });
    const journal = new ExecutionJournal(
      store,
      { executionId: "x", workflowId: "f" },
      vm,
      undefined,
      () => {}
    );
    journal.commit("EXECUTION_STARTED", { input: {} });
    journal.commit("EXECUTION_CONTINUED", { successorId: "x~1", chainId: "x", generation: 1 });
    await journal.drain();
    const log = await store.read("x");
    expect(log[0]?.metadata).toBeUndefined();
    expect(log[1]?.metadata).toEqual({ kernel: true });
    expect(vm.peekState().status).toBe("continued");
  });
});

describe("no ingress carries caller metadata into an envelope", () => {
  it("a flow's emit of an app event stamps only flowEmit; the reserved kinds are refused outright", async () => {
    let refused = false;
    const { runtime, eventStore, definition, runner } = boot(async (ctx) => {
      await ctx.emit("app.event", { a: 1 });
      try {
        await ctx.emit("MESSAGE_CONSUMED", {
          waitId: "#0",
          topic: "t",
          messageId: "m",
          inboxSeq: 0,
          payload: 1,
        });
      } catch {
        refused = true;
      }
      return {};
    });
    const handle = await runtime.start({ definition, runner }, {});
    await handle.waitForCompletion();
    const log = await eventStore.read(handle.executionId);
    expect(refused).toBe(true);
    expect(log.filter((e) => e.eventType === "MESSAGE_CONSUMED")).toEqual([]);
    for (const e of log) expect(e.metadata?.kernel).toBeUndefined();
  });
});

describe("`continued` is terminal and not completed", () => {
  async function continuedExecution() {
    const app = boot(async (ctx) => {
      await ctx.suspend({ on: "Gate" });
      return {};
    });
    const handle = await app.runtime.start({ definition: app.definition, runner: app.runner }, {});
    await handle.waitForSuspend();
    const id = handle.executionId;
    const head = (await app.eventStore.read(id)).at(-1) as EventEnvelope;
    await app.eventStore.append({
      id: `${id}-${head.sequence + 1}`,
      workflowId: "f",
      executionId: id,
      eventType: "EXECUTION_CONTINUED",
      sequence: head.sequence + 1,
      timestamp: Date.now(),
      payload: { successorId: `${id}~1`, chainId: id, generation: 1 },
      metadata: { kernel: true },
    });
    return { ...app, id };
  }

  it("loadState folds it; cancel is a no-op (terminal); resume and resumeAs are refused", async () => {
    const { runtime, id } = await continuedExecution();
    const state = await runtime.loadState(id);
    expect(state?.status).toBe("continued");
    expect(state?.variables._continuedTo).toBe(`${id}~1`);
    expect(await runtime.cancel(id)).toBe(false);
    await expect(runtime.resume(id, { eventType: "Gate", payload: {} })).rejects.toThrow();
    await expect(
      runtime.resumeAs(id, "f", { eventType: "Gate", payload: {} }, { strategy: "operator-ack" })
    ).rejects.toThrow(/continued as/);
  });
});
