import { agentSurfaceProjection } from "@loom/agent-surface";
import type { SurfaceState } from "@loom/agent-surface";
import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryBranchRegistry } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "./types";

// ── ADR 0102 — flow-level emit / stream / ui append ONCE per execution ────────
//
// A flow re-runs from the top on resume and on recovery (ADR 0057). `execute`,
// `decide` and `suspend` are served from the fold on that re-run; `emit` (and so
// `stream` and `ui`, which are `emit`) used to append again every time, so a
// surface built with `append` before a gate folded to ["x","x"] after one resume.
// Every assertion here reads the LOG (`store.read`), never a return value.

type Io = Record<string, unknown>;
const io = z.object({}).passthrough() as z.ZodSchema<Io>;

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
  branchRegistry: InMemoryBranchRegistry;
}

function freshStores(): Stores {
  return {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    branchRegistry: new InMemoryBranchRegistry(),
  };
}

const stepA = step$({ id: "a", name: "A", toolId: "tool-a", inputSchema: io, outputSchema: io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", inputSchema: io, outputSchema: io });

function boot(
  runner: FlowRunner<Io, Io>,
  opts: { stores?: Stores; effects?: (effects: EffectRuntime) => void } = {}
) {
  const stores = opts.stores ?? freshStores();
  const effects = new EffectRuntime();
  opts.effects?.(effects);
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    branchRegistry: stores.branchRegistry,
  });
  const definition: FlowDefinition<Io, Io> = {
    _tag: "FlowDefinition",
    id: "emit-once",
    name: "emit-once",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [stepA, stepB],
  };
  const flow: RegisteredFlow<Io, Io> = { definition, runner };
  runtime.registerFlow(definition, runner);
  return { runtime, flow, stores, eventStore: stores.eventStore };
}

const types = (events: EventEnvelope[]) => events.map((e) => e.eventType);
const count = (events: EventEnvelope[], type: string) =>
  events.filter((e) => e.eventType === type).length;

/** Fold the SURFACE_PATCH events of a log exactly as a live projection would. */
function foldSurface(events: EventEnvelope[]): SurfaceState {
  const projection = agentSurfaceProjection();
  const handler = projection.handlers.SURFACE_PATCH!;
  let state = projection.initialState;
  for (const e of events) if (e.eventType === "SURFACE_PATCH") state = handler(state, e);
  return state;
}

