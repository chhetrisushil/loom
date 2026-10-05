import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { recoverAbandoned } from "./recoverAbandoned";
import { type ExecutionAuthzRequest, ExecutionDeniedError } from "./types";
import type { ExecutionAuthorizer, FlowRunner, RegisteredFlow } from "./types";

// ── R3 (1P half) — fail-closed execution authorization ───────────────────────
//
// Before: a call with no principal skipped the ExecutionAuthorizer entirely, so a strict app
// that forgot to attach one at its edge was wide open. With `executionAuthz.requirePrincipal`
// the authorizer sees the principal-less request and decides; the kernel's own principal-less
// machinery presents an unforgeable system grant instead.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });

type R = FlowRunner<Record<string, never>, { ok: boolean }>;
function makeFlow(id: string, runner: R): RegisteredFlow<Record<string, never>, { ok: boolean }> {
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [echo],
  };
  return { definition, runner };
}

const gateFlow = makeFlow("gated", async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return ctx.run(echo, {});
});
const sleepyFlow = makeFlow("sleepy", async (ctx) => {
  await ctx.sleepUntil(Date.now() + 10);
  return ctx.run(echo, {});
});

const alice: PrincipalChain = { actor: "alice", tenant: "t1" };

function build(opts: {
  strict: boolean;
  authorizer?: ExecutionAuthorizer;
  shared?: ReturnType<typeof stores>;
}) {
  const s = opts.shared ?? stores();
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async () => ({ ok: true })));
  const seen: ExecutionAuthzRequest[] = [];
  const authorizer: ExecutionAuthorizer = opts.authorizer ?? executionAccessPolicy();
  const runtime = new WorkflowRuntime({
    eventStore: s.eventStore,
    snapshotStore: s.snapshotStore,
    effectRuntime: effects,
    timerStore: s.timerStore,
    executionAuthorizer: {
      authorize: (r) => {
        seen.push(r);
        return authorizer.authorize(r);
      },
      committed: (r) => authorizer.committed?.(r),
    },
    ...(opts.strict && { executionAuthz: { requirePrincipal: true } }),
  });
  for (const f of [gateFlow, sleepyFlow]) runtime.registerFlow(f.definition, f.runner);
  return { runtime, seen, ...s };
}
function stores() {
  return {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    timerStore: new InMemoryTimerStore(),
  };
}

