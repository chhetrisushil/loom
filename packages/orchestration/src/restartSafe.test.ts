import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
  executionAccessPolicy,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHILD_FAILED,
  type ChildSupervisor,
  awaitAll,
  awaitChild,
  awaitChildren,
  superviseChildren,
} from "./orchestration";

// R8 — the supervisor's state is DERIVABLE FROM THE LOG: a fresh runtime + a fresh supervisor
// over the SAME stores (a process restart) resumes the parents that were parked on children.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const mk = (id: string, runner: FlowRunner<never, unknown>): RegisteredFlow =>
  ({
    definition: { _tag: "FlowDefinition", id, name: id, version: "1.0.0", ...io, steps: [] },
    runner,
  }) as unknown as RegisteredFlow;

// A child that parks until told to go ("it is still running when the process dies").
const gated = mk("gated", async (ctx) => ({ v: await ctx.suspend({ on: "GO" }) }));
const instant = mk("instant", async (_ctx, input: { n: number }) => ({ v: input.n }));
const boom = mk("boom", async () => {
  throw new Error("kaboom");
});
const single = mk("single", async (ctx) =>
  awaitChild(ctx, { key: "k", flowId: "gated", input: {} })
);
const group = mk("group", async (ctx) =>
  awaitChildren(ctx, {
    key: "g",
    children: [0, 1, 2].map((n) => ({ flowId: "gated", input: { n } })),
  })
);
const groupInstant = mk("groupInstant", async (ctx) =>
  awaitAll(ctx, {
    key: "g",
    children: [1, 2, 3].map((n) => ({ flowId: "instant", input: { n } })),
  })
);
const caught = mk("caught", async (ctx) => {
  try {
    await awaitChild(ctx, { key: "c", flowId: "boom", input: {} });
    return { caught: false };
  } catch (err) {
    if (err instanceof TypedFailure && err.channel === CHILD_FAILED) {
      return { caught: true, payload: err.payload };
    }
    throw err;
  }
});
const twice = mk("twice", async (ctx) => {
  const a = await awaitChild<{ v: unknown }>(ctx, {
    key: "k1",
    flowId: "instant",
    input: { n: 1 },
  });
  const b = await awaitChild<{ v: unknown }>(ctx, { key: "k2", flowId: "gated", input: {} });
  return { a, b };
});
const flows: Record<string, RegisteredFlow> = {
  gated,
  instant,
  boom,
  single,
  group,
  groupInstant,
  caught,
  twice,
};

function world() {
  return { events: new InMemoryAsyncEventStore(), snaps: new InMemoryAsyncSnapshotStore() };
}
type World = ReturnType<typeof world>;

/** One "process": a fresh runtime + (optionally) a fresh supervisor over the shared stores. */
function boot(
  w: World,
  opts: { supervise?: boolean; strict?: boolean; limits?: { maxDepth?: number } } = {}
) {
  const errors: unknown[] = [];
  const holder: { sup?: ChildSupervisor } = {};
  const policy = opts.strict === true ? executionAccessPolicy() : undefined;
  const runtime = new WorkflowRuntime({
    eventStore: w.events,
    snapshotStore: w.snaps,
    effectRuntime: new EffectRuntime(),
    ...(policy !== undefined && {
      executionAuthorizer: policy,
      executionAuthz: { requirePrincipal: true },
    }),
    onEvent: (e) => holder.sup?.onEvent(e),
  });
  for (const f of Object.values(flows)) {
    runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
  }
  if (opts.supervise !== false) {
    holder.sup = superviseChildren({
      runtime,
      flows,
      onError: (e) => errors.push(e),
      ...(opts.limits !== undefined && { limits: opts.limits }),
    });
  }
  return { runtime, sup: holder.sup as ChildSupervisor, errors };
}