/** Start, then resume each gate in turn, returning the log after every step. */
async function driveGates(
  h: ReturnType<typeof boot>,
  executionId: string,
  gates: string[]
): Promise<EventEnvelope[][]> {
  const logs: EventEnvelope[][] = [];
  const started = await h.runtime.start(h.flow, {}, { executionId });
  await started.waitForSuspend();
  logs.push(await h.eventStore.read(executionId));
  for (const [i, gate] of gates.entries()) {
    const resumed = await h.runtime.resume(executionId, { eventType: gate, payload: { i } });
    if (i === gates.length - 1) await resumed.waitForCompletion();
    else await resumed.waitForSuspend();
    logs.push(await h.eventStore.read(executionId));
  }
  return logs;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("flow-level emits append once per execution (ADR 0102)", () => {
  it("ctx.emit before a gate is appended once across two resumes", async () => {
    const h = boot(async (ctx) => {
      ctx.emit("response.committed", { msg: "m1" });
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    });
    const logs = await driveGates(h, "e-emit", ["go1", "go2"]);
    for (const log of logs) expect(count(log, "response.committed")).toBe(1);
    expect(types(logs.at(-1)!)).toEqual([
      "EXECUTION_STARTED",
      "response.committed",
      "EXECUTION_SUSPENDED",
      "go1", // the resume event itself is logged
      "EXECUTION_RESUMED",
      "EXECUTION_SUSPENDED",
      "go2",
      "EXECUTION_RESUMED",
      "EXECUTION_COMPLETED",
    ]);
  });

  it("ctx.ui.append before a gate is ONE patch, and the surface folds to one entry", async () => {
    const h = boot(async (ctx) => {
      ctx.ui.append("timeline", "x");
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    });
    const logs = await driveGates(h, "e-ui", ["go1", "go2"]);
    const final = logs.at(-1)!;
    expect(count(final, "SURFACE_PATCH")).toBe(1);
    expect(foldSurface(final)).toEqual({ timeline: ["x"] });
  });

  it("ctx.stream before a gate is appended once", async () => {
    const h = boot(async (ctx) => {
      ctx.stream("answer", "Hello. ");
      ctx.stream("answer", "", true);
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    });
    const final = (await driveGates(h, "e-stream", ["go1", "go2"])).at(-1)!;
    expect(final.filter((e) => e.eventType === "answer").map((e) => e.payload)).toEqual([
      { delta: "Hello. ", done: false },
      { delta: "", done: true },
    ]);
  });

  it("an emit AFTER the resume point appends on that run, and not again on the next", async () => {
    const h = boot(async (ctx) => {
      ctx.emit("turn", { n: 1 });
      await ctx.suspend({ on: "go1" });
      ctx.emit("turn", { n: 2 });
      await ctx.suspend({ on: "go2" });
      ctx.emit("turn", { n: 3 });
      return { done: true };
    });
    const logs = await driveGates(h, "e-live", ["go1", "go2"]);
    const turns = (log: EventEnvelope[]) =>
      log.filter((e) => e.eventType === "turn").map((e) => (e.payload as { n: number }).n);
    expect(turns(logs[0]!)).toEqual([1]);
    expect(turns(logs[1]!)).toEqual([1, 2]);
    expect(turns(logs[2]!)).toEqual([1, 2, 3]);
  });

  it("crash recovery re-drives from the top without re-appending the pre-crash emit", async () => {
    const never = new Promise<Io>(() => {
      /* the stranded worker is gone, not slow */
    });
    const runner: FlowRunner<Io, Io> = async (ctx) => {
      ctx.emit("response.committed", { msg: "m1" });
      await ctx.run(stepA, {});
      ctx.emit("after", {});
      return { done: true };
    };
    const a = boot(runner, { effects: (e) => e.register("tool-a", new ToolEffect(() => never)) });
    void a.runtime.start(a.flow, {}, { executionId: "e-crash" });
    await settle();
    expect(count(await a.eventStore.read("e-crash"), "response.committed")).toBe(1);

    // A fresh process over the same stores, whose tool-a works.
    const b = boot(runner, {
      stores: a.stores,
      effects: (e) => e.register("tool-a", new ToolEffect(async () => ({ ok: true }))),
    });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    const log = await b.eventStore.read("e-crash");
    expect(log.at(-1)?.eventType).toBe("EXECUTION_COMPLETED");
    expect(count(log, "response.committed")).toBe(1);
    expect(count(log, "after")).toBe(1);
  });

  it("kernel events are unaffected: a two-gate flow's STEP_*/DECISION_RECORDED sequence is unchanged and unstamped", async () => {
    const h = boot(
      async (ctx) => {
        await ctx.run(stepA, {});
        await ctx.decide("route", () => "left");
        ctx.emit("note", { at: 1 });
        await ctx.suspend({ on: "go1" });
        await ctx.run(stepB, {});
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      {
        effects: (e) => {
          e.register("tool-a", new ToolEffect(async () => ({ a: 1 })));
          e.register("tool-b", new ToolEffect(async () => ({ b: 1 })));
        },
      }
    );
    const final = (await driveGates(h, "e-kernel", ["go1", "go2"])).at(-1)!;
    expect(final.map((e) => [e.eventType, e.payload])).toEqual([
      ["EXECUTION_STARTED", expect.anything()],
      ["STEP_STARTED", { stepId: "a", input: {} }],
      ["STEP_COMPLETED", { stepId: "a", output: { a: 1 } }],
      ["DECISION_RECORDED", { decisionId: "route", choice: "left" }],
      ["note", { at: 1 }],
      ["EXECUTION_SUSPENDED", expect.anything()],
      ["go1", { i: 0 }],
      ["EXECUTION_RESUMED", expect.anything()],
      ["STEP_STARTED", { stepId: "b", input: {} }],
      ["STEP_COMPLETED", { stepId: "b", output: { b: 1 } }],
      ["EXECUTION_SUSPENDED", expect.anything()],
      ["go2", { i: 1 }],
      ["EXECUTION_RESUMED", expect.anything()],
      ["EXECUTION_COMPLETED", expect.anything()],
    ]);
    // Only the flow-level emit is stamped; every kernel fact keeps its old envelope.
    const stamped = final.filter((e) => e.metadata?.flowEmit !== undefined);
    expect(stamped.map((e) => [e.eventType, e.metadata?.flowEmit])).toEqual([["note", 0]]);
  });

  it("legacy (unstamped) log: re-emits its prefix ONCE more, stamped, then converges", async () => {
    const runner: FlowRunner<Io, Io> = async (ctx) => {
      ctx.emit("response.committed", { msg: "m1" });
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    };
    // Produce the pre-fix shape: the same log with every flowEmit stamp stripped.
    const writer = boot(runner);
    const h = await writer.runtime.start(writer.flow, {}, { executionId: "e-legacy" });
    await h.waitForSuspend();
    const legacy = (await writer.eventStore.read("e-legacy")).map((e) => {
      const { flowEmit: _drop, ...rest } = (e.metadata ?? {}) as Record<string, unknown>;
      const { metadata: _m, ...envelope } = e;
      return Object.keys(rest).length > 0 ? { ...envelope, metadata: rest } : envelope;
    });
    expect(legacy.some((e) => "metadata" in e && e.metadata?.flowEmit !== undefined)).toBe(false);

    const stores = freshStores(); // no snapshot: the legacy log is the only source
    for (const e of legacy) await stores.eventStore.append(e);
    const b = boot(runner, { stores });

    const r1 = await b.runtime.resume("e-legacy", { eventType: "go1", payload: {} });
    await r1.waitForSuspend();
    const afterFirst = await b.eventStore.read("e-legacy");
    const commits = afterFirst.filter((e) => e.eventType === "response.committed");
    expect(commits.map((e) => e.metadata?.flowEmit)).toEqual([undefined, 0]);

    const r2 = await b.runtime.resume("e-legacy", { eventType: "go2", payload: {} });
    await r2.waitForCompletion();
    expect(count(await b.eventStore.read("e-legacy"), "response.committed")).toBe(2);
  });

  it("fork: a child forked after the emit does not duplicate it on resume", async () => {
    const h = boot(async (ctx) => {
      ctx.ui.append("timeline", "x");
      await ctx.suspend({ on: "go1" });
      ctx.ui.append("timeline", "y");
      return { done: true };
    });
    const started = await h.runtime.start(h.flow, {}, { executionId: "e-parent" });
    const suspended = await started.waitForSuspend();
    const child = await h.runtime.fork("e-parent", suspended.sequence, {
      executionId: "e-child",
      branchName: "alt",
    });
    const resumed = await h.runtime.resume(child.executionId, { eventType: "go1", payload: {} });
    await resumed.waitForCompletion();
    expect(foldSurface(await h.eventStore.read("e-child"))).toEqual({ timeline: ["x", "y"] });
  });

  // ── Emits whose caller is served from the log (ADR 0102 D4) ────────────────
  //
  // A flow-level emit made from INSIDE an effect (a closure over `ctx`, e.g. the
  // documented `chunkDeltas((t) => ctx.stream(...))` sink wired to an effect's
  // `onDelta`) or inside a decider runs only when that step/decision runs. On a
  // re-run the step is served and the emit never happens. If it had consumed an
  // ordinal, every later ordinal would shift down and a LIVE emit after the gate
  // would be dropped silently. Such emits therefore take the effect path.

  it("an emit from inside a completed step's effect never costs a later live emit", async () => {
    let flowCtx: WorkflowContext | undefined;
    const h = boot(
      async (ctx) => {
        flowCtx = ctx;
        ctx.emit("before", {});
        await ctx.run(stepA, {});
        ctx.emit("between", {});
        await ctx.suspend({ on: "go1" });
        ctx.emit("after", {});
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      {
        effects: (e) =>
          e.register(
            "tool-a",
            new ToolEffect(async () => {
              flowCtx!.stream("answer", "chunk");
              return { ok: true };
            })
          ),
      }
    );
    const final = (await driveGates(h, "e-closure", ["go1", "go2"])).at(-1)!;
    expect(count(final, "before")).toBe(1);
    expect(count(final, "answer")).toBe(1);
    expect(count(final, "between")).toBe(1);
    expect(count(final, "after")).toBe(1); // the one the ordinal shift used to lose
  });

  it("an emit from inside a decider never costs a later live emit", async () => {
    const h = boot(async (ctx) => {
      await ctx.decide("route", () => {
        ctx.emit("deciding", {});
        return "left";
      });
      await ctx.suspend({ on: "go1" });
      ctx.emit("after", {});
      await ctx.suspend({ on: "go2" });
      return { done: true };
    });
    const final = (await driveGates(h, "e-decider", ["go1", "go2"])).at(-1)!;
    expect(count(final, "deciding")).toBe(1);
    expect(count(final, "after")).toBe(1);
  });

  // The price of the effect-path rule, pinned so it cannot grow unnoticed: flow
  // code that emits WHILE one of its own steps is in flight (not awaited yet) is
  // indistinguishable from an effect's closure, so that emit is appended unstamped.
  // On the first re-run the step is served, the emit is stamped, and the ordinals
  // after it shift UP: some already-logged emits are appended once more. Never
  // lost, at most one extra copy per such run, stable after (ADR 0102 D5).
  it("an emit concurrent with an in-flight step is never lost, and converges after one re-run", async () => {
    const h = boot(
      async (ctx) => {
        const pending = ctx.run(stepA, {});
        ctx.emit("concurrent", {});
        await pending;
        ctx.emit("tail", {});
        await ctx.suspend({ on: "go1" });
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      { effects: (e) => e.register("tool-a", new ToolEffect(async () => ({ ok: true }))) }
    );
    const [first, second, third] = await driveGates(h, "e-concurrent", ["go1", "go2"]);
    expect([count(first!, "concurrent"), count(first!, "tail")]).toEqual([1, 1]);
    expect([count(second!, "concurrent"), count(second!, "tail")]).toEqual([1, 2]);
    expect([count(third!, "concurrent"), count(third!, "tail")]).toEqual([1, 2]);
  });
});
