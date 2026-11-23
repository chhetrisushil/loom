import { schedule$, step$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loomwork/effect-runtime";
import {
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
} from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SchedulePrincipalError, TimerService } from "./TimerService";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ADR 0152 D2 (R18): the hook across racing nodes, recovery, the retry path, malformed results and
// the warn fallback. Each test names the wrong implementation it kills.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const act = step$({ id: "act", name: "act", toolId: "act-tool", ...io });
const FLOW = "f";
const sched = schedule$({ id: "sch", cron: "* * * * *", flowId: FLOW, input: { label: "x" } });
const MIN = 60_000;
const NOW = 28_333_334 * MIN + MIN / 2;
const first = (Math.floor(NOW / MIN) + 1) * MIN;
const ID = `sch@${first}`;

type Stores = {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
  timerStore: InMemoryTimerStore;
};

function boot(
  opts: { shared?: Stores; deps?: Partial<WorkflowRuntimeDeps>; suspend?: boolean } = {}
) {
  const seen: Array<PrincipalChain | undefined> = [];
  const effects = new EffectRuntime();
  effects.register(
    "act-tool",
    new ToolEffect(async (_i: unknown, ctx) => {
      seen.push(ctx.principal);
      return { ok: true };
    })
  );
  const stores: Stores = opts.shared
    ? {
        eventStore: opts.shared.eventStore,
        snapshotStore: opts.shared.snapshotStore,
        timerStore: opts.shared.timerStore,
      }
    : {
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      };
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    ...opts.deps,
  } as WorkflowRuntimeDeps);
  const definition: FlowDefinition<unknown, unknown> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    ...io,
    steps: [act],
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx, input) => {
    if (opts.suspend) await ctx.suspend({ on: "Go" });
    return ctx.run(act, input);
  };
  runtime.registerFlow(definition, runner);
  return { runtime, seen, ...stores };
}

const startedOf = async (app: { eventStore: InMemoryAsyncEventStore }) =>
  (await app.eventStore.read(ID)).filter((e) => e.eventType === "EXECUTION_STARTED");
const svc = (app: ReturnType<typeof boot>, o: ConstructorParameters<typeof TimerService>[2]) =>
  new TimerService(app.runtime, app.timerStore, { schedules: [sched], now: () => NOW, ...o });

describe("ADR 0152 D2 - racing nodes, recovery, effect side", () => {
  it("two nodes race one occurrence with different hook answers: one start, one effect, the winner's principal, the loser quiet", async () => {
    // Kills: a loser whose principal overwrites or duplicates the record, a second effect run, or a
    // loser that reports its refused start as an error.
    const a = boot();
    const b = boot({ shared: a });
    const errs: unknown[] = [];
    const mk = (app: typeof a, actor: string) =>
      svc(app, {
        onError: (_id, e) => errs.push(e),
        principalFor: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { actor, tenant: "t" };
        },
      });
    await Promise.all([mk(a, "alice").tick(first), mk(b, "bob").tick(first)]);
    const ev = await startedOf(a);
    expect(ev).toHaveLength(1);
    const recorded = JSON.stringify(ev[0]?.payload);
    const effects = [...a.seen, ...b.seen];
    expect(effects).toHaveLength(1);
    const winner = effects[0]?.actor;
    expect(["alice", "bob"]).toContain(winner);
    expect(recorded).toContain(`"${winner}"`);
    expect(recorded).not.toContain(winner === "alice" ? "bob" : "alice");
    expect(errs).toEqual([]);
  });

  it("recovery of a started occurrence resumes as the RECORDED principal and never calls the hook", async () => {
    // Kills: calling the hook on resume/recovery, or resuming as no principal / the resumer.
    const a = boot({ suspend: true });
    await svc(a, { principalFor: () => ({ actor: "alice", tenant: "t" }) }).tick(first);
    expect((await a.runtime.loadState(ID))?.status).toBe("suspended");
    const b = boot({ shared: a, suspend: true });
    const hook = vi.fn(() => ({ actor: "mallory" }));
    const sb = svc(b, { principalFor: hook });
    const run = await b.runtime.resume(ID, { eventType: "Go", payload: {} });
    await run.waitForCompletion();
    await sb.tick(first + 1_000); // the occurrence is already started: no hook either
    expect(hook).not.toHaveBeenCalled();
    expect(b.seen).toEqual([{ actor: "alice", tenant: "t" }]);
  });

  it("the tool's ctx.principal is the hook's principal (effect side, not just the event)", async () => {
    // Kills: a principal recorded on the event but not threaded to the effect context.
    const a = boot();
    await svc(a, { principalFor: () => ({ actor: "alice", tenant: "t" }) }).tick(first);
    expect(a.seen).toEqual([{ actor: "alice", tenant: "t" }]);
  });

  it("StartLeaseHeldError re-calls the hook on the retry poll, holds the cursor, and records ONE start", async () => {
    // Kills: skipping the occurrence on a lease stand-down (hook never re-called, nothing started),
    // advancing the cursor, or starting twice.
    const wall = { t: 1_700_000_000_000 };
    const leaseStore = new InMemoryLeaseStore({ now: () => wall.t });
    const a = boot({
      deps: {
        heartbeat: {
          leaseStore,
          acquire: "eager",
          nodeId: "n1",
          incarnation: "i1",
          ttlMs: 30_000,
          monotonicNow: () => 1_000,
          wallNow: () => wall.t,
          every: () => () => {},
        },
        now: () => wall.t,
      } as Partial<WorkflowRuntimeDeps>,
    });
    await leaseStore.acquire(ID, "crashed:node", 30_000, wall.t); // a ghost lease, no stream
    const hook = vi.fn(() => ({ actor: "alice", tenant: "t" }));
    const errs: unknown[] = [];
    const service = svc(a, { principalFor: hook, onError: (_i, e) => errs.push(e) });
    await service.tick(first);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await startedOf(a)).toHaveLength(0);
    wall.t += 31_000; // the ghost expires
    await service.tick(first + 1_000);
    expect(hook).toHaveBeenCalledTimes(2); // cursor held: the SAME occurrence was retried
    expect(await startedOf(a)).toHaveLength(1);
    expect(a.seen).toEqual([{ actor: "alice", tenant: "t" }]);
    expect(errs).toEqual([]);
  });
});

