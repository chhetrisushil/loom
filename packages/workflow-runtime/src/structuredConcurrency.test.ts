import { SuspendError, TypedFailure, fail, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ParallelScopeFailedError } from "./types";
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
  deps: {
    parkDrainMs?: number;
    scopes?: boolean;
    errorClasses?: Record<string, new (message: string) => Error>;
    shared?: { eventStore: InMemoryAsyncEventStore };
  } = {}
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
    scopes: deps.scopes ?? true,
    ...(deps.errorClasses !== undefined && { errorClasses: deps.errorClasses }),
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
    expect(seen[1]).toBe(seen[0]); // the first run threw exactly what the served re-run threw
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

// ── R6 review round 1 ──────────────────────────────────────────────────────────────────────

const outcome = (r: {
  waitForCompletion(): Promise<unknown>;
  waitForSuspend(): Promise<unknown>;
}): Promise<"completed" | "parked"> =>
  Promise.race([
    r.waitForCompletion().then(() => "completed" as const),
    r.waitForSuspend().then(() => "parked" as const),
  ]);

describe("a served scope is EXACT: the branches the first run launched, the answers it consumed (P1-A/P1-B)", () => {
  it("a limit-bounded scope serves only the branches it LAUNCHED: a never-launched branch's live decide/suspend cannot run (probe: stuck re-parked on the gate)", async () => {
    const A = mk("a");
    const invoked: number[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel(
            [
              async (b: BranchContext) => {
                invoked.push(0);
                return b.run(A, {});
              },
              async (b: BranchContext) => {
                invoked.push(1); // never launched on the first run (limit 1, branch 0 failed)
                await b.suspend({ on: "steal" });
                return 1;
              },
            ],
            { limit: 1 }
          );
        } catch {
          // fail-fast
        }
        await ctx.suspend({ on: "go" });
        return { done: true };
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "lim-exact" });
    await run.waitForSuspend();
    expect(invoked).toEqual([0]);
    const r = await h.runtime.resume("lim-exact", { eventType: "go", payload: {} });
    expect(await outcome(r)).toBe("completed");
    expect(invoked).toEqual([0, 0]); // branch 1 never launched, on either run
    const rec = (await h.eventStore.read("lim-exact")).find(
      (e) => e.eventType === "PARALLEL_COMPLETED"
    );
    expect((rec?.payload as { launched: number }).launched).toBe(1);
  });

  it("a branch swallowed by a triggered scope never steals a LATER gate's answer on the served re-run (probe: the later gate re-parked)", async () => {
    const A = mk("a");
    const seen: unknown[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            async (b: BranchContext) => b.run(A, {}),
            async (b: BranchContext) => {
              await tick(25); // the scope is already aborted when this gate is reached
              return b.suspend({ on: "inner" });
            },
          ]);
        } catch {
          // fail-fast
        }
        seen.push(await ctx.suspend({ on: "later" }));
        return { done: true };
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "steal" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("steal", { eventType: "later", payload: "L" });
    expect(await outcome(r)).toBe("completed");
    expect(seen).toEqual(["L"]); // the later gate got ITS answer
  });

  it("a branch that consumed a gate answer on the first run consumes THAT answer when served; the cursor lands after it", async () => {
    const A = mk("a");
    const branchSaw: unknown[] = [];
    const laterSaw: unknown[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            async (b: BranchContext) => {
              branchSaw.push(await b.suspend({ on: "inner" }));
              return b.run(A, {});
            },
            async (b: BranchContext) => {
              await tick(40);
              return b.sleep(1); // aborted by then: never a gate, never an answer
            },
          ]);
        } catch (e) {
          if (e instanceof SuspendError) throw e; // a park is not a failure to swallow
        }
        laterSaw.push(await ctx.suspend({ on: "later" }));
        return { done: true };
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "cursor" });
    await run.waitForSuspend(); // parked at "inner"
    const r1 = await h.runtime.resume("cursor", { eventType: "inner", payload: "I" });
    await r1.waitForSuspend(); // scope failed (recorded), parked at "later"
    const rec = (await h.eventStore.read("cursor")).find(
      (e) => e.eventType === "PARALLEL_COMPLETED"
    );
    expect(rec?.payload).toMatchObject({ launched: 2, consumed: [["/0.0", 0, 1]], cursor: 1 });
    const r2 = await h.runtime.resume("cursor", { eventType: "later", payload: "L" });
    expect(await outcome(r2)).toBe("completed");
    expect(branchSaw).toEqual(["I", "I"]); // first run + served
    expect(laterSaw).toEqual(["L"]);
  });

  it("a record WITHOUT the additive fields (written before the amendment) serves as before: every branch launches", async () => {
    const A = mk("a");
    const invoked: number[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel(
            [
              async (b: BranchContext) => {
                invoked.push(0);
                return b.run(A, {});
              },
              async (b: BranchContext) => {
                invoked.push(1);
                return 1;
              },
            ],
            { limit: 1 }
          );
        } catch {
          // fail-fast
        }
        await ctx.suspend({ on: "go" });
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "legacy" });
    await run.waitForSuspend();
    // Re-play the log into a fresh store with the amendment's fields stripped from the record.
    const log = await h.eventStore.read("legacy");
    const store2 = new InMemoryAsyncEventStore();
    for (const e of log) {
      if (e.eventType !== "PARALLEL_COMPLETED") {
        await store2.append(e);
        continue;
      }
      const {
        launched: _l,
        consumed: _c,
        cursor: _k,
        errorName: _n,
        ...old
      } = e.payload as Record<string, unknown>;
      await store2.append({ ...e, payload: old });
    }
    const h2 = boot(["a"], { a: async () => ({}) }, h.flow.runner, {
      shared: { eventStore: store2 },
    });
    invoked.length = 0;
    const r = await h2.runtime.resume("legacy", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(invoked).toEqual([0, 1]); // old behaviour: no `launched` → both branches start (served)
  });
});

