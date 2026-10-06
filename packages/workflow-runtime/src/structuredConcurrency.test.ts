import { TypedFailure, fail, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { BranchContext, FlowRunner } from "./types";

// ── ADR 0112 — structured concurrency: cancellation scopes + the park barrier ──────────────
//
// Each `parallel` is a cancellation scope. A first real failure aborts it (in-flight steps see
// the signal and record STEP_CANCELLED), its outcome is journaled as a kernel-stamped
// PARALLEL_COMPLETED, and a re-run serves the scope from that record — replay never depends on
// timing. A park is a BARRIER, not a failure: no new step starts, in-flight siblings settle
// BEFORE EXECUTION_SUSPENDED.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const Outage = z.object({ code: z.number() });
const mk = (id: string, errors?: Record<string, z.ZodTypeAny>) =>
  step$({ id, name: id, toolId: `tool-${id}`, ...io, ...(errors !== undefined && { errors }) });
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const types = (log: EventEnvelope[]): string[] => log.map((e) => e.eventType);
const count = (log: EventEnvelope[], t: string): number =>
  log.filter((e) => e.eventType === t).length;

interface Harness {
  runtime: WorkflowRuntime;
  eventStore: InMemoryAsyncEventStore;
  started: string[];
  warnings: string[];
  signals: Record<string, AbortSignal | undefined>;
  keys: Record<string, string[]>;
  flow: { definition: FlowDefinition<unknown, unknown>; runner: FlowRunner<unknown, unknown> };
}

/** `tools[id]` is the tool's body; every call is recorded in `started`. */
function boot(
  steps: Array<string | ReturnType<typeof mk>>,
  tools: Record<string, (input: unknown, ctx: EffectContext) => Promise<unknown>>,
  runner: FlowRunner<unknown, unknown>,
  deps: { parkDrainMs?: number; shared?: { eventStore: InMemoryAsyncEventStore } } = {}
): Harness {
  const started: string[] = [];
  const signals: Record<string, AbortSignal | undefined> = {};
  const keys: Record<string, string[]> = {};
  const warnings: string[] = [];
  const effects = new EffectRuntime();
  for (const [id, body] of Object.entries(tools)) {
    effects.register(
      `tool-${id}`,
      new ToolEffect(async (input: unknown, ctx: EffectContext) => {
        started.push(id);
        signals[id] = ctx.signal;
        keys[id] = [...(keys[id] ?? []), ctx.idempotencyKey ?? ""];
        return body(input, ctx);
      })
    );
  }
  const eventStore = deps.shared?.eventStore ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: (m) => warnings.push(m),
    ...(deps.parkDrainMs !== undefined && { parkDrainMs: deps.parkDrainMs }),
  });
  const definition: FlowDefinition<unknown, unknown> = {
    _tag: "FlowDefinition",
    id: "par",
    name: "par",
    version: "1.0.0",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: steps.map((s) => (typeof s === "string" ? mk(s) : s)),
  };
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, started, warnings, signals, keys, flow: { definition, runner } };
}

/** A tool that settles only when aborted (cooperative), rejecting with the abort reason. */
const untilAborted =
  () =>
  (_i: unknown, ctx: EffectContext): Promise<never> =>
    new Promise((_, reject) => {
      ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason), { once: true });
    });