const sys = (rt: WorkflowRuntime) => rt.systemOptions();
async function until<T>(
  rt: WorkflowRuntime,
  id: string,
  pred: (s: NonNullable<Awaited<ReturnType<WorkflowRuntime["loadState"]>>>) => boolean
) {
  for (let i = 0; i < 600; i++) {
    const s = await rt.loadState(id, sys(rt));
    if (s !== null && pred(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout on ${id}`);
}
const completed = (rt: WorkflowRuntime, id: string) =>
  until(rt, id, (s) => s.status === "completed" || s.status === "failed");
const resumedCount = async (w: World, id: string) =>
  (await w.events.read(id)).filter((e: EventEnvelope) => e.eventType === "EXECUTION_RESUMED")
    .length;

describe("R8 — restart-safe superviseChildren", () => {
  it("a child that completes AFTER a restart still resumes its parent with the child's result", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("single", {}, { executionId: "P" });
    await until(a.runtime, "P::k", (s) => s.status === "suspended"); // child started, parked
    // ── process dies; a fresh one comes up over the same stores ──
    const b = boot(w);
    await b.runtime.resume("P::k", { eventType: "GO", payload: 7 }, sys(b.runtime));
    const parent = await completed(b.runtime, "P");
    expect(parent.status).toBe("completed");
    expect(parent.variables._output).toEqual({ v: 7 });
    expect(b.errors).toEqual([]);
  }, 20000);

  it("a group with 2 of 3 settled before the crash and the 3rd after delivers ALL three", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    await a.runtime.resume("G::g#0", { eventType: "GO", payload: "a" }, sys(a.runtime));
    await a.runtime.resume("G::g#2", { eventType: "GO", payload: "c" }, sys(a.runtime));
    await until(a.runtime, "G::g#0", (s) => s.status === "completed");
    await until(a.runtime, "G::g#2", (s) => s.status === "completed");
    expect((await a.runtime.loadState("G", sys(a.runtime)))?.status).toBe("suspended");
    // ── restart: the 2 settled results lived only in A's memory ──
    const b = boot(w);
    await b.runtime.resume("G::g#1", { eventType: "GO", payload: "b" }, sys(b.runtime));
    const parent = await completed(b.runtime, "G");
    expect(parent.status).toBe("completed");
    expect(parent.variables._output).toEqual([
      { status: "completed", output: { v: "a" } },
      { status: "completed", output: { v: "b" } },
      { status: "completed", output: { v: "c" } },
    ]);
    expect(await resumedCount(w, "G")).toBe(1);
    expect(b.errors).toEqual([]);
  }, 20000);

  it("everything settled while NO supervisor ran: recover() on boot resumes the parent (catch-up)", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("groupInstant", {}, { executionId: "G" });
    await until(down.runtime, "G", (s) => s.status === "suspended");
    for (const n of [1, 2, 3]) {
      await down.runtime.start("instant", { n }, { executionId: `G::g#${n - 1}` });
    }
    // nobody resumed G: the supervisor was down for all of it.
    expect((await down.runtime.loadState("G", sys(down.runtime)))?.status).toBe("suspended");

    const up = boot(w);
    const summary = await up.sup.recover();
    expect(summary.resumed).toBe(1);
    const parent = await completed(up.runtime, "G");
    expect(parent.variables._output).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
    expect(up.errors).toEqual([]);
  }, 20000);

  it("recover() also starts children that were never started (crash between park and start)", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("single", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    expect(await w.events.read("P::k")).toEqual([]);
    const up = boot(w);
    const summary = await up.sup.recover();
    expect(summary.started).toBe(1);
    await until(up.runtime, "P::k", (s) => s.status === "suspended");
    await up.runtime.resume("P::k", { eventType: "GO", payload: 1 }, sys(up.runtime));
    expect((await completed(up.runtime, "P")).variables._output).toEqual({ v: 1 });
  }, 20000);

  it("a failed child's typed childFailed survives the restart", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("caught", {}, { executionId: "C" });
    await until(down.runtime, "C", (s) => s.status === "suspended");
    await down.runtime.start("boom", {}, { executionId: "C::c" });
    const up = boot(w);
    await up.sup.recover();
    const parent = await completed(up.runtime, "C");
    expect(parent.status).toBe("completed");
    expect(parent.variables._output).toMatchObject({
      caught: true,
      payload: { childId: "C::c", status: "failed" },
    });
  }, 20000);

  it("two supervisors racing over the same store resume the parent exactly once, quietly", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("groupInstant", {}, { executionId: "G" });
    await until(down.runtime, "G", (s) => s.status === "suspended");
    for (const n of [1, 2, 3]) {
      await down.runtime.start("instant", { n }, { executionId: `G::g#${n - 1}` });
    }
    const s1 = boot(w);
    const s2 = boot(w);
    const [r1, r2] = await Promise.all([s1.sup.recover(), s2.sup.recover()]);
    await completed(s1.runtime, "G");
    expect(r1.resumed + r2.resumed).toBeGreaterThanOrEqual(1);
    expect(await resumedCount(w, "G")).toBe(1);
    expect((await s1.runtime.loadState("G", sys(s1.runtime)))?.variables._output).toEqual([
      { v: 1 },
      { v: 2 },
      { v: 3 },
    ]);
    expect([...s1.errors, ...s2.errors]).toEqual([]);
  }, 20000);

  it("a stale child completion never resumes a parent that has moved on to a LATER park", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("twice", {}, { executionId: "T" });
    await until(a.runtime, "T::k2", (s) => s.status === "suspended"); // T is now parked on k2
    expect(await resumedCount(w, "T")).toBe(1); // k1's resume
    const b = boot(w);
    // A straggler: k1's terminal event reaches a supervisor that knows nothing about T.
    const stale = (await w.events.read("T::k1")).find(
      (e: EventEnvelope) => e.eventType === "EXECUTION_COMPLETED"
    ) as EventEnvelope;
    b.sup.onEvent(stale);
    await new Promise((r) => setTimeout(r, 150));
    expect(await resumedCount(w, "T")).toBe(1); // NOT resumed with k1's payload
    expect((await b.runtime.loadState("T", sys(b.runtime)))?.status).toBe("suspended");
    // and a re-run of recover() over the same state is a no-op too
    await b.sup.recover();
    expect(await resumedCount(w, "T")).toBe(1);
    expect(b.errors).toEqual([]);
  }, 20000);

  it("recover() works under a fail-closed execution authorizer (system grant, not an anonymous caller)", async () => {
    const w = world();
    const down = boot(w, { supervise: false, strict: true });
    await down.runtime.start(
      "single",
      {},
      { executionId: "P", principal: { actor: "alice", tenant: "t" } }
    );
    await until(down.runtime, "P", (s) => s.status === "suspended");
    const up = boot(w, { strict: true });
    const summary = await up.sup.recover();
    expect(up.errors).toEqual([]);
    expect(summary.started).toBe(1);
    expect((await up.runtime.loadState("P::k", sys(up.runtime)))?.workflowId).toBe("gated");
  }, 20000);

  it("recover() enforces the spawn envelope: an over-deep unstarted child is refused, parent resumed failed", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("caught", {}, { executionId: "C" });
    await until(down.runtime, "C", (s) => s.status === "suspended");
    const up = boot(w, { limits: { maxDepth: 0 } });
    await up.sup.recover();
    const parent = await completed(up.runtime, "C");
    expect(await w.events.read("C::c")).toEqual([]);
    expect(parent.variables._output).toMatchObject({ caught: true });
    expect(up.errors.length).toBe(1);
  }, 20000);
});