describe("ADR 0152 D2 - malformed results, warn fallback, timer hygiene", () => {
  it.each([
    ["null", null],
    ["a number", 42],
    ["a string", "alice"],
    ["an object with no identity fields", {}],
    ["a non-string actor", { actor: 42 }],
    ["an unknown shape", { subject: "svc" }],
    ["an array", ["alice"]],
    ["an empty-string actor", { actor: "" }],
  ])("a hook returning %s is skipped with reason invalid and nothing starts", async (_n, ret) => {
    // Kills: starting the run anonymously on a malformed result, or leaking a bare TypeError.
    const a = boot();
    const errs: unknown[] = [];
    await svc(a, {
      onError: (_i, e) => errs.push(e),
      principalFor: (() => ret) as never,
    }).tick(first);
    expect(await a.runtime.loadState(ID)).toBeNull();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBeInstanceOf(SchedulePrincipalError);
    expect((errs[0] as SchedulePrincipalError).reason).toBe("invalid");
    expect(a.seen).toEqual([]);
  });

  it("accepts an onBehalfOf-only and a tenant-only principal", async () => {
    // Kills: a validator stricter than PrincipalChain (rejecting a legitimate shape).
    for (const p of [{ onBehalfOf: "u" }, { tenant: "t" }]) {
      const a = boot();
      const errs: unknown[] = [];
      await svc(a, { onError: (_i, e) => errs.push(e), principalFor: () => p as never }).tick(
        first
      );
      expect(errs).toEqual([]);
      expect(await startedOf(a)).toHaveLength(1);
    }
  });

  it("without onError a skip is reported through the runtime warn path, not silent", async () => {
    // Kills: swallowing a skip when no onError is wired.
    const onWarn = vi.fn();
    const a = boot({ deps: { onWarn } });
    await svc(a, {
      principalFor: () => {
        throw new Error("boom");
      },
    }).tick(first);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]?.[0])).toContain(ID);
    expect(String(onWarn.mock.calls[0]?.[0])).toContain("boom");
  });

  it("a successful hook leaves no timeout timer behind (and the timer is unref'd)", async () => {
    // Kills: forgetting clearTimeout (every occurrence would leak a live 5 s timer), or a ref'd timer
    // that keeps the process alive. `process.getActiveResourcesInfo` hides unref'd timers, so this
    // counts the fake clock's pending timers instead.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const a = boot();
      const unref = vi.spyOn(globalThis, "setTimeout");
      await svc(a, { principalFor: () => ({ actor: "a" }) }).tick(first);
      expect(vi.getTimerCount()).toBe(0);
      const handle = unref.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
      expect(handle?.hasRef?.()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