describe("the consumption record is run-length encoded under a byte budget (review round 2)", () => {
  /** Park at gate "g", then pad the log with `extra` more gate answers (synthetic RESUMED+SUSPENDED pairs). */
  async function withAnswers(h: Harness, id: string, extra: number): Promise<void> {
    const run = await h.runtime.start(h.flow, {}, { executionId: id });
    await run.waitForSuspend();
    const r = await h.runtime.resume(id, { eventType: "g", payload: "p" });
    await r.waitForSuspend();
    const log = await h.eventStore.read(id);
    const resumed = log.filter((e) => e.eventType === "EXECUTION_RESUMED").at(-1) as EventEnvelope;
    const suspended = log.at(-1) as EventEnvelope;
    let seq = suspended.sequence;
    for (let i = 0; i < extra; i++) {
      await h.eventStore.append({ ...resumed, id: `${id}-r${i}`, sequence: ++seq });
      await h.eventStore.append({ ...suspended, id: `${id}-s${i}`, sequence: ++seq });
    }
  }
  const scopeRecord = async (h: Harness, id: string) =>
    (await h.eventStore.read(id)).find((e) => e.eventType === "PARALLEL_COMPLETED")
      ?.payload as Record<string, unknown>;

  it("one branch taking hundreds of answers journals ONE run, and a served re-run takes exactly them", async () => {
    const A = mk("a");
    const N = 300;
    const saw: unknown[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(30);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            async (b: BranchContext) => {
              for (let i = 0; i < N; i++) saw.push(await b.suspend({ on: "g" }));
              return b.run(A, {});
            },
            async (b: BranchContext) => {
              await tick(100);
              return b.sleep(1);
            },
          ]);
        } catch (e) {
          if (e instanceof SuspendError) throw e;
        }
        await ctx.suspend({ on: "later" });
        return {};
      }
    );
    await withAnswers(h, "rle", N - 2);
    const r = await h.runtime.resume("rle", { eventType: "g", payload: "p" });
    await r.waitForSuspend();
    const rec = await scopeRecord(h, "rle");
    expect(rec.consumed).toEqual([["/0.0", 0, N]]);
    expect(h.warnings.filter((w) => w.includes("consumed more than"))).toEqual([]);
    const r2 = await h.runtime.resume("rle", { eventType: "later", payload: "L" });
    expect(await outcome(r2)).toBe("completed");
  });

  it("past the byte budget the record OMITS `consumed`, warns, and a re-run falls back to positional", async () => {
    const A = mk("a");
    const N = 900; // non-contiguous per branch path: one run each, ~20 bytes apiece > 16 KiB
    const took: number[] = [];
    const laterSaw: unknown[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(30);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel(
            Array.from({ length: N }, (_, i) => async (b: BranchContext) => {
              await b.suspend({ on: "g" });
              took.push(i);
              if (i === N - 1) return b.run(A, {});
              await tick(200);
              return i;
            })
          );
        } catch (e) {
          if (e instanceof SuspendError) throw e;
        }
        laterSaw.push(await ctx.suspend({ on: "later" }));
        return {};
      }
    );
    await withAnswers(h, "ovf", N - 2);
    const r = await h.runtime.resume("ovf", { eventType: "g", payload: "p" });
    await r.waitForSuspend();
    const rec = await scopeRecord(h, "ovf");
    expect("consumed" in rec).toBe(false);
    expect("cursor" in rec).toBe(false);
    expect(h.warnings.some((w) => w.includes("consumed more than"))).toBe(true);
    took.length = 0;
    const r2 = await h.runtime.resume("ovf", { eventType: "later", payload: "L" });
    expect(await outcome(r2)).toBe("completed"); // positional fallback still completes
    expect(laterSaw).toEqual(["L"]);
  });
});

