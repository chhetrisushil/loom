import { agentSurfaceProjection } from "@loom/agent-surface";
import type { SurfaceState } from "@loom/agent-surface";
import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryBranchRegistry } from "@loom/event-runtime";
import { flowEmitCount, foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { flowEmitDigest } from "./WorkflowContext";
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
//
// Matching is by CONTENT digest (fix round 1): the skip decision reads only logged
// stamps and the run's own emits, never timing, and when the kernel cannot prove an
// emit is a replay it APPENDS — a duplicate is acceptable, a lost emit is not.

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
  opts: {
    stores?: Stores;
    effects?: (effects: EffectRuntime) => void;
    snapshotEvery?: number;
  } = {}
) {
  const stores = opts.stores ?? freshStores();
  const effects = new EffectRuntime();
  opts.effects?.(effects);
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    branchRegistry: stores.branchRegistry,
    ...(opts.snapshotEvery !== undefined && { snapshotEvery: opts.snapshotEvery }),
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
    // Only the flow-level emit is stamped (with its content digest); every kernel fact
    // keeps its old envelope.
    const stamped = final.filter((e) => e.metadata?.flowEmit !== undefined);
    expect(stamped.map((e) => [e.eventType, e.metadata?.flowEmit])).toEqual([
      ["note", flowEmitDigest("note", { at: 1 })],
    ]);
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
    expect(commits.map((e) => e.metadata?.flowEmit)).toEqual([
      undefined,
      flowEmitDigest("response.committed", { msg: "m1" }),
    ]);

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

  // Hardest form: the effect's emit has the SAME content as a later live emit. Had the
  // effect's emit been stamped, the served step would leave that stamp unmatched and the
  // live emit would look already-logged — a loss. Unstamped, it never serves anything.
  it("an emit from inside a completed step's effect never serves an identical later live emit", async () => {
    let flowCtx: WorkflowContext | undefined;
    const h = boot(
      async (ctx) => {
        flowCtx = ctx;
        ctx.emit("before", {});
        await ctx.run(stepA, {});
        ctx.emit("between", {});
        await ctx.suspend({ on: "go1" });
        ctx.ui.append("timeline", "x"); // identical to the effect's patch
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      {
        effects: (e) =>
          e.register(
            "tool-a",
            new ToolEffect(async () => {
              flowCtx!.ui.append("timeline", "x");
              return { ok: true };
            })
          ),
      }
    );
    const final = (await driveGates(h, "e-closure", ["go1", "go2"])).at(-1)!;
    expect(count(final, "before")).toBe(1);
    expect(count(final, "between")).toBe(1);
    expect(foldSurface(final)).toEqual({ timeline: ["x", "x"] }); // the effect's, then the live one
  });

  it("an emit from inside a decider never serves an identical later live emit", async () => {
    const h = boot(async (ctx) => {
      await ctx.decide("route", () => {
        ctx.emit("note", { n: 1 });
        return "left";
      });
      await ctx.suspend({ on: "go1" });
      ctx.emit("note", { n: 1 });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    });
    const logs = await driveGates(h, "e-decider", ["go1", "go2"]);
    expect(logs.map((log) => count(log, "note"))).toEqual([1, 2, 2]);
  });

  // The price of the unstamped-while-in-flight rule, pinned so it cannot grow unnoticed:
  // flow code that emits WHILE one of its own steps is in flight (not awaited yet) is
  // indistinguishable from an effect's closure, so that emit is appended unstamped. The
  // next re-run (step served, nothing in flight) appends it once more, stamped, and it is
  // stable from then on. Emits made outside the window are unaffected (ADR 0102 D4).
  it("an emit concurrent with an in-flight step is never lost: one extra copy, then stable", async () => {
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
    expect([count(second!, "concurrent"), count(second!, "tail")]).toEqual([2, 1]);
    expect([count(third!, "concurrent"), count(third!, "tail")]).toEqual([2, 1]);
  });

  // ── Fix round 1 — the reviewer's counterexample to ordinal matching ─────────
  //
  // Two concurrent branches: A fails UNTYPED (so it re-executes on every re-run), B
  // completes later and its branch emits b-done. On every re-run B is served at once
  // and b-done fires while A is in flight — a different interleaving from the original
  // run. Under ordinal matching b-done went uncounted on the re-run, `after` inherited
  // its ordinal and was skipped FOREVER, and b-done duplicated on every resume.
  it("reviewer probe: an interleaving that changes across re-runs loses nothing", async () => {
    const h = boot(
      async (ctx) => {
        await Promise.all([
          (async () => {
            try {
              await ctx.run(stepA, {});
            } catch {
              /* untyped failure: legacy re-execution on every re-run */
            }
          })(),
          (async () => {
            await ctx.run(stepB, {});
            ctx.emit("b-done", {});
          })(),
        ]);
        await ctx.suspend({ on: "go1" });
        ctx.emit("after", {});
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      {
        effects: (e) => {
          e.register(
            "tool-a",
            new ToolEffect(async () => {
              await new Promise((r) => setTimeout(r, 1));
              throw new Error("A fails untyped");
            })
          );
          e.register(
            "tool-b",
            new ToolEffect(async () => {
              await new Promise((r) => setTimeout(r, 30));
              return { ok: true };
            })
          );
        },
      }
    );
    const logs = await driveGates(h, "e-probe", ["go1", "go2"]);
    expect(logs.map((log) => count(log, "b-done"))).toEqual([1, 1, 1]);
    expect(logs.map((log) => count(log, "after"))).toEqual([0, 1, 1]);
  });

  it("a timed-out step's zombie effect emitting through the flow ctx never costs a live emit", async () => {
    let flowCtx: WorkflowContext | undefined;
    const slow = step$({
      id: "slow",
      name: "slow",
      toolId: "tool-slow",
      inputSchema: io,
      outputSchema: io,
      timeoutMs: 5,
    });
    const h = boot(
      async (ctx) => {
        flowCtx = ctx;
        try {
          await ctx.run(slow, {});
        } catch {
          /* StepTimeoutError — the effect keeps running (it ignores its signal) */
        }
        await new Promise((r) => setTimeout(r, 60)); // the zombie emits meanwhile
        await ctx.suspend({ on: "go1" });
        ctx.emit("tick", {}); // same content as the zombie's emit
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      {
        effects: (e) =>
          e.register(
            "tool-slow",
            new ToolEffect(async () => {
              await new Promise((r) => setTimeout(r, 25));
              flowCtx!.emit("tick", {});
              return { ok: true };
            })
          ),
      }
    );
    const logs = await driveGates(h, "e-zombie", ["go1", "go2"]);
    // Original run: the zombie's tick (unstamped: its effect had not settled). On the
    // re-run the anchored deadline fails the step at once and the zombie never runs;
    // the live tick after go1 is appended (the zombie's never counted) and then served.
    expect(logs.map((log) => count(log, "tick"))).toEqual([1, 2, 2]);
  });

  it("a code change that adds an emit before a gate appends it; an edited emit is new content", async () => {
    const v1: FlowRunner<Io, Io> = async (ctx) => {
      ctx.emit("a", { v: 1 });
      ctx.emit("b", { v: 1 });
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    };
    const first = boot(v1);
    const started = await first.runtime.start(first.flow, {}, { executionId: "e-deploy" });
    await started.waitForSuspend();

    // A deploy: same flow id/version, a new emit BEFORE the gate and an edited `b`.
    const v2: FlowRunner<Io, Io> = async (ctx) => {
      ctx.emit("a", { v: 1 });
      ctx.emit("new", {});
      ctx.emit("b", { v: 2 });
      await ctx.suspend({ on: "go1" });
      await ctx.suspend({ on: "go2" });
      return { done: true };
    };
    const second = boot(v2, { stores: first.stores });
    const r1 = await second.runtime.resume("e-deploy", { eventType: "go1", payload: {} });
    await r1.waitForSuspend();
    const r2 = await second.runtime.resume("e-deploy", { eventType: "go2", payload: {} });
    await r2.waitForCompletion();
    const log = await second.eventStore.read("e-deploy");
    // `a` is unchanged content → served. `new` is appended once (not lost, not taking a
    // logged emit's place). The edited `b` is new content → appended once; the old
    // `b {v:1}` stays in the log as the record of what v1 emitted.
    expect(
      log.filter((e) => /^(a|b|new)$/.test(e.eventType)).map((e) => [e.eventType, e.payload])
    ).toEqual([
      ["a", { v: 1 }],
      ["b", { v: 1 }],
      ["new", {}],
      ["b", { v: 2 }],
    ]);
  });

  it("a payload with no JSON form cannot be matched, so it is appended (duplicate beats loss)", async () => {
    const h = boot(async (ctx) => {
      ctx.emit("big", { n: 1n });
      await ctx.suspend({ on: "go1" });
      return { done: true };
    });
    const logs = await driveGates(h, "e-bigint", ["go1"]);
    expect(logs.map((log) => count(log, "big"))).toEqual([1, 2]);
    expect(logs[1]!.some((e) => e.metadata?.flowEmit !== undefined)).toBe(false);
  });

  it("mid-run snapshots: the counts ride the snapshot a resume folds from", async () => {
    const h = boot(
      async (ctx) => {
        ctx.emit("one", {});
        ctx.ui.append("timeline", "x");
        ctx.emit("two", {});
        await ctx.suspend({ on: "go1" });
        ctx.emit("three", {});
        await ctx.suspend({ on: "go2" });
        return { done: true };
      },
      { snapshotEvery: 2 }
    );
    const logs = await driveGates(h, "e-snap", ["go1", "go2"]);
    // A mid-run snapshot exists below the tip, so resumes folded snapshot + suffix.
    const snap = await h.stores.snapshotStore.loadLatestBefore("e-snap", logs[0]!.at(-1)!.sequence);
    expect(snap?.state.variables._flowEmits).toBeDefined();
    const final = logs.at(-1)!;
    expect(["one", "SURFACE_PATCH", "two", "three"].map((t) => count(final, t))).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it("compaction: fold(snapshot, suffix) carries the same counts as fold(events)", async () => {
    const h = boot(async (ctx) => {
      ctx.emit("one", {});
      ctx.emit("one", {});
      ctx.ui.append("timeline", "x");
      await ctx.suspend({ on: "go1" });
      return { done: true };
    });
    const started = await h.runtime.start(h.flow, {}, { executionId: "e-compact" });
    await started.waitForSuspend();
    const before = foldEvents(await h.eventStore.read("e-compact"));
    expect(flowEmitCount(before.variables, flowEmitDigest("one", {})!)).toBe(2);

    const life = new LogLifecycle(h.eventStore, h.stores.snapshotStore);
    expect(await life.compact("e-compact")).not.toBeNull();
    const snap = await h.stores.snapshotStore.loadLatest("e-compact");
    const suffix = await h.eventStore.readFrom("e-compact", snap!.sequence + 1);
    const after = foldEvents(suffix, snap!.state);
    expect(after.variables._flowEmits).toEqual(before.variables._flowEmits);
    expect((await h.runtime.loadState("e-compact"))?.variables._flowEmits).toEqual(
      before.variables._flowEmits
    );
  });
});