describe("fail-fast: a scope aborts its siblings and journals its outcome (ADR 0112 D2)", () => {
  it("the first real failure aborts the sibling's signal, records STEP_CANCELLED and PARALLEL_COMPLETED, rethrows the real error", async () => {
    const A = mk("a");
    const B = mk("b");
    let caught: unknown;
    const h = boot(
      ["a", "b"],
      {
        a: async () => {
          await tick(10);
          throw new Error("a exploded");
        },
        b: untilAborted(),
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            [A, {}],
            [B, {}],
          ]);
        } catch (e) {
          caught = e;
        }
        return { ok: true };
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "ff" });
    await run.waitForCompletion();
    expect(String(caught)).toContain("a exploded"); // the real error, not the abort noise
    expect(h.signals.b?.aborted).toBe(true);
    const log = await h.eventStore.read("ff");
    const cancelled = log.filter((e) => e.eventType === "STEP_CANCELLED");
    expect(cancelled.map((e) => (e.payload as { stepId: string }).stepId)).toEqual(["b"]);
    const done = log.filter((e) => e.eventType === "PARALLEL_COMPLETED");
    expect(done).toHaveLength(1);
    expect(done[0]?.metadata?.kernel).toBe(true);
    expect(done[0]?.payload).toMatchObject({
      scopePath: "/0",
      failedBranch: 0,
      cancelled: ["b"],
    });
    expect((done[0]?.payload as { error: string }).error).toContain("a exploded");
    // The record precedes the rethrow: it follows the cancellation, before the flow's end.
    expect(types(log).indexOf("PARALLEL_COMPLETED")).toBeGreaterThan(
      types(log).indexOf("STEP_CANCELLED")
    );
  });

  it("a RE-RUN serves the scope from the record: no cancelled or failed branch starts, the same error is rethrown (the negative: a flaky step that would now succeed)", async () => {
    const A = mk("a");
    const B = mk("b");
    let aCalls = 0;
    const seen: string[] = [];
    const h = boot(
      ["a", "b"],
      {
        // fails the FIRST time only: without the record a re-run would run it again and succeed
        a: async () => {
          aCalls++;
          await tick(5);
          if (aCalls === 1) throw new Error("a exploded");
          return { ok: true };
        },
        b: untilAborted(),
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            [A, {}],
            [B, {}],
          ]);
          seen.push("parallel-ok");
        } catch (e) {
          seen.push(`caught:${String(e)}`);
        }
        await ctx.suspend({ on: "go" });
        return { ok: true };
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "rr" });
    await run.waitForSuspend();
    expect(h.started).toEqual(["a", "b"]);
    const resumed = await h.runtime.resume("rr", { eventType: "go", payload: {} });
    await resumed.waitForCompletion();
    // Nothing re-ran, and the flow took the same catch branch both times.
    expect(h.started).toEqual(["a", "b"]);
    expect(aCalls).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("caught:");
    expect(seen[1]).toContain("a exploded");
    expect(seen[1]).toContain("ParallelScopeFailedError"); // served from the journaled record
    expect(seen).not.toContain("parallel-ok");
  });

  it("is independent of timing: the same flow with the failure arriving first or last serves the same way", async () => {
    for (const failAfter of [0, 25]) {
      const A = mk("a");
      const B = mk("b");
      const C = mk("c");
      const outcomes: string[] = [];
      const h = boot(
        ["a", "b", "c"],
        {
          a: async () => {
            await tick(failAfter);
            throw new Error("boom");
          },
          // b finishes at 10ms: before a's late failure, after a's immediate one
          b: async (_i, ctx) => {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 10);
              ctx.signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(ctx.signal?.reason);
                },
                { once: true }
              );
            });
            return { b: true };
          },
          c: untilAborted(),
        },
        async (ctx) => {
          try {
            await ctx.parallel([
              [A, {}],
              [B, {}],
              [C, {}],
            ]);
          } catch (e) {
            outcomes.push(String(e));
          }
          await ctx.suspend({ on: "go" });
          return {};
        }
      );
      const run = await h.runtime.start(h.flow, {}, { executionId: `t${failAfter}` });
      await run.waitForSuspend();
      const first = h.started.slice();
      const r = await h.runtime.resume(`t${failAfter}`, { eventType: "go", payload: {} });
      await r.waitForCompletion();
      expect(h.started).toEqual(first); // the re-run started nothing, whatever the first run's timing
      expect(outcomes).toHaveLength(2);
      expect(outcomes[1]).toContain("boom"); // the served rethrow carries the recorded error
      expect(outcomes[0]).toContain("boom");
    }
  });

  it("a recorded TYPED failure is rethrown as the TypedFailure", async () => {
    const Typed = step$({
      id: "typed",
      name: "typed",
      toolId: "tool-typed",
      ...io,
      errors: { outage: Outage },
    });
    const B = mk("b");
    const seen: unknown[] = [];
    const h = boot(
      [Typed, "b"],
      {
        typed: async () => fail("outage", { code: 503 }),
        b: untilAborted(),
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            [Typed, {}],
            [B, {}],
          ]);
        } catch (e) {
          seen.push(e);
        }
        await ctx.suspend({ on: "go" });
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "typed" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("typed", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(seen).toHaveLength(2);
    for (const e of seen) {
      expect(e).toBeInstanceOf(TypedFailure);
      expect((e as TypedFailure).channel).toBe("outage");
    }
  });

  it("failFast: false lets every branch settle, cancels nothing and journals no scope outcome", async () => {
    const A = mk("a");
    const B = mk("b");
    const h = boot(
      ["a", "b"],
      {
        a: async () => {
          throw new Error("a exploded");
        },
        b: async () => {
          await tick(20);
          return { b: true };
        },
      },
      async (ctx) => {
        await ctx
          .parallel(
            [
              [A, {}],
              [B, {}],
            ],
            { failFast: false }
          )
          .catch(() => undefined);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "nff" });
    await run.waitForCompletion();
    const log = await h.eventStore.read("nff");
    expect(count(log, "STEP_COMPLETED")).toBe(1); // b ran to completion
    expect(count(log, "STEP_CANCELLED")).toBe(0);
    expect(count(log, "PARALLEL_COMPLETED")).toBe(0);
  });

  it("with a limit, branches still queued when one fails never start", async () => {
    const steps = ["a", "b", "c", "d"].map((x) => mk(x));
    const h = boot(
      ["a", "b", "c", "d"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
        b: untilAborted(),
        c: async () => ({}),
        d: async () => ({}),
      },
      async (ctx) => {
        await ctx
          .parallel(steps.map((s) => [s, {}] as [typeof s, unknown]) as never, { limit: 2 })
          .catch(() => undefined);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "lim" });
    await run.waitForCompletion();
    expect(h.started).toEqual(["a", "b"]);
  });

  it("an execution cancelled mid-scope records no PARALLEL_COMPLETED (EXECUTION_CANCELLED owns the outcome)", async () => {
    const B = mk("b");
    const C = mk("c");
    const h = boot(["b", "c"], { b: untilAborted(), c: untilAborted() }, async (ctx) => {
      await ctx.parallel([
        [B, {}],
        [C, {}],
      ]);
      return {};
    });
    const run = await h.runtime.start(h.flow, {}, { executionId: "xc" });
    await tick(20);
    run.cancel("stop");
    await run.waitForCompletion().catch(() => undefined);
    await tick(20);
    const log = await h.eventStore.read("xc");
    expect(count(log, "PARALLEL_COMPLETED")).toBe(0);
    expect(count(log, "EXECUTION_CANCELLED")).toBe(1);
  });

  it("an UNSTAMPED PARALLEL_COMPLETED in a log is ignored: the scope runs live", async () => {
    const A = mk("a");
    let calls = 0;
    const h = boot(
      ["a"],
      {
        a: async () => {
          calls++;
          return { ok: true };
        },
      },
      async (ctx) => {
        await ctx.suspend({ on: "go" });
        await ctx.parallel([[A, {}]]);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "unstamped" });
    await run.waitForSuspend();
    const log = await h.eventStore.read("unstamped");
    const last = log[log.length - 1] as EventEnvelope;
    await h.eventStore.append({
      ...last,
      id: "unstamped-pc",
      eventType: "PARALLEL_COMPLETED",
      sequence: last.sequence + 1,
      payload: { scopePath: "/0", failedBranch: 0, error: "forged", cancelled: [] },
    });
    const r = await h.runtime.resume("unstamped", { eventType: "go", payload: {} });
    await expect(r.waitForCompletion()).resolves.toMatchObject({ status: "completed" });
    expect(calls).toBe(1);
  });
});

