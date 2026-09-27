import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import { EXECUTION_RECOVERED, ResumePayloadValidationError, ResumeRefusedError } from "./types";
import type { FlowRunner } from "./types";

// ── ADR 0104 — a recovery re-drive never answers a gate ───────────────────────
//
// `recoverAbandoned` (and `LocalWorkerRuntime`) re-drive a crashed execution with
// `EXECUTION_RECOVERED {}`. Before ADR 0104 the runtime also appended
// `EXECUTION_RESUMED {}` beside it, which the fold adds to `_resumePayloads` — and
// `ctx.suspend` serves that list as gate passthroughs. A flow that crashed BEFORE its
// first gate therefore sailed through that gate with `{}` after recovery: no approval,
// no resumeSchemas check (ADR 0077 keys the lookup on the event type, and nobody
// declares a schema for EXECUTION_RECOVERED).

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
const stepA = step$({ id: "a", name: "A", toolId: "tool-a", inputSchema: io, outputSchema: io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", inputSchema: io, outputSchema: io });

type Stores = { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore };

const never = () =>
  new Promise<Record<string, unknown>>(() => {
    /* the worker that owned this effect is gone */
  });

/**
 * A runtime over (optionally shared) stores. `hang` names the step whose effect never
 * settles, so a run parks mid-step the way a SIGKILLed worker parks one. Recovery is
 * a SECOND boot over the same stores.
 */
function boot(
  opts: {
    shared?: Stores;
    hang?: "a" | "b";
    resumeSchemas?: FlowDefinition["resumeSchemas"];
    warnings?: string[];
  } = {}
) {
  const effects = new EffectRuntime();
  effects.register(
    "tool-a",
    new ToolEffect(async () => (opts.hang === "a" ? never() : { ok: true }))
  );
  effects.register(
    "tool-b",
    new ToolEffect(async () => (opts.hang === "b" ? never() : { ok: true }))
  );
  const stores: Stores = opts.shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    onWarn: (m) => opts.warnings?.push(m),
  });
  const seen: unknown[] = [];
  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    seen.length = 0; // a re-run observes the full ordered sequence
    await ctx.run(stepA, {});
    seen.push(await ctx.suspend<unknown>({ on: "go1" }));
    await ctx.run(stepB, {});
    seen.push(await ctx.suspend<unknown>({ on: "go2" }));
    return { done: true };
  };
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "gated",
    name: "gated",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [stepA, stepB],
    ...(opts.resumeSchemas !== undefined && { resumeSchemas: opts.resumeSchemas }),
  };
  runtime.registerFlow(definition, runner);
  return { runtime, stores, seen, flow: { definition, runner } };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const types = async (s: Stores, id: string) =>
  (await s.eventStore.read(id)).map((e: EventEnvelope) => e.eventType);

/** Crash in step A (before gate go1); returns the shared stores. */
async function crashBeforeGo1(opts: Parameters<typeof boot>[0] = {}) {
  const first = boot({ ...opts, hang: "a" });
  void first.runtime.start(first.flow, {}, { executionId: "e" });
  await tick();
  expect((await first.runtime.loadState("e"))?.status).toBe("running");
  return first.stores;
}

