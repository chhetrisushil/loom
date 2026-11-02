import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import {
  InMemoryAsyncEventStore,
  brandPayloadShredded,
  isPayloadShredded,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  LogLifecycle,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { awaitChild, awaitedByParent, superviseChildren } from "./index";
import type { ChildSupervisor } from "./orchestration";

// ADR 0145 amendment — retention must not reclaim an orchestration child while its parent is
// still alive (prevention, replacing the supervisor's rescan of the lifecycle stream).

const io = { inputSchema: z.any(), outputSchema: z.any() };
const mk = (id: string, runner: FlowRunner<never, unknown>): RegisteredFlow =>
  ({
    definition: { _tag: "FlowDefinition", id, name: id, version: "1.0.0", ...io, steps: [] },
    runner,
  }) as unknown as RegisteredFlow;
const instant = mk("instant", async (_ctx, input: { n: number }) => ({ v: input.n }));
const single = mk("single", async (ctx) =>
  awaitChild(ctx, { key: "k", flowId: "instant", input: { n: 1 } })
);
const flows: Record<string, RegisteredFlow> = { instant, single };

const ev = (
  executionId: string,
  sequence: number,
  eventType: string,
  metadata?: Record<string, unknown>
): EventEnvelope =>
  ({
    id: `${executionId}-${sequence}`,
    workflowId: executionId,
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload: {},
    ...(metadata !== undefined && { metadata }),
  }) as unknown as EventEnvelope;

async function seed(store: InMemoryAsyncEventStore, id: string, kinds: string[], meta?: number) {
  for (let i = 0; i < kinds.length; i++) {
    await store.append(ev(id, i, kinds[i] as string, i === meta ? { kernel: true } : undefined));
  }
}

describe("awaitedByParent — the decision", () => {
  it("a root is never pinned and costs no read", async () => {
    const store = new InMemoryAsyncEventStore();
    const reads: string[] = [];
    const spy = new Proxy(store, {
      get: (t, p, r) => {
        if (typeof p === "string") reads.push(p);
        return Reflect.get(t, p, r);
      },
    });
    expect(await awaitedByParent(spy)("ROOT")).toBe(false);
    expect(reads.filter((p) => p !== "then")).toEqual([]);
  });

  it("a live parent (suspended, with non-terminal events appended after the park) pins its child", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "P", [
      "EXECUTION_STARTED",
      "EXECUTION_SUSPENDED",
      "AUDIT_NOTE",
      "AUDIT_NOTE",
    ]);
    expect(await awaitedByParent(store)("P::k")).toBe(true);
  });

  it.each(["EXECUTION_COMPLETED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"])(
    "a parent that reached %s no longer pins",
    async (terminal) => {
      const store = new InMemoryAsyncEventStore();
      await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", terminal, "AUDIT_NOTE"]);
      expect(await awaitedByParent(store)("P::k")).toBe(false);
    }
  );

  it("a CONTINUED parent (ADR 0109, kernel marker) no longer pins: its generation is finished", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "EXECUTION_CONTINUED"], 2);
    expect(await awaitedByParent(store)("P::k")).toBe(false);
    // An app event that merely carries the name, without the kernel marker, is not a continuation.
    const other = new InMemoryAsyncEventStore();
    await seed(other, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "EXECUTION_CONTINUED"]);
    expect(await awaitedByParent(other)("P::k")).toBe(true);
  });

  it("a parent with no events (gone or never existed) pins nothing", async () => {
    expect(await awaitedByParent(new InMemoryAsyncEventStore())("P::k")).toBe(false);
  });

  it("a nested child is judged by its IMMEDIATE parent only", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
    await seed(store, "P::a", ["EXECUTION_STARTED", "EXECUTION_COMPLETED"]);
    expect(await awaitedByParent(store)("P::a::b")).toBe(false); // P::a is done
    expect(await awaitedByParent(store)("P::a")).toBe(true); // P is alive
  });

  it("FAILS SAFE: a read that throws pins; a crypto-shredded parent does not", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
    const failing = (make: () => Error) =>
      new Proxy(store, {
        get: (t, p, r) =>
          p === "readRange"
            ? async () => {
                throw make();
              }
            : Reflect.get(t, p, r),
      });
    expect(await awaitedByParent(failing(() => new Error("backend down")))("P::k")).toBe(true);
    const shredded = (): Error => {
      const e = new Error("shredded");
      brandPayloadShredded(e);
      expect(isPayloadShredded(e)).toBe(true);
      return e;
    };
    expect(await awaitedByParent(failing(shredded))("P::k")).toBe(false);
  });

  it("a compacted parent whose terminal event left the log is decided from its checkpoint; stale or absent checkpoint stays pinned", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "AUDIT_NOTE"]);
    const snap = (sequence: number, status: string) => ({
      loadLatest: async () => ({ sequence, state: { status } }),
    });
    expect(await awaitedByParent(store, { snapshots: snap(2, "completed") })("P::k")).toBe(false);
    expect(await awaitedByParent(store, { snapshots: snap(2, "suspended") })("P::k")).toBe(true);
    expect(await awaitedByParent(store, { snapshots: snap(1, "completed") })("P::k")).toBe(true);
    expect(
      await awaitedByParent(store, { snapshots: { loadLatest: async () => null } })("P::k")
    ).toBe(true);
  });

  it("does O(1) reads per candidate however long the parent's log is", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "P", [
      "EXECUTION_STARTED",
      ...Array.from({ length: 300 }, () => "AUDIT_NOTE"),
    ]);
    const calls: Record<string, number> = {};
    const counted = new Proxy(store, {
      get: (t, p, r) => {
        const v = Reflect.get(t, p, r);
        if (typeof p !== "string" || typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls[p] = (calls[p] ?? 0) + 1;
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    const pin = awaitedByParent(counted);
    expect(await pin("P::k")).toBe(true);
    expect(calls.read ?? 0).toBe(0);
    expect(calls.readFrom ?? 0).toBe(0);
    expect(calls.head).toBe(1);
    expect(calls.readRange).toBe(1);
    const before = { ...calls };
    expect(await pin("P::k")).toBe(true);
    expect(calls.head).toBe((before.head ?? 0) + 1); // linear in candidates, constant per candidate
    expect(calls.readRange).toBe((before.readRange ?? 0) + 1);
  });
});