describe("scope identity (ADR 0112 D1)", () => {
  it("branch functions get a deterministic scopePath: <parent>/<k>.<branch>, k per parallel call, stable across a re-run", async () => {
    const paths: string[][] = [[], []];
    let run = 0;
    const h = boot([], {}, async (ctx) => {
      const log = paths[run] as string[];
      const rec = (b: BranchContext) => async () => {
        log.push(b.scopePath);
        return b.scopePath;
      };
      await ctx.parallel([rec, rec].map((f) => (b: BranchContext) => f(b)()) as never);
      await ctx.parallel([
        async (b: BranchContext) => {
          log.push(b.scopePath);
          // a nested scope inherits its parent's path
          await b.parallel([
            async (c: BranchContext) => {
              log.push(c.scopePath);
              return 1;
            },
          ]);
          return 2;
        },
        async (b: BranchContext) => {
          log.push(b.scopePath);
          return 3;
        },
      ]);
      await ctx.suspend({ on: "go" });
      return {};
    });
    const first = await h.runtime.start(h.flow, {}, { executionId: "paths" });
    await first.waitForSuspend();
    run = 1;
    const second = await h.runtime.resume("paths", { eventType: "go", payload: {} });
    await second.waitForCompletion();
    expect([...(paths[0] ?? [])].sort()).toEqual(
      ["/0.0", "/0.1", "/1.0", "/1.0/0.0", "/1.1"].sort()
    );
    expect([...(paths[1] ?? [])].sort()).toEqual([...(paths[0] ?? [])].sort());
  });

  it("a branch function's steps belong to the scope: its failure aborts a sibling function branch", async () => {
    const A = mk("a");
    const B = mk("b");
    const h = boot(
      ["a", "b"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
        b: untilAborted(),
      },
      async (ctx) => {
        await ctx
          .parallel([
            async (b: BranchContext) => b.run(A, {}),
            async (b: BranchContext) => b.run(B, {}),
          ])
          .catch(() => undefined);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "fnb" });
    await run.waitForCompletion();
    const log = await h.eventStore.read("fnb");
    expect(count(log, "STEP_CANCELLED")).toBe(1);
    expect(count(log, "PARALLEL_COMPLETED")).toBe(1);
  });

  it("an inner scope aborted by its OUTER scope's failure records nothing of its own", async () => {
    const A = mk("a");
    const B = mk("b");
    const h = boot(
      ["a", "b"],
      {
        a: async () => {
          await tick(5);
          throw new Error("outer boom");
        },
        b: untilAborted(),
      },
      async (ctx) => {
        await ctx
          .parallel([
            async (b: BranchContext) => b.run(A, {}),
            async (b: BranchContext) => b.parallel([async (c: BranchContext) => c.run(B, {})]),
          ])
          .catch(() => undefined);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "nest" });
    await run.waitForCompletion();
    const done = (await h.eventStore.read("nest")).filter(
      (e) => e.eventType === "PARALLEL_COMPLETED"
    );
    expect(done).toHaveLength(1);
    expect(done[0]?.payload).toMatchObject({ scopePath: "/0", failedBranch: 0, cancelled: ["b"] });
  });
});