describe("recovery never satisfies a gate (ADR 0104)", () => {
  it("recoverAbandoned re-drives a crash before go1 and the flow BLOCKS at go1", async () => {
    const stores = await crashBeforeGo1();
    const second = boot({ shared: stores });

    const summary = await recoverAbandoned(second.runtime, {
      source: stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);

    const state = await second.runtime.loadState("e");
    expect(state?.status).toBe("suspended");
    expect(state?.suspendedOn?.on).toBe("go1");
    expect(state?.frames.b).toBeUndefined(); // nothing past the gate ran
    const log = await types(stores, "e");
    expect(log).toContain(EXECUTION_RECOVERED);
    // Recovery is not a resume: no EXECUTION_RESUMED, so nothing enters `_resumePayloads`.
    expect(log).not.toContain("EXECUTION_RESUMED");
    expect(state?.variables._resumePayloads).toBeUndefined();

    // An explicit resume addressed to the parked gate is what passes it.
    const h = await second.runtime.resume("e", { eventType: "go1", payload: { by: "alice" } });
    const parked = await h.waitForSuspend();
    expect(parked.suspendedOn?.on).toBe("go2");
    expect(second.seen).toEqual([{ by: "alice" }]);
  });

  it("the worker path (a direct EXECUTION_RECOVERED resume) blocks at go1 too", async () => {
    const stores = await crashBeforeGo1();
    const second = boot({ shared: stores });
    const h = await second.runtime.resume("e", { eventType: EXECUTION_RECOVERED, payload: {} });
    const state = await h.waitForSuspend();
    expect(state.suspendedOn?.on).toBe("go1");
    expect(second.seen).toEqual([]);
  });

  it("an execution already parked AT a gate stays parked; only a real resume passes it", async () => {
    const { runtime, stores, flow, seen } = boot();
    await (await runtime.start(flow, {}, { executionId: "e" })).waitForSuspend();

    const summary = await recoverAbandoned(runtime, {
      source: stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(0);
    await expect(
      runtime.resume("e", { eventType: EXECUTION_RECOVERED, payload: {} })
    ).rejects.toBeInstanceOf(ResumeRefusedError);
    expect((await runtime.loadState("e"))?.suspendedOn?.on).toBe("go1");

    const h = await runtime.resume("e", { eventType: "go1", payload: { n: 1 } });
    expect((await h.waitForSuspend()).suspendedOn?.on).toBe("go2");
    expect(seen).toEqual([{ n: 1 }]);
  });

  it("recovery after a legitimately passed gate does not consume the NEXT gate", async () => {
    const first = boot({ hang: "b" });
    await (await first.runtime.start(first.flow, {}, { executionId: "e" })).waitForSuspend();
    void first.runtime.resume("e", { eventType: "go1", payload: { n: 1 } }); // crashes in B
    await tick();
    expect((await first.runtime.loadState("e"))?.status).toBe("running");

    const second = boot({ shared: first.stores });
    const h = await second.runtime.resume("e", { eventType: EXECUTION_RECOVERED, payload: {} });
    const state = await h.waitForSuspend();
    expect(state.suspendedOn?.on).toBe("go2");
    expect(state.variables._resumePayloads).toEqual([{ n: 1 }]);
    expect(second.seen).toEqual([{ n: 1 }]); // go1 still gets ITS payload

    const done = await second.runtime.resume("e", { eventType: "go2", payload: { n: 2 } });
    expect((await done.waitForCompletion()).status).toBe("completed");
    expect(second.seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("a declared resumeSchema (ADR 0077) is no longer evaded by recovery", async () => {
    const resumeSchemas = { go1: z.object({ approved: z.literal(true) }) };
    const stores = await crashBeforeGo1({ resumeSchemas });
    const second = boot({ shared: stores, resumeSchemas });

    const h = await second.runtime.resume("e", { eventType: EXECUTION_RECOVERED, payload: {} });
    expect((await h.waitForSuspend()).suspendedOn?.on).toBe("go1");
    expect(second.seen).toEqual([]);

    await expect(
      second.runtime.resume("e", { eventType: "go1", payload: {} })
    ).rejects.toBeInstanceOf(ResumePayloadValidationError);
    const ok = await second.runtime.resume("e", {
      eventType: "go1",
      payload: { approved: true },
    });
    expect((await ok.waitForSuspend()).suspendedOn?.on).toBe("go2");
    expect(second.seen).toEqual([{ approved: true }]);
  });

  it("resumeAs onto a CRASHED execution does not answer a gate either", async () => {
    const stores = await crashBeforeGo1();
    const second = boot({ shared: stores });
    const h = await second.runtime.resumeAs(
      "e",
      "gated",
      { eventType: EXECUTION_RECOVERED, payload: { smuggled: true } },
      { strategy: "operator-ack" }
    );
    const state = await h.waitForSuspend();
    expect(state.suspendedOn?.on).toBe("go1");
    expect(state.variables._resumePayloads).toBeUndefined();
    expect(second.seen).toEqual([]);
  });

  it("a LEGACY log whose recovery was folded as a passthrough replays identically, and is flagged", async () => {
    const stores = await crashBeforeGo1();
    // What the pre-0104 kernel wrote on recovery: the pair, the second folding `{}` into
    // `_resumePayloads`. Its re-drive then passed go1 with `{}` and parked at go2.
    const tip = (await stores.eventStore.read("e")).length;
    const legacy = (eventType: string, sequence: number): EventEnvelope => ({
      id: `e-${sequence}`,
      workflowId: "gated",
      executionId: "e",
      eventType,
      sequence,
      timestamp: Date.now(),
      payload: {},
    });
    await stores.eventStore.append(legacy(EXECUTION_RECOVERED, tip + 1));
    await stores.eventStore.append(legacy("EXECUTION_RESUMED", tip + 2));

    const warnings: string[] = [];
    const replay = boot({ shared: stores, warnings });
    const h = await replay.runtime.resume("e", { eventType: EXECUTION_RECOVERED, payload: {} });
    const state = await h.waitForSuspend();
    // The recorded passthrough still answers go1 — the log is replayed as written, so an
    // execution that already ran past go1 under the old kernel does not diverge.
    expect(state.suspendedOn?.on).toBe("go2");
    expect(state.variables._resumePayloads).toEqual([{}]);
    expect(replay.seen).toEqual([{}]);
    // …and the operator is told which execution carries one.
    expect(warnings.some((w) => w.includes('"e"') && w.includes("ADR 0104"))).toBe(true);

    // A second replay of the same log is byte-for-byte the same decision.
    const again = boot({ shared: stores });
    const done = await again.runtime.resume("e", { eventType: "go2", payload: { n: 2 } });
    expect((await done.waitForCompletion()).status).toBe("completed");
    expect(again.seen).toEqual([{}, { n: 2 }]);
  });

  it("a log with no legacy recovery pair raises no warning", async () => {
    const warnings: string[] = [];
    const { runtime, flow } = boot({ warnings });
    await (await runtime.start(flow, {}, { executionId: "e" })).waitForSuspend();
    await (await runtime.resume("e", { eventType: "go1", payload: {} })).waitForSuspend();
    expect(warnings.filter((w) => w.includes("ADR 0104"))).toEqual([]);
  });
});