describe("awaitedByParent — through LogLifecycle and the real orchestration", () => {
  const world = () => ({
    events: new InMemoryAsyncEventStore(),
    snaps: new InMemoryAsyncSnapshotStore(),
  });
  type World = ReturnType<typeof world>;
  function boot(w: World, supervise: boolean) {
    const holder: { sup?: ChildSupervisor } = {};
    const runtime = new WorkflowRuntime({
      eventStore: w.events,
      snapshotStore: w.snaps,
      effectRuntime: new EffectRuntime(),
      onEvent: (e) => holder.sup?.onEvent(e),
    });
    for (const f of Object.values(flows)) {
      runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
    }
    if (supervise) holder.sup = superviseChildren({ runtime, flows });
    return { runtime, sup: holder.sup as ChildSupervisor };
  }
  const sys = (rt: WorkflowRuntime) => rt.systemOptions();
  async function until(
    rt: WorkflowRuntime,
    id: string,
    pred: (s: NonNullable<Awaited<ReturnType<WorkflowRuntime["loadState"]>>>) => boolean
  ) {
    const t0 = Date.now();
    while (Date.now() - t0 <= 20_000) {
      const s = await rt.loadState(id, sys(rt));
      if (s !== null && pred(s)) return s;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout on ${id}`);
  }
  const done = (rt: WorkflowRuntime, id: string) =>
    until(rt, id, (s) => s.status === "completed" || s.status === "failed");
  const POLICY = { terminalTtlMs: 0 };

  /** The supervisor is down: the child ran to completion while the parent stayed parked on it. */
  async function childDoneParentParked(w: World) {
    const down = boot(w, false);
    await down.runtime.start("single", {}, { executionId: "P" });
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await down.runtime.start("instant", { n: 1 }, { executionId: "P::k" });
    await until(down.runtime, "P::k", (s) => s.status === "completed");
  }

  it("evaluate reports the child 'pinned'; applyRetention leaves its log untouched; once the parent completes the child reclaims", async () => {
    const w = world();
    await childDoneParentParked(w);
    const lifecycle = new LogLifecycle(w.events, w.snaps, {
      pinned: awaitedByParent(w.events, { snapshots: w.snaps }),
    });
    const now = Date.now() + 10;
    const before = await w.events.read("P::k");
    expect(await lifecycle.evaluate("P::k", POLICY, now)).toBe("pinned");
    expect(await lifecycle.applyRetention("P::k", POLICY, now)).toBe("pinned");
    expect(await w.events.read("P::k")).toEqual(before);

    const up = boot(w, true);
    expect((await up.sup.recover()).resumed).toBe(1);
    await done(up.runtime, "P");
    expect(await lifecycle.applyRetention("P::k", POLICY, Date.now() + 10)).not.toBe("pinned");
    expect(await w.events.read("P::k")).toEqual([]);
  }, 30000);

  it("a root is unaffected, and an app pinned predicate still applies (ORed, not replaced)", async () => {
    const w = world();
    await childDoneParentParked(w);
    const down = boot(w, false);
    await down.runtime.start("instant", { n: 2 }, { executionId: "R" });
    await until(down.runtime, "R", (s) => s.status === "completed");
    const awaited = awaitedByParent(w.events, { snapshots: w.snaps });
    const now = Date.now() + 10;
    const lone = new LogLifecycle(w.events, w.snaps, { pinned: awaited });
    expect(await lone.evaluate("R", POLICY, now)).toBe("reclaimable");
    const composed = new LogLifecycle(w.events, w.snaps, {
      pinned: async (id) => id === "R" || (await awaited(id)),
    });
    expect(await composed.evaluate("R", POLICY, now)).toBe("pinned"); // the app's own pin
    expect(await composed.evaluate("P::k", POLICY, now)).toBe("pinned"); // the child pin
  }, 30000);

  it("END TO END: retention between the child's completion and the parent's resume — the parent gets the child's REAL output", async () => {
    const w = world();
    await childDoneParentParked(w);
    const lifecycle = new LogLifecycle(w.events, w.snaps, {
      pinned: awaitedByParent(w.events, { snapshots: w.snaps }),
    });
    expect(await lifecycle.applyRetention("P::k", POLICY, Date.now() + 10)).toBe("pinned");
    const up = boot(w, true);
    await up.sup.recover();
    const parent = await done(up.runtime, "P");
    expect(parent.status).toBe("completed");
    expect(parent.variables._output).toEqual({ v: 1 });
  }, 30000);

  it("GUARD FIRES: the same scenario WITHOUT the pin reclaims the child and the parent fails 'reclaimed by retention'", async () => {
    const w = world();
    await childDoneParentParked(w);
    const unguarded = new LogLifecycle(w.events, w.snaps);
    expect(await unguarded.applyRetention("P::k", POLICY, Date.now() + 10)).not.toBe("pinned");
    expect(await w.events.read("P::k")).toEqual([]);
    const up = boot(w, true);
    await up.sup.recover();
    const parent = await done(up.runtime, "P");
    expect(parent.status).toBe("failed");
    expect(JSON.stringify(parent)).toMatch(/reclaimed by retention/);
  }, 30000);
});