describe("the park barrier (ADR 0112 D3)", () => {
  it("a SuspendError in one branch is NOT fail-fast, and the sibling's completion lands BEFORE EXECUTION_SUSPENDED", async () => {
    const B = mk("b");
    const h = boot(
      ["b"],
      {
        b: async () => {
          await tick(30);
          return { b: true };
        },
      },
      async (ctx) => {
        await ctx.parallel([
          async (c: BranchContext) => c.suspend({ on: "gate" }),
          async (c: BranchContext) => c.run(B, {}),
        ]);
        return { done: true };
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "park" });
    await run.waitForSuspend();
    await tick(60);
    const log = await h.eventStore.read("park");
    const t = types(log);
    expect(t.at(-1)).toBe("EXECUTION_SUSPENDED"); // no sibling event after the park
    expect(t.indexOf("STEP_COMPLETED")).toBeLessThan(t.indexOf("EXECUTION_SUSPENDED"));
    expect(count(log, "STEP_CANCELLED")).toBe(0);
    expect(count(log, "PARALLEL_COMPLETED")).toBe(0);
    const r = await h.runtime.resume("park", { eventType: "gate", payload: {} });
    await expect(r.waitForCompletion()).resolves.toMatchObject({ status: "completed" });
    expect(h.started).toEqual(["b"]); // served from its frame, not re-run
  });

  it("once a park is decided, a sibling's NEW step does not start (it waits for the resume)", async () => {
    const B1 = mk("b1");
    const B2 = mk("b2");
    const h = boot(
      ["b1", "b2"],
      {
        b1: async () => {
          await tick(30);
          return {};
        },
        b2: async () => ({}),
      },
      async (ctx) => {
        await ctx.parallel([
          async (c: BranchContext) => c.suspend({ on: "gate" }),
          async (c: BranchContext) => {
            await c.run(B1, {});
            await c.run(B2, {}); // the park is decided by now
            return 1;
          },
        ]);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "freeze" });
    await run.waitForSuspend();
    await tick(60);
    expect(h.started).toEqual(["b1"]); // b2 never started before the park
    const log = await h.eventStore.read("freeze");
    expect(types(log).at(-1)).toBe("EXECUTION_SUSPENDED");
    expect(count(log, "STEP_STARTED")).toBe(1);
    const r = await h.runtime.resume("freeze", { eventType: "gate", payload: {} });
    await expect(r.waitForCompletion()).resolves.toMatchObject({ status: "completed" });
    expect(h.started).toEqual(["b1", "b2"]); // b1 served, b2 ran after the resume
  });

  it('onPark: "abort" aborts the siblings first (STEP_CANCELLED before the park) and they re-run on resume', async () => {
    const B = mk("b");
    let bCalls = 0;
    const h = boot(
      ["b"],
      {
        b: async (i, ctx) => {
          bCalls++;
          if (bCalls === 1) return untilAborted()(i, ctx);
          return { b: true };
        },
      },
      async (ctx) => {
        await ctx.parallel(
          [async (c: BranchContext) => c.suspend({ on: "gate" }), async (c) => c.run(B, {})],
          { onPark: "abort" }
        );
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "abort" });
    await run.waitForSuspend();
    await tick(30);
    const log = await h.eventStore.read("abort");
    const t = types(log);
    expect(t.at(-1)).toBe("EXECUTION_SUSPENDED");
    expect(t.indexOf("STEP_CANCELLED")).toBeGreaterThan(-1);
    expect(t.indexOf("STEP_CANCELLED")).toBeLessThan(t.indexOf("EXECUTION_SUSPENDED"));
    expect(count(log, "PARALLEL_COMPLETED")).toBe(0); // a park is not a failure
    const r = await h.runtime.resume("abort", { eventType: "gate", payload: {} });
    await expect(r.waitForCompletion()).resolves.toMatchObject({ status: "completed" });
    expect(bCalls).toBe(2);
  });

  it("parkDrainMs expiry aborts, then SEALS: the straggler's append is dropped, it re-runs on resume under the SAME idempotency key", async () => {
    const B = mk("b");
    let release: (() => void) | undefined;
    let bCalls = 0;
    const h = boot(
      ["b"],
      {
        // ignores its signal: only `release` ends it
        b: async () => {
          bCalls++;
          if (bCalls === 1) {
            await new Promise<void>((r) => {
              release = r;
            });
          }
          return { b: true };
        },
      },
      async (ctx) => {
        await ctx.parallel([
          async (c: BranchContext) => c.suspend({ on: "gate" }),
          async (c) => c.run(B, {}),
        ]);
        return {};
      },
      { parkDrainMs: 30 }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "seal" });
    await run.waitForSuspend();
    const parked = await h.eventStore.read("seal");
    expect(types(parked).at(-1)).toBe("EXECUTION_SUSPENDED");
    release?.(); // the straggler finishes AFTER the park
    await tick(30);
    const after = await h.eventStore.read("seal");
    expect(types(after)).toEqual(types(parked)); // nothing written after the park
    expect(h.warnings.some((w) => w.includes("DROPPED"))).toBe(true);
    const r = await h.runtime.resume("seal", { eventType: "gate", payload: {} });
    await expect(r.waitForCompletion()).resolves.toMatchObject({ status: "completed" });
    expect(bCalls).toBe(2);
    expect(h.keys.b?.[0]).toBe(h.keys.b?.[1]); // the same logical attempt
  });

  it("a hand-rolled Promise.all (no scope) is drained too: its step lands before the park", async () => {
    const B = mk("b");
    const h = boot(
      ["b"],
      {
        b: async () => {
          await tick(20);
          return {};
        },
      },
      async (ctx) => {
        await Promise.all([ctx.run(B, {}), ctx.suspend({ on: "gate" })]);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "raw" });
    await run.waitForSuspend();
    await tick(40);
    const t = types(await h.eventStore.read("raw"));
    expect(t.at(-1)).toBe("EXECUTION_SUSPENDED");
    expect(t.indexOf("STEP_COMPLETED")).toBeLessThan(t.indexOf("EXECUTION_SUSPENDED"));
  });
});
