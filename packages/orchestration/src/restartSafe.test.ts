import type { EventEnvelope } from "@loom/core";
import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import {
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  iterateExecutionIds,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  LogLifecycle,
  RedriveExhaustedError,
  type RegisteredFlow,
  ResumeContendedError,
  ResumeRefusedError,
  TimerService,
  WorkflowRuntime,
  executionAccessPolicy,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHILD_FAILED,
  type ChildSupervisor,
  type SupervisorDeps,
  awaitAll,
  awaitChild,
  awaitChildren,
  pinParkedChildren,
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
// re-parks after the resume, so a duplicate resume lands on a LATER park (the window).
const groupRepark = mk("groupRepark", async (ctx) => {
  const first = await awaitAll(ctx, {
    key: "g",
    children: [1, 2, 3].map((n) => ({ flowId: "instant", input: { n } })),
  });
  await awaitChild(ctx, { key: "after", flowId: "gated", input: {} });
  return first;
});
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
// A parent whose SECOND spawn key is non-deterministic (ctx.decide records it, but a losing
// resume that runs the body in memory computes its own).
const orphan = mk("orphan", async (ctx) => {
  await awaitChild(ctx, { key: "k1", flowId: "instant", input: { n: 1 } });
  const k = await ctx.decide("pick", () => `x${Math.random().toString(36).slice(2)}`);
  return awaitChild(ctx, { key: k as string, flowId: "gated", input: {} });
});
const singleInstant = mk("singleInstant", async (ctx) =>
  awaitChild(ctx, { key: "k", flowId: "instant", input: { n: 1 } })
);
// runs a long while after its child answers (the parent reads `running`, not `suspended`).
const slowAfter = mk("slowAfter", async (ctx) => {
  const r = await awaitChild(ctx, { key: "k", flowId: "gated", input: {} });
  await new Promise((res) => setTimeout(res, 3000));
  return r;
});
const flows: Record<string, RegisteredFlow> = {
  singleInstant,
  slowAfter,
  orphan,
  groupRepark,
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
  opts: {
    supervise?: boolean;
    strict?: boolean;
    limits?: { maxDepth?: number };
    /** Hold every CHILD_DONE resume this process issues until it resolves (a slow resume). */
    holdResume?: Promise<void>;
    tuning?: SupervisorDeps["tuning"];
    /** Wrap this process's runtime (fault injection) before the supervisor is built. */
    wrap?: (rt: WorkflowRuntime) => void;
  } = {}
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
  if (opts.holdResume !== undefined) {
    const orig = runtime.resume.bind(runtime);
    const hold = opts.holdResume;
    runtime.resume = async (...args: Parameters<typeof orig>) => {
      if ((args[1] as { eventType?: string }).eventType === "CHILD_DONE") await hold;
      return orig(...args);
    };
  }
  opts.wrap?.(runtime);
  for (const f of Object.values(flows)) {
    runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
  }
  if (opts.supervise !== false) {
    holder.sup = superviseChildren({
      runtime,
      flows,
      onError: (e) => errors.push(e),
      ...(opts.limits !== undefined && { limits: opts.limits }),
      ...(opts.tuning !== undefined && { tuning: opts.tuning }),
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
    await down.runtime.start("groupRepark", {}, { executionId: "G" });
    await until(down.runtime, "G", (s) => s.status === "suspended");
    for (const n of [1, 2, 3]) {
      await down.runtime.start("instant", { n }, { executionId: `G::g#${n - 1}` });
    }
    const s1 = boot(w);
    const s2 = boot(w);
    const [r1, r2] = await Promise.all([s1.sup.recover(), s2.sup.recover()]);
    await until(s1.runtime, "G::after", (s) => s.status === "suspended");
    await new Promise((r) => setTimeout(r, 200)); // a late duplicate resume would land here
    expect(r1.resumed + r2.resumed).toBe(1);
    expect(await resumedCount(w, "G")).toBe(1);
    expect((await s1.runtime.loadState("G", sys(s1.runtime)))?.status).toBe("suspended");
    await s1.runtime.resume("G::after", { eventType: "GO", payload: 0 }, sys(s1.runtime));
    expect((await completed(s1.runtime, "G")).variables._output).toEqual([
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

  // ── review round 1 ──────────────────────────────────────────────────────────────────────
  it("P1-a: a slow resume that passed the key check cannot answer the parent's NEXT park", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("twice", {}, { executionId: "T" });
    await until(down.runtime, "T", (s) => s.status === "suspended"); // parked on k1
    await down.runtime.start("instant", { n: 1 }, { executionId: "T::k1" }); // k1 already settled
    let release!: () => void;
    const b = boot(w, {
      holdResume: new Promise<void>((r) => {
        release = r;
      }),
    });
    const a = boot(w);
    const bDone = b.sup.recover(); // passes the key check on k1, then stalls inside resume()
    await new Promise((r) => setTimeout(r, 100));
    await a.sup.recover(); // the live path: delivers k1, T runs on and re-parks on k2
    await until(a.runtime, "T::k2", (s) => s.status === "suspended");
    release(); // B's stale resume of k1 now lands on a parent parked on k2
    await bDone;
    await new Promise((r) => setTimeout(r, 100));
    expect((await a.runtime.loadState("T", sys(a.runtime)))?.status).toBe("suspended");
    await a.runtime.resume("T::k2", { eventType: "GO", payload: 9 }, sys(a.runtime));
    expect((await completed(a.runtime, "T")).variables._output).toEqual({
      a: { v: 1 },
      b: { v: 9 },
    });
    expect(await resumedCount(w, "T")).toBe(2);
    expect([...a.errors, ...b.errors]).toEqual([]);
  }, 20000);

  it("P1-b: group members that settle on DIFFERENT nodes still resume the parent", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    const b = boot(w);
    await b.sup.recover(); // B adopts: all three running
    await b.runtime.resume("G::g#0", { eventType: "GO", payload: "a" }, sys(b.runtime));
    await a.runtime.resume("G::g#1", { eventType: "GO", payload: "b" }, sys(a.runtime));
    await a.runtime.resume("G::g#2", { eventType: "GO", payload: "c" }, sys(a.runtime));
    const parent = await completed(a.runtime, "G");
    expect(parent.variables._output).toEqual([
      { status: "completed", output: { v: "a" } },
      { status: "completed", output: { v: "b" } },
      { status: "completed", output: { v: "c" } },
    ]);
    expect(await resumedCount(w, "G")).toBe(1);
    expect([...a.errors, ...b.errors]).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    // neither node keeps state for a park that was answered (settled here OR elsewhere)
    expect(a.sup.size()).toEqual({ specs: 0, started: 0, groups: 0, memberOf: 0, reclaimed: 0 });
    expect(b.sup.size()).toEqual({ specs: 0, started: 0, groups: 0, memberOf: 0, reclaimed: 0 });
  }, 20000);

  it("P1-c: a losing resume's in-memory re-run starts NO phantom child", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("orphan", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await down.runtime.start("instant", { n: 1 }, { executionId: "P::k1" });
    const s1 = boot(w);
    const s2 = boot(w);
    await Promise.all([s1.sup.recover(), s2.sup.recover()]);
    await new Promise((r) => setTimeout(r, 1600)); // outlast the durability gate
    const ids: string[] = [];
    for await (const id of iterateExecutionIds(w.events as never)) ids.push(id);
    const kids = ids.filter((id) => id.startsWith("P::") && id !== "P::k1");
    expect(kids.length).toBe(1);
    const parked = await s1.runtime.loadState("P", sys(s1.runtime));
    expect(parked?.suspendedOn?.correlationKey).toBe(kids[0]);
  }, 20000);

  it("P2-a: a fenced parent is still resumed (the supervisor takes its own fence)", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("single", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await down.runtime.start("instant", { n: 5 }, { executionId: "P::k" });
    await down.runtime.acquireFence("P", sys(down.runtime)); // someone fenced P (timer/recovery)
    const up = boot(w);
    const summary = await up.sup.recover();
    expect(up.errors).toEqual([]);
    expect(summary.resumed).toBe(1);
    expect((await completed(up.runtime, "P")).status).toBe("completed");
  }, 20000);

  it("P2-a: a resume whose append fails is REPORTED and not counted as resumed", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("single", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await down.runtime.start("instant", { n: 5 }, { executionId: "P::k" });
    const append = w.events.append.bind(w.events);
    w.events.append = async (e: EventEnvelope) => {
      if (e.executionId === "P" && e.eventType === "EXECUTION_RESUMED")
        throw new Error("disk full");
      return append(e);
    };
    const up = boot(w);
    const summary = await up.sup.recover();
    expect(summary.resumed).toBe(0);
    expect(up.errors.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("P2-b: a member reclaimed by retention is settled as failed, never re-run", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    await a.runtime.resume("G::g#0", { eventType: "GO", payload: "a" }, sys(a.runtime));
    await until(a.runtime, "G::g#0", (s) => s.status === "completed");
    // retention reclaims member 0: the fact is journalled, then the values go.
    const prior = await w.events.read("__loom_lifecycle__");
    await w.events.append({
      id: "del-1",
      workflowId: "__loom_lifecycle__",
      executionId: "__loom_lifecycle__",
      eventType: "EXECUTION_DELETED",
      sequence: prior.length,
      timestamp: Date.now(),
      payload: { executionId: "G::g#0" },
    } as EventEnvelope);
    await w.events.deleteExecution("G::g#0");
    await w.snaps.deleteExecution("G::g#0");
    const b = boot(w); // restart
    await b.runtime.resume("G::g#1", { eventType: "GO", payload: "b" }, sys(b.runtime));
    await b.runtime.resume("G::g#2", { eventType: "GO", payload: "c" }, sys(b.runtime));
    const parent = await completed(b.runtime, "G");
    expect(await w.events.read("G::g#0")).toEqual([]); // NOT started again
    const out = parent.variables._output as { status: string; error?: string }[];
    expect(out[0]?.status).toBe("failed");
    expect(out[0]?.error).toMatch(/reclaimed by retention/);
    expect(out[1]).toEqual({ status: "completed", output: { v: "b" } });
  }, 20000);

  it("P3: the supervisor's maps do not grow across many cycles", async () => {
    const w = world();
    const a = boot(w);
    for (let i = 0; i < 12; i++) {
      await a.runtime.start("groupRepark", {}, { executionId: `G${i}` });
      await until(a.runtime, `G${i}::after`, (s) => s.status === "suspended");
      await a.runtime.resume(`G${i}::after`, { eventType: "GO", payload: 0 }, sys(a.runtime));
      await completed(a.runtime, `G${i}`);
    }
    for (let i = 0; i < 6; i++) {
      await a.runtime.start("single", {}, { executionId: `S${i}` });
      await until(a.runtime, `S${i}::k`, (s) => s.status === "suspended");
      await a.runtime.resume(`S${i}::k`, { eventType: "GO", payload: i }, sys(a.runtime));
      await completed(a.runtime, `S${i}`);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(a.sup.size()).toEqual({ specs: 0, started: 0, groups: 0, memberOf: 0, reclaimed: 0 });
  }, 30000);

  // ── review round 2 ──────────────────────────────────────────────────────────────────────
  const slowAppend = (w: World, gate: Promise<void>, id = "P") => {
    const append = w.events.append.bind(w.events);
    w.events.append = async (e: EventEnvelope) => {
      if (e.executionId === id && e.eventType === "EXECUTION_SUSPENDED") await gate;
      return append(e);
    };
  };
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("P2-1: a slow store (park durable only after 1.5s) is NOT abandoned — the child still starts, no recover()", async () => {
    const w = world();
    slowAppend(w, delay(1500));
    const a = boot(w, { tuning: { retryBaseMs: 100 } });
    await a.runtime.start("singleInstant", {}, { executionId: "P" });
    const parent = await until(a.runtime, "P", (s) => s.status === "completed");
    expect(parent.variables._output).toEqual({ v: 1 });
    expect(a.errors).toEqual([]);
    expect(a.sup.size().started).toBe(0);
  }, 20000);

  it("P2-1: a park that never becomes readable is REPORTED through onError after the give-up window", async () => {
    const w = world();
    let release!: () => void;
    slowAppend(
      w,
      new Promise<void>((r) => {
        release = r;
      })
    );
    const a = boot(w, {
      tuning: { retryBaseMs: 50, retryMaxMs: 100, giveUpMs: 600, durableWaitMs: 200 },
    });
    await a.runtime.start("singleInstant", {}, { executionId: "P" });
    await delay(1500);
    expect(a.errors.length).toBe(1);
    expect(String(a.errors[0])).toMatch(/gave up supervising/);
    release();
    await delay(100);
  }, 20000);

  it("P2-2 (R8k): a rival that fences right behind each of our acquires is bounded to THREE conditional acquisitions, then reported", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("single", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await down.runtime.start("instant", { n: 5 }, { executionId: "P::k" });
    await down.runtime.acquireFence("P", sys(down.runtime)); // fenced once already
    let acquisitions = 0;
    const orig = w.events.acquireFenceIf.bind(w.events);
    w.events.acquireFenceIf = async (id, expect) => {
      const got = await orig(id, expect);
      if (!("stale" in got)) {
        acquisitions++;
        await w.events.acquireFence(id); // a rival supervisor fences right behind us
      }
      return got;
    };
    const up = boot(w);
    await up.sup.recover();
    expect(acquisitions).toBe(3);
    expect(up.errors.length).toBeGreaterThanOrEqual(1);
    expect(await resumedCount(w, "P")).toBe(0); // every append lost to the rival's fence: nothing recorded
  }, 20000);

  it("P2-2: a live resume refused not-suspended while the DURABLE log shows the park answered is quiet", async () => {
    const w = world();
    const a = boot(w, {
      wrap: (rt) => {
        const orig = rt.resume.bind(rt);
        let first = true;
        rt.resume = async (...args: Parameters<typeof orig>) => {
          if ((args[1] as { eventType?: string }).eventType !== "CHILD_DONE" || !first)
            return orig(...args);
          first = false;
          const h = await orig(...args); // another supervisor's answer, in effect
          await until(rt, "P", (s) => s.status !== "suspended");
          void h.waitForCompletion().catch(() => undefined);
          throw new ResumeRefusedError("P", "CHILD_DONE", "not-suspended", "raced");
        };
      },
    });
    await a.runtime.start("slowAfter", {}, { executionId: "P" });
    await until(a.runtime, "P::k", (s) => s.status === "suspended");
    const t0 = Date.now();
    await a.runtime.resume("P::k", { eventType: "GO", payload: 1 }, sys(a.runtime));
    await until(a.runtime, "P::k", (s) => s.status === "completed");
    await delay(1600); // the old path retried ~1.1s and then reported
    expect(a.errors).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThan(1500);
  }, 20000);

  it("P3-1: B adopts a running child, it completes and the parent resumes on A: B's maps drain (single)", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("single", {}, { executionId: "P" });
    await until(a.runtime, "P::k", (s) => s.status === "suspended");
    const b = boot(w, { tuning: { sweepMs: 50 } });
    await b.sup.recover();
    expect(b.sup.size().started).toBe(1);
    await a.runtime.resume("P::k", { eventType: "GO", payload: 3 }, sys(a.runtime));
    expect((await completed(a.runtime, "P")).variables._output).toEqual({ v: 3 });
    await delay(400);
    expect(b.sup.size()).toEqual({ specs: 0, started: 0, groups: 0, memberOf: 0, reclaimed: 0 });
    expect(b.errors).toEqual([]);
  }, 20000);

  it("P3-1: ... and for a group (started/groups/memberOf), via the sweep and via recover()", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    const b = boot(w, { tuning: { sweepMs: 10_000 } }); // sweep too slow to matter: recover() does it
    await b.sup.recover();
    expect(b.sup.size()).toMatchObject({ started: 4, groups: 1, memberOf: 3 });
    for (const i of [0, 1, 2]) {
      await a.runtime.resume(`G::g#${i}`, { eventType: "GO", payload: i }, sys(a.runtime));
    }
    await completed(a.runtime, "G");
    await b.sup.recover();
    expect(b.sup.size()).toEqual({ specs: 0, started: 0, groups: 0, memberOf: 0, reclaimed: 0 });
  }, 20000);

  const reclaim = async (w: World, id: string, at: number, seq: number) =>
    w.events.append({
      id: `del-${seq}`,
      workflowId: "__loom_lifecycle__",
      executionId: "__loom_lifecycle__",
      eventType: "EXECUTION_DELETED",
      sequence: seq,
      timestamp: at,
      payload: { executionId: id },
    } as EventEnvelope);

  it("P3-2: a REUSED parent id is not failed by the previous incarnation's deletion fact", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    // retention deletes the whole old tree, journalling the facts first
    const old = Date.now();
    let seq = 0;
    for (const id of ["G", "G::g#0", "G::g#1", "G::g#2"]) await reclaim(w, id, old, seq++);
    for (const id of ["G", "G::g#0", "G::g#1", "G::g#2"]) {
      await w.events.deleteExecution(id);
      await w.snaps.deleteExecution(id);
    }
    await delay(20);
    const down = boot(w, { supervise: false });
    await down.runtime.start("group", {}, { executionId: "G" }); // the id is reused
    await until(down.runtime, "G", (s) => s.status === "suspended");
    const b = boot(w);
    await b.sup.recover();
    for (const i of [0, 1, 2]) await until(b.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    expect((await b.runtime.loadState("G", sys(b.runtime)))?.status).toBe("suspended");
    expect(b.errors).toEqual([]);
  }, 20000);

  it("P3-2: the reclaimed-facts cache is bounded, counted in size(), and an eviction never un-reclaims", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    await a.runtime.resume("G::g#0", { eventType: "GO", payload: "a" }, sys(a.runtime));
    await until(a.runtime, "G::g#0", (s) => s.status === "completed");
    const at = Date.now();
    await reclaim(w, "G::g#0", at, 0);
    for (let i = 1; i <= 6; i++) await reclaim(w, `other${i}`, at, i);
    await w.events.deleteExecution("G::g#0");
    await w.snaps.deleteExecution("G::g#0");
    const b = boot(w, { tuning: { maxReclaimed: 2 } });
    await b.runtime.resume("G::g#1", { eventType: "GO", payload: "b" }, sys(b.runtime));
    await b.runtime.resume("G::g#2", { eventType: "GO", payload: "c" }, sys(b.runtime));
    const parent = await completed(b.runtime, "G");
    expect(await w.events.read("G::g#0")).toEqual([]);
    expect((parent.variables._output as { status: string }[])[0]?.status).toBe("failed");
    expect(b.sup.size().reclaimed).toBeLessThanOrEqual(2);
  }, 20000);

  it("minor: a resume whose outcome cannot be observed (hung store) is UNKNOWN: not counted, not reported", async () => {
    const w = world();
    const down = boot(w, { supervise: false });
    await down.runtime.start("slowAfter", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await down.runtime.start("gated", {}, { executionId: "P::k" });
    await down.runtime.resume("P::k", { eventType: "GO", payload: 1 }, sys(down.runtime));
    await until(down.runtime, "P::k", (s) => s.status === "completed");
    let hang = false;
    const up = boot(w, {
      tuning: { observeMs: 300, loadTimeoutMs: 100 },
      wrap: (rt) => {
        const resume = rt.resume.bind(rt);
        rt.resume = async (...args: Parameters<typeof resume>) => {
          const h = await resume(...args);
          if ((args[1] as { eventType?: string }).eventType === "CHILD_DONE") hang = true;
          return h;
        };
        const load = rt.loadState.bind(rt);
        rt.loadState = ((id: string, ...rest: unknown[]) =>
          hang && id === "P"
            ? new Promise(() => undefined)
            : (load as (...a: unknown[]) => unknown)(id, ...rest)) as typeof rt.loadState;
      },
    });
    const t0 = Date.now();
    const summary = await up.sup.recover();
    expect(Date.now() - t0).toBeLessThan(2000); // the parent keeps running for 3s
    expect(summary.resumed).toBe(0);
    expect(up.errors).toEqual([]);
    hang = false;
  }, 20000);
});

// ── R8k (ADR 0118) — the conditional fence, the live re-driver and the retention pin ──────────

/** Make every `acquireFenceIf` on `w.events` first bump the token (a dead acquirer), `times` times. */
function deadAcquirers(w: World, times: number): { stop(): void; calls(): number } {
  let calls = 0;
  const orig = w.events.acquireFenceIf.bind(w.events);
  w.events.acquireFenceIf = async (id, expect) => {
    if (calls < times) {
      calls++;
      await w.events.acquireFence(id); // acquire, never append
    }
    return orig(id, expect);
  };
  return {
    stop: () => {
      calls = Number.MAX_SAFE_INTEGER;
    },
    calls: () => calls,
  };
}

async function fencedParkedParent(w: World) {
  const down = boot(w, { supervise: false });
  await down.runtime.start("single", {}, { executionId: "P" });
  await until(down.runtime, "P", (s) => s.status === "suspended");
  await down.runtime.start("instant", { n: 5 }, { executionId: "P::k" });
  await down.runtime.acquireFence("P", sys(down.runtime)); // fenced: the unfenced first try is stale
  return down;
}

function redriveWorld(w: World, opts: { max?: number } = {}) {
  const timers = new InMemoryTimerStore();
  const serviceErrors: unknown[] = [];
  const holder: { sup?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: w.events,
    snapshotStore: w.snaps,
    effectRuntime: new EffectRuntime(),
    timerStore: timers,
    onEvent: (e) => holder.sup?.onEvent(e),
  });
  for (const f of Object.values(flows)) {
    runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
  }
  const service = new TimerService(runtime, timers, {
    ...(opts.max !== undefined && { maxRedriveAttempts: opts.max }),
    redriveBackoff: { random: () => 0.5 },
    onError: (_id, e) => serviceErrors.push(e),
  });
  const errors: unknown[] = [];
  holder.sup = superviseChildren({
    runtime,
    flows,
    onError: (e) => errors.push(e),
    redrive: { timers, service, backoff: { random: () => 0.5 } },
  });
  return { runtime, timers, service, errors, serviceErrors, sup: holder.sup };
}

describe("R8k — conditional fence in the supervisor's resume", () => {
  it("two supervisors racing one fenced parked parent: exactly one resume, the parent completes, nothing reported", async () => {
    const w = world();
    await fencedParkedParent(w);
    const a = boot(w);
    const b = boot(w);
    await Promise.all([a.sup.recover(), b.sup.recover()]);
    expect((await completed(a.runtime, "P")).status).toBe("completed");
    expect(await resumedCount(w, "P")).toBe(1);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 20000);

  it("a dead acquirer (acquire, never append) does not strand the parent: the conditional retry wins", async () => {
    const w = world();
    await fencedParkedParent(w);
    const dead = deadAcquirers(w, 1);
    const up = boot(w);
    await up.sup.recover();
    expect(dead.calls()).toBe(1);
    expect((await completed(up.runtime, "P")).status).toBe("completed");
    expect(up.errors).toEqual([]);
  }, 20000);
});

describe("R8k — the live re-driver (kernel.features.redrive)", () => {
  it("a contended resume leaves a backed-off row; the TimerService completes the parent with NO recover() call", async () => {
    const w = world();
    await fencedParkedParent(w);
    const dead = deadAcquirers(w, 3); // the runtime's three attempts all lose, then it clears
    const up = redriveWorld(w);
    // The first resume is driven by recover() here only to START the scenario; completion below is not.
    await up.sup.recover();
    const rows = await up.timers.due(Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionId: "P", redrive: { attempt: 0 } });
    expect(up.errors).toEqual([]); // contended is NOT an error: it is scheduled
    expect((await up.runtime.loadState("P", sys(up.runtime)))?.status).toBe("suspended");
    expect(dead.calls()).toBe(3);
    // No recover(): only the service's poll.
    await up.service.tick(Date.now() + 10_000_000);
    expect((await completed(up.runtime, "P")).status).toBe("completed");
    expect(await up.timers.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await resumedCount(w, "P")).toBe(1);
    expect(up.errors).toEqual([]);
    expect(up.serviceErrors).toEqual([]);
  }, 20000);

  it("exhaustion: onError ONCE (the service's), the parent still parked and left to recover(), which then completes it", async () => {
    const w = world();
    await fencedParkedParent(w);
    const dead = deadAcquirers(w, Number.MAX_SAFE_INTEGER);
    const up = redriveWorld(w, { max: 3 });
    await up.sup.recover();
    for (let i = 1; i <= 8; i++) await up.service.tick(Date.now() + i * 10_000_000);
    expect(up.serviceErrors).toHaveLength(1);
    expect(up.serviceErrors[0]).toBeInstanceOf(RedriveExhaustedError);
    expect(up.errors).toEqual([]);
    expect(await up.timers.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect((await up.runtime.loadState("P", sys(up.runtime)))?.status).toBe("suspended");
    dead.stop();
    await up.sup.recover();
    expect((await completed(up.runtime, "P")).status).toBe("completed");
  }, 30000);

  it("flag OFF (no redrive wiring): the contended resume is reported through onError, no row exists, recover() completes it", async () => {
    const w = world();
    await fencedParkedParent(w);
    const dead = deadAcquirers(w, 3);
    const up = boot(w);
    await up.sup.recover();
    expect(up.errors).toHaveLength(1);
    expect(up.errors[0]).toBeInstanceOf(ResumeContendedError);
    expect((await up.runtime.loadState("P", sys(up.runtime)))?.status).toBe("suspended");
    dead.stop();
    await up.sup.recover();
    expect((await completed(up.runtime, "P")).status).toBe("completed");
  }, 20000);
});

describe("R8k D3 — pinParkedChildren", () => {
  async function finishedChildOfParkedParent(w: World) {
    const a = boot(w);
    await a.runtime.start("single", {}, { executionId: "P" });
    await until(a.runtime, "P::k", (s) => s.status === "suspended");
    // The parent is parked on the child; the child finishes but its supervisor resume is held back.
    return a;
  }

  it("a finished child whose parent is parked on it is pinned; archivable again once the parent is answered", async () => {
    const w = world();
    // hold the supervisor's resume so the parent stays parked while the child is already terminal
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const a = boot(w, { holdResume: hold });
    await a.runtime.start("single", {}, { executionId: "P" });
    await until(a.runtime, "P::k", (s) => s.status === "suspended");
    await a.runtime.resume("P::k", { eventType: "GO", payload: 1 }, sys(a.runtime));
    await until(a.runtime, "P::k", (s) => s.status === "completed");

    const pin = pinParkedChildren(a.sup);
    expect(await pin("P::k")).toBe(true); // the parent is parked on it
    expect(await pin("P")).toBe(false); // a root is nobody's child
    expect(await pin("no-such")).toBe(false);

    const lifecycle = new LogLifecycle(w.events, w.snaps, { pinned: pin });
    expect(await lifecycle.evaluate("P::k", { terminalTtlMs: 0 }, Date.now() + 10)).toBe("pinned");

    release(); // the parent is answered
    await completed(a.runtime, "P");
    expect(await pin("P::k")).toBe(false);
    expect(await lifecycle.evaluate("P::k", { terminalTtlMs: 0 }, Date.now() + 10)).toBe(
      "reclaimable"
    );
  }, 20000);

  it("works after a restart (a fresh supervisor reads the child's RECORDED parent) and for group members", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("group", {}, { executionId: "G" });
    for (const i of [0, 1, 2]) await until(a.runtime, `G::g#${i}`, (s) => s.status === "suspended");
    const b = boot(w); // a fresh supervisor knows nothing in memory
    expect(await pinParkedChildren(b.sup)("G::g#1")).toBe(true);
    expect(await pinParkedChildren(() => b.sup)("G::g#1")).toBe(true);
    expect(await pinParkedChildren(() => undefined)("G::g#1")).toBe(false);
  }, 20000);

  it("a crypto-shredded (unreadable) log is NOT pinned; any OTHER read failure rethrows so retention fails visibly (P2-3)", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("single", {}, { executionId: "P" });
    await until(a.runtime, "P::k", (s) => s.status === "suspended");
    const failing = (make: () => Error): World => {
      const events = Object.create(w.events) as InMemoryAsyncEventStore;
      events.readRange = async () => {
        throw make();
      };
      events.readFrom = async () => {
        throw make();
      };
      return { events, snaps: w.snaps };
    };
    const shredded = (): Error => {
      const e = new Error("payload was crypto-shredded");
      e.name = "PayloadShreddedError";
      return e;
    };
    const wrapped = (): Error =>
      Object.assign(new Error("Durable event write failed"), {
        name: "StorageWriteError",
        cause: shredded(),
      });
    expect(await pinParkedChildren(boot(failing(shredded)).sup)("P::k")).toBe(false);
    expect(await pinParkedChildren(boot(failing(wrapped)).sup)("P::k")).toBe(false);
    const down = failing(() => new Error("connection reset"));
    await expect(pinParkedChildren(boot(down).sup)("P::k")).rejects.toThrow("connection reset");
  }, 20000);

  it("a child the parent is parked on under a DIFFERENT key is not pinned", async () => {
    const w = world();
    const a = boot(w);
    await a.runtime.start("twice", {}, { executionId: "T" });
    await until(a.runtime, "T::k2", (s) => s.status === "suspended"); // k1 finished; parked on k2
    expect(await pinParkedChildren(a.sup)("T::k1")).toBe(false);
    expect(await pinParkedChildren(a.sup)("T::k2")).toBe(true);
  }, 20000);
});