describe("R3 — fail-closed execution authz", () => {
  it("strict: a principal-less start/resume/cancel/loadState is denied (EXECUTION_DENIED on resume/cancel)", async () => {
    const h = build({ strict: true });
    const handle = await h.runtime.start(gateFlow, {}, { principal: alice, executionId: "e1" });
    await handle.waitForSuspend();
    const before = (await h.eventStore.read("e1")).length;

    await expect(h.runtime.start(gateFlow, {}, { executionId: "e2" })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    expect(await h.eventStore.read("e2")).toHaveLength(0); // nothing started
    await expect(h.runtime.resume("e1", { eventType: "GO", payload: {} })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(h.runtime.cancel("e1")).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(h.runtime.loadState("e1")).rejects.toBeInstanceOf(ExecutionDeniedError);

    // Only the audit fact the existing denial path writes (deduped: consecutive identical).
    const log = await h.eventStore.read("e1");
    const extra = log.slice(before).map((e) => e.eventType);
    expect(extra.every((t) => t === "EXECUTION_DENIED")).toBe(true);
    expect((await h.runtime.loadState("e1", { principal: alice }))?.status).toBe("suspended");
  });

  it("strict: with a principal the authorizer decides", async () => {
    const h = build({ strict: true });
    const handle = await h.runtime.start(gateFlow, {}, { principal: alice, executionId: "e1" });
    await handle.waitForSuspend();
    const bob: PrincipalChain = { actor: "bob", tenant: "t2" };
    await expect(h.runtime.cancel("e1", undefined, { principal: bob })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    ); // other tenant
    const done = await h.runtime.resume(
      "e1",
      { eventType: "GO", payload: {} },
      { principal: alice }
    );
    expect((await done.waitForCompletion()).status).toBe("completed");
  });

  it("non-strict: principal-less is unchanged and the authorizer is never consulted for it", async () => {
    const h = build({ strict: false });
    const handle = await h.runtime.start(gateFlow, {}, { executionId: "e1" });
    await handle.waitForSuspend();
    expect(h.seen).toHaveLength(0);
    expect((await h.runtime.loadState("e1"))?.status).toBe("suspended");
    const done = await h.runtime.resume("e1", { eventType: "GO", payload: {} });
    expect((await done.waitForCompletion()).status).toBe("completed");
    expect(h.seen).toHaveLength(0);
    // and no system grant exists to hand out
    expect(h.runtime.systemOptions()).toEqual({});
  });

  it("the system grant bypasses the authorizer, writes nothing extra, and carries no principal", async () => {
    const h = build({ strict: true });
    const handle = await h.runtime.start(gateFlow, {}, { principal: alice, executionId: "e1" });
    await handle.waitForSuspend();
    h.seen.length = 0;
    expect((await h.runtime.loadState("e1", h.runtime.systemOptions()))?.status).toBe("suspended");
    expect(h.seen).toHaveLength(0);
    expect(h.runtime.systemOptions().system).toBeDefined();
  });

  it("app code cannot forge the system grant (clone, crafted principal, wrong shape)", async () => {
    const h = build({ strict: true });
    const handle = await h.runtime.start(gateFlow, {}, { principal: alice, executionId: "e1" });
    await handle.waitForSuspend();
    const real = h.runtime.systemOptions().system as object;
    const forged = [
      { ...real },
      { __loomSystemGrant: true },
      JSON.parse(JSON.stringify(real)),
      Object.freeze({ __loomSystemGrant: true }),
    ];
    for (const system of forged) {
      await expect(h.runtime.loadState("e1", { system } as never)).rejects.toBeInstanceOf(
        ExecutionDeniedError
      );
      await expect(
        h.runtime.start(gateFlow, {}, { system, executionId: "forged" } as never)
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
    }
    // a crafted PRINCIPAL naming the system is just a principal: the policy refuses it.
    await expect(
      h.runtime.cancel("e1", undefined, { principal: { actor: "loom:system" } })
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    // a grant from ANOTHER runtime instance is not this runtime's
    const other = build({ strict: true });
    await expect(h.runtime.loadState("e1", other.runtime.systemOptions())).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
  });

  it("requirePrincipal is inert without an authorizer", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const rt = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      executionAuthz: { requirePrincipal: true },
    });
    rt.registerFlow(gateFlow.definition, gateFlow.runner);
    const h = await rt.start(gateFlow, {}, { executionId: "x" });
    await h.waitForSuspend();
    expect(rt.systemOptions()).toEqual({});
  });

  describe("internal paths still work under strict", () => {
    it("TimerService wakes a sleeping execution", async () => {
      const h = build({ strict: true });
      const handle = await h.runtime.start(sleepyFlow, {}, { principal: alice, executionId: "s1" });
      await handle.waitForSuspend();
      const svc = new TimerService(h.runtime, h.timerStore);
      await svc.tick(Date.now() + 100);
      expect((await h.runtime.loadState("s1", h.runtime.systemOptions()))?.status).toBe(
        "completed"
      );
    });

    it("TimerService starts a scheduled occurrence", async () => {
      const h = build({ strict: true });
      const MINUTE = 60_000;
      const now = 28_333_334 * MINUTE + MINUTE / 2;
      const svc = new TimerService(h.runtime, h.timerStore, {
        schedules: [{ id: "sch", cron: "* * * * *", flowId: "gated", input: {} } as never],
        now: () => now,
      });
      const occurrence = (Math.floor(now / MINUTE) + 1) * MINUTE;
      await svc.tick(occurrence);
      expect(
        (await h.runtime.loadState(`sch@${occurrence}`, h.runtime.systemOptions()))?.status
      ).toBe("suspended");
    });

    it("recoverAbandoned re-drives a crashed execution on a second boot", async () => {
      const shared = stores();
      const gate = new Promise<void>(() => {});
      const a = new EffectRuntime();
      a.register("echo", new ToolEffect(async () => gate.then(() => ({ ok: true }))));
      const rtA = new WorkflowRuntime({
        eventStore: shared.eventStore,
        snapshotStore: shared.snapshotStore,
        effectRuntime: a,
      });
      const flow = makeFlow("crashy", async (ctx) => ctx.run(echo, {}));
      rtA.registerFlow(flow.definition, flow.runner);
      void rtA.start(flow, {}, { executionId: "c1" });
      await new Promise((r) => setTimeout(r, 20));

      const b = build({ strict: true, shared });
      b.runtime.registerFlow(flow.definition, flow.runner);
      const summary = await recoverAbandoned(b.runtime, {
        source: b.eventStore,
        isAbandoned: () => true,
      });
      expect(summary.recovered).toBe(1);
      expect((await b.runtime.loadState("c1", b.runtime.systemOptions()))?.status).toBe(
        "completed"
      );
      // …while an app caller with no principal is still refused on the same runtime
      await expect(b.runtime.loadState("c1")).rejects.toBeInstanceOf(ExecutionDeniedError);
    });
  });
});