describe("a failed scope throws ONE value, first run and re-run alike (P1-C)", () => {
  class OutageError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OutageError";
    }
  }
  const tools = {
    a: async () => {
      await tick(5);
      throw new OutageError("db is down");
    },
    b: untilAborted(),
  };
  const flowOf = (seen: unknown[]): FlowRunner<unknown, unknown> => {
    const A = mk("a");
    const B = mk("b");
    return async (ctx) => {
      try {
        await ctx.parallel([
          [A, {}],
          [B, {}],
        ]);
      } catch (e) {
        seen.push(e);
      }
      await ctx.suspend({ on: "go" });
      return {};
    };
  };

  it("an UNREGISTERED class is a ParallelScopeFailedError naming the class, with the same text both times", async () => {
    const seen: unknown[] = [];
    const h = boot(["a", "b"], tools, flowOf(seen));
    const run = await h.runtime.start(h.flow, {}, { executionId: "e1" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("e1", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(seen).toHaveLength(2);
    for (const e of seen) {
      expect(e).toBeInstanceOf(ParallelScopeFailedError);
      expect((e as ParallelScopeFailedError).errorName).toBe("OutageError");
      expect((e as ParallelScopeFailedError).message).toBe("db is down");
      expect((e as ParallelScopeFailedError).scopePath).toBe("/0");
      expect((e as ParallelScopeFailedError).failedBranch).toBe(0);
    }
    const rec = (await h.eventStore.read("e1")).find((e) => e.eventType === "PARALLEL_COMPLETED");
    expect(rec?.payload).toMatchObject({
      errorName: "OutageError",
      error: "OutageError: db is down",
    });
  });

  it("a REGISTERED class is rebuilt from the recorded message: first run and served re-run are both that class", async () => {
    const seen: unknown[] = [];
    const h = boot(["a", "b"], tools, flowOf(seen), { errorClasses: { OutageError } });
    const run = await h.runtime.start(h.flow, {}, { executionId: "e2" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("e2", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(seen).toHaveLength(2);
    for (const e of seen) {
      expect(e).toBeInstanceOf(OutageError);
      expect((e as Error).message).toBe("db is down");
    }
  });

  it("a registered constructor that THROWS falls back to the typed carrier", async () => {
    class Picky extends Error {
      constructor(_m: string) {
        super("x");
        throw new Error("cannot rebuild");
      }
    }
    const seen: unknown[] = [];
    const h = boot(["a", "b"], tools, flowOf(seen), { errorClasses: { OutageError: Picky } });
    const run = await h.runtime.start(h.flow, {}, { executionId: "e3" });
    await run.waitForSuspend();
    expect(seen[0]).toBeInstanceOf(ParallelScopeFailedError);
  });

  it("a built-in class is rebuilt: a TypeError stays a TypeError on both runs", async () => {
    const seen: unknown[] = [];
    const h = boot(
      ["a", "b"],
      {
        a: async () => {
          await tick(5);
          throw new TypeError("not a function");
        },
        b: untilAborted(),
      },
      flowOf(seen)
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "e4" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("e4", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    for (const e of seen) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toBe("not a function");
    }
  });

  it("a TypedFailure stays typed (channel + payload) on both runs, and the text has ONE TypedFailure prefix", async () => {
    const Typed = step$({
      id: "typed",
      name: "typed",
      toolId: "tool-typed",
      ...io,
      errors: { outage: Outage },
    });
    const seen: unknown[] = [];
    const h = boot(
      [Typed, "b"],
      { typed: async () => fail("outage", { code: 503 }), b: untilAborted() },
      async (ctx) => {
        try {
          await ctx.parallel([
            [Typed, {}],
            [mk("b"), {}],
          ]);
        } catch (e) {
          seen.push(e);
        }
        await ctx.suspend({ on: "go" });
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "e5" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("e5", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(seen).toHaveLength(2);
    for (const e of seen) {
      expect(e).toBeInstanceOf(TypedFailure);
      expect((e as TypedFailure).channel).toBe("outage");
      expect((e as TypedFailure).payload).toEqual({ code: 503 });
      expect(String(e)).not.toContain("TypedFailure: TypedFailure");
    }
    expect((seen[0] as Error).message).toBe((seen[1] as Error).message);
  });

  it("a TypedFailure thrown by a branch FUNCTION (no step frame) stays typed when served", async () => {
    const seen: unknown[] = [];
    const h = boot([], {}, async (ctx) => {
      try {
        await ctx.parallel([
          async () => {
            await tick(5);
            return fail("outage", { code: 7 });
          },
          async (b: BranchContext) => {
            await tick(30);
            return b.sleep(1);
          },
        ]);
      } catch (e) {
        seen.push(e);
      }
      await ctx.suspend({ on: "go" });
      return {};
    });
    const run = await h.runtime.start(h.flow, {}, { executionId: "e6" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("e6", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(seen).toHaveLength(2);
    for (const e of seen) {
      expect(e).toBeInstanceOf(TypedFailure);
      expect((e as TypedFailure).payload).toEqual({ code: 7 });
    }
  });
});

describe("kernel.features.scopes: OFF by default is the pre-R6 behaviour (P2-B)", () => {
  it("off: a failing branch aborts nothing, writes no STEP_CANCELLED and no PARALLEL_COMPLETED, and the ORIGINAL error is thrown", async () => {
    const A = mk("a");
    const B = mk("b");
    const original = new Error("a exploded");
    let caught: unknown;
    const h = boot(
      ["a", "b"],
      {
        a: async () => {
          await tick(5);
          throw original;
        },
        b: async (_i, ctx) => {
          await tick(30);
          return { aborted: ctx.signal?.aborted ?? false };
        },
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
        return {};
      },
      { scopes: false }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "off" });
    await run.waitForCompletion();
    expect(caught).toBe(original);
    expect(h.signals.b?.aborted).toBeFalsy();
    const log = await h.eventStore.read("off");
    expect(count(log, "STEP_CANCELLED")).toBe(0);
    expect(count(log, "PARALLEL_COMPLETED")).toBe(0);
  });

  it("is the DEFAULT when the dep is omitted, and a record written by a scopes-ON node is ignored (the branches re-run live)", async () => {
    const A = mk("a");
    let aCalls = 0;
    const flow: FlowRunner<unknown, unknown> = async (ctx) => {
      try {
        await ctx.parallel([[A, {}]]);
      } catch {
        // fail-fast
      }
      await ctx.suspend({ on: "go" });
      return {};
    };
    const on = boot(
      ["a"],
      {
        a: async () => {
          aCalls++;
          throw new Error("boom");
        },
      },
      flow
    );
    const run = await on.runtime.start(on.flow, {}, { executionId: "mixed" });
    await run.waitForSuspend();
    expect(count(await on.eventStore.read("mixed"), "PARALLEL_COMPLETED")).toBe(1);
    const off = boot(
      ["a"],
      {
        a: async () => {
          aCalls++;
          return { ok: true };
        },
      },
      flow,
      { scopes: false, shared: { eventStore: on.eventStore } }
    );
    const r = await off.runtime.resume("mixed", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(aCalls).toBe(2); // not served from the record
  });
});

describe("nothing follows the park or the terminal event (P2-A)", () => {
  it("a branch that drained cleanly cannot emit or decide AFTER EXECUTION_SUSPENDED (probe: …EXECUTION_SUSPENDED,custom.after,DECISION_RECORDED)", async () => {
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
        await ctx.parallel([
          async (c: BranchContext) => c.suspend({ on: "gate" }),
          async (c: BranchContext) => {
            await c.run(B, {});
            await tick(10); // user code AFTER the step drained, past the park
            c.emit("custom.after", {});
            await c.decide("late", () => 1);
            return 1;
          },
        ]);
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "late" });
    await run.waitForSuspend();
    await tick(60);
    const t = types(await h.eventStore.read("late"));
    expect(t.at(-1)).toBe("EXECUTION_SUSPENDED");
    expect(t).not.toContain("DECISION_RECORDED");
  });

  it("an abandoned task cannot append after EXECUTION_COMPLETED (zombie-after-terminal)", async () => {
    const h = boot([], {}, async (ctx) => {
      void (async () => {
        await tick(25);
        ctx.emit("zombie", {});
      })();
      return { ok: true };
    });
    const run = await h.runtime.start(h.flow, {}, { executionId: "zombie" });
    await run.waitForCompletion();
    await tick(50);
    const t = types(await h.eventStore.read("zombie"));
    expect(t.at(-1)).toBe("EXECUTION_COMPLETED");
  });

  it("a decide in a SERVED scope that was never recorded throws ScopeServedError and appends nothing (and an aborted scope makes none either)", async () => {
    const A = mk("a");
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(5);
          throw new Error("a exploded");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel([
            async (b: BranchContext) => b.run(A, {}),
            async (b: BranchContext) => {
              await tick(25);
              return b.decide("fresh", () => "x");
            },
          ]);
        } catch {
          // fail-fast
        }
        await ctx.suspend({ on: "go" });
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "dec" });
    await run.waitForSuspend();
    const r = await h.runtime.resume("dec", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(count(await h.eventStore.read("dec"), "DECISION_RECORDED")).toBe(0);
  });
});

describe("cause and cancel seal (review round 2)", () => {
  it("the FIRST run's thrown error carries the original as `cause` (and warns with its stack); a served re-run has none", async () => {
    const A = mk("a");
    const causes: unknown[] = [];
    const h = boot(
      ["a"],
      {
        a: async () => {
          await tick(5);
          throw new Error("orig boom");
        },
      },
      async (ctx) => {
        try {
          await ctx.parallel([async (b: BranchContext) => b.run(A, {})]);
        } catch (e) {
          causes.push((e as Error).cause);
        }
        await ctx.suspend({ on: "go" });
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "cause" });
    await run.waitForSuspend();
    expect(String((causes[0] as Error).message)).toContain("orig boom");
    expect(h.warnings.some((w) => w.includes("original error") && w.includes("orig boom"))).toBe(
      true
    );
    const r = await h.runtime.resume("cause", { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(causes[1]).toBeUndefined();
  });

  it("a zombie cannot append after EXECUTION_CANCELLED", async () => {
    const h = boot([], {}, async (ctx) => {
      void (async () => {
        await tick(40);
        ctx.emit("zombie.after.cancel", {});
      })();
      await tick(500);
      return {};
    });
    const run = await h.runtime.start(h.flow, {}, { executionId: "zc" });
    await tick(5);
    run.cancel("stop");
    await run.waitForCompletion().catch(() => {});
    await tick(80);
    const t = types(await h.eventStore.read("zc"));
    expect(t).toContain("EXECUTION_CANCELLED");
    expect(t.some((x) => x.includes("zombie.after"))).toBe(false);
  });
});

describe("a branch that closes over the ROOT ctx stays in its scope (P2-C)", () => {
  it("abort cancels a step issued through the root ctx from inside a branch", async () => {
    const A = mk("a");
    const B = mk("b");
    let caught: unknown;
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
        try {
          await ctx.parallel([
            async (b: BranchContext) => b.run(A, {}),
            async () => ctx.run(B, {}), // the ROOT ctx, closed over
          ]);
        } catch (e) {
          caught = e;
        }
        return {};
      }
    );
    const run = await h.runtime.start(h.flow, {}, { executionId: "root-ctx" });
    await run.waitForCompletion();
    expect(String(caught)).toContain("a exploded");
    expect(h.signals.b?.aborted).toBe(true); // the scope's abort reached it
    expect(
      (await h.eventStore.read("root-ctx")).filter((e) => e.eventType === "STEP_CANCELLED")
    ).toHaveLength(1);
  });

  it("root ctx.parallel from concurrent branches numbers scopes by BRANCH, not by timing", async () => {
    const paths: string[] = [];
    const h = boot([], {}, async (ctx) => {
      const inner = async (b: BranchContext) => {
        paths.push(b.scopePath);
        return 1;
      };
      await ctx.parallel([
        async () => {
          await tick(20); // arrives second
          await ctx.parallel([inner]); // closed-over root ctx
        },
        async () => {
          await ctx.parallel([inner]);
        },
      ]);
      return {};
    });
    const run = await h.runtime.start(h.flow, {}, { executionId: "k-order" });
    await run.waitForCompletion();
    expect([...paths].sort()).toEqual(["/0.0/0.0", "/0.1/0.0"]);
  });
});
