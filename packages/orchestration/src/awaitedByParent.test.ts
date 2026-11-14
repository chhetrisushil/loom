import type { EventEnvelope } from "@loomwork/core";
import { EffectRuntime } from "@loomwork/effect-runtime";
import {
  InMemoryAsyncEventStore,
  TenantScopedEventStore,
  brandPayloadShredded,
  isPayloadShredded,
} from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type FlowRunner,
  LogLifecycle,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { awaitChild, awaitedByParent, superviseChildren } from "./index";
import type { ChildSupervisor } from "./orchestration";

// ADR 0145 amendment — retention must not reclaim an orchestration child while its parent is
// still alive (prevention; the supervisor's rescan of the lifecycle stream is KEPT as the backstop).

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
// A parent that collects k1 and then FAILS, and the fixed flow it is later re-opened onto (resumeAs):
// it replays k1, then spawns a SECOND child k2 and parks on it.
const broken = mk("broken", async (ctx) => {
  await awaitChild(ctx, { key: "k1", flowId: "instant", input: { n: 1 } });
  throw new Error("boom");
});
const fixed = mk("fixed", async (ctx) => {
  const a = await awaitChild(ctx, { key: "k1", flowId: "instant", input: { n: 1 } });
  const b = await awaitChild(ctx, { key: "k2", flowId: "instant", input: { n: 2 } });
  return { a, b };
});
const flows: Record<string, RegisteredFlow> = { instant, single, broken, fixed };

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

/** A child whose sequence 0 RECORDS `parent` (what the supervisor's lineage grant writes). */
async function child(store: InMemoryAsyncEventStore, id = "P::k", parent = "P") {
  await store.append({
    ...ev(id, 0, "EXECUTION_STARTED"),
    payload: { parent },
  } as unknown as EventEnvelope);
  await store.append(ev(id, 1, "EXECUTION_COMPLETED"));
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
    await child(store);
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
    await child(store);
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "EXECUTION_CONTINUED"], 2);
    expect(await awaitedByParent(store)("P::k")).toBe(false);
    // An app event that merely carries the name, without the kernel marker, is not a continuation.
    const other = new InMemoryAsyncEventStore();
    await child(other);
    await seed(other, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "EXECUTION_CONTINUED"]);
    expect(await awaitedByParent(other)("P::k")).toBe(true);
  });

  it("a parent with no events (gone or never existed) pins nothing", async () => {
    const empty = new InMemoryAsyncEventStore();
    await child(empty);
    expect(await awaitedByParent(empty)("P::k")).toBe(false);
  });

  it("a nested child is judged by its IMMEDIATE parent only", async () => {
    const store = new InMemoryAsyncEventStore();
    await child(store);
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
    await child(store, "P::a", "P");
    await child(store, "P::a::b", "P::a");
    expect(await awaitedByParent(store)("P::a::b")).toBe(false); // P::a is done
    expect(await awaitedByParent(store)("P::a")).toBe(true); // P is alive
  });

  it("FAILS SAFE: a read that throws pins; a crypto-shredded parent does not", async () => {
    const store = new InMemoryAsyncEventStore();
    await child(store);
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
    expect(
      await awaitedByParent(
        failing(() => new Error("backend down")),
        { onWarn: () => {} }
      )("P::k")
    ).toBe(true);
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
    await child(store);
    // the lifecycle events were compacted into the checkpoint: only app events remain
    await seed(store, "P", ["AUDIT_NOTE", "AUDIT_NOTE", "AUDIT_NOTE"]);
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

  const counting = (store: InMemoryAsyncEventStore) => {
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
    return { calls, counted };
  };

  it("does O(1) reads per candidate however long the parent's log is (child seq 0 + head + ONE page)", async () => {
    const store = new InMemoryAsyncEventStore();
    await child(store);
    await seed(store, "P", [
      "EXECUTION_STARTED",
      ...Array.from({ length: 300 }, () => "STEP_COMPLETED"),
      "EXECUTION_SUSPENDED",
      "AUDIT_NOTE",
    ]);
    const { calls, counted } = counting(store);
    const pin = awaitedByParent(counted);
    expect(await pin("P::k")).toBe(true);
    expect(calls.read ?? 0).toBe(0);
    expect(calls.readFrom ?? 0).toBe(0);
    expect(calls.head).toBe(1);
    expect(calls.readRange).toBe(2);
    expect(await pin("P::k")).toBe(true);
    expect(calls.head).toBe(2); // linear in candidates, constant per candidate
    expect(calls.readRange).toBe(4);
  });

  it("the paging cap: 64 events with no lifecycle event pins, reads at most 1 + 4 ranges, warns ONCE per parent", async () => {
    const store = new InMemoryAsyncEventStore();
    await child(store);
    await seed(store, "P", [
      "EXECUTION_STARTED",
      "EXECUTION_SUSPENDED",
      "EXECUTION_FAILED",
      ...Array.from({ length: 300 }, () => "LATE_OUTCOME"),
    ]);
    const { calls, counted } = counting(store);
    const warnings: string[] = [];
    const pin = awaitedByParent(counted, { onWarn: (m) => warnings.push(m) });
    expect(await pin("P::k")).toBe(true); // fail safe: the terminal event is out of reach
    expect(calls.readRange).toBe(1 + 4);
    expect(await pin("P::k")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no lifecycle event in its newest 64 events/);
  });

  it("post-terminal appends within the cap (audit facts, late outcomes) do not keep the child", async () => {
    const store = new InMemoryAsyncEventStore();
    await child(store);
    await seed(store, "P", [
      "EXECUTION_STARTED",
      "EXECUTION_SUSPENDED",
      "EXECUTION_FAILED",
      ...Array.from({ length: 40 }, () => "DENY_AUDIT"),
    ]);
    const { calls, counted } = counting(store);
    expect(await awaitedByParent(counted)("P::k")).toBe(false);
    expect(calls.readRange).toBe(1 + 3); // 40 events = 3 pages
  });

  it("a RE-OPENED parent (FAILED, then RESUMED / SUSPENDED / STARTED) is live and pins; a re-opened-then-finished one does not", async () => {
    for (const reopen of ["EXECUTION_RESUMED", "EXECUTION_SUSPENDED", "EXECUTION_STARTED"]) {
      const store = new InMemoryAsyncEventStore();
      await child(store);
      await seed(store, "P", [
        "EXECUTION_STARTED",
        "EXECUTION_SUSPENDED",
        "EXECUTION_FAILED",
        reopen,
        "STEP_COMPLETED",
        "AUDIT_NOTE",
      ]);
      expect(await awaitedByParent(store)("P::k"), reopen).toBe(true);
    }
    const done = new InMemoryAsyncEventStore();
    await child(done);
    await seed(done, "P", [
      "EXECUTION_STARTED",
      "EXECUTION_FAILED",
      "EXECUTION_RESUMED",
      "EXECUTION_COMPLETED",
    ]);
    expect(await awaitedByParent(done)("P::k")).toBe(false);
  });

  it("parity with ADR 0146 terminalEndOf: a non-kernel EXECUTION_CONTINUED says nothing, a kernel one ends", async () => {
    const live = new InMemoryAsyncEventStore();
    await child(live);
    await seed(live, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "EXECUTION_CONTINUED"]);
    expect(await awaitedByParent(live)("P::k")).toBe(true);
  });

  it("the parent is the child's RECORDED parent, never a split of the id", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store, "acct", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]); // alive, unrelated
    // An app id that merely contains "::": no recorded parent -> not an orchestration child.
    await seed(store, "acct::42", ["EXECUTION_STARTED", "EXECUTION_COMPLETED"]);
    expect(await awaitedByParent(store)("acct::42")).toBe(false);
    // A real child records its parent, and an id-split guess is ignored in favour of it.
    await child(store, "acct::k", "acct");
    expect(await awaitedByParent(store)("acct::k")).toBe(true);
    await child(store, "other::k", "elsewhere");
    await seed(store, "elsewhere", ["EXECUTION_STARTED", "EXECUTION_COMPLETED"]);
    await seed(store, "other", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
    expect(await awaitedByParent(store)("other::k")).toBe(false); // judged by "elsewhere", not "other"
    // A child that does not exist (nothing to read) is not pinned.
    expect(await awaitedByParent(store)("acct::ghost")).toBe(false);
  });

  it("works over a tenant-scoped view: the recorded parent is a logical id in the same space", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = new TenantScopedEventStore(inner, "t1");
    const events = new InMemoryAsyncEventStore();
    await child(events);
    await seed(events, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
    for (const id of ["P", "P::k"]) {
      for (const e of await events.read(id)) await view.append(e);
    }
    expect(await awaitedByParent(view)("P::k")).toBe(true);
    expect(await awaitedByParent(new TenantScopedEventStore(inner, "t2"))("P::k")).toBe(false);
  });

  it("an unreadable parent (e.g. an encrypting store without keys) pins AND warns once, naming why", async () => {
    const store = new InMemoryAsyncEventStore();
    await child(store);
    await seed(store, "P", ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
    const failing = new Proxy(store, {
      get: (t, p, r) =>
        p === "head"
          ? async () => {
              throw new Error("no key");
            }
          : Reflect.get(t, p, r),
    });
    const warnings: string[] = [];
    const pin = awaitedByParent(failing, { onWarn: (m) => warnings.push(m) });
    expect(await pin("P::k")).toBe(true);
    expect(await pin("P::k")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no key/);
    expect(warnings[0]).toMatch(/keys/);
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
    await startChildDown(down.runtime, "P::k", 1, "P");
    await until(down.runtime, "P::k", (s) => s.status === "completed");
  }

  /** What the supervisor does to start a child: the lineage grant records the PARENT on sequence 0. */
  const startChildDown = (rt: WorkflowRuntime, id: string, n: number, parent: string) =>
    rt.start(
      "instant",
      { n },
      {
        executionId: id,
        ...rt.systemOptions(),
        ...rt.lineageOptions(),
        parentExecutionId: parent,
      }
    );

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

  // A parent that FAILED and was RE-OPENED (resumeAs appends EXECUTION_RESUMED to a failed execution) is
  // alive again: it spawns P::k2 and parks, and the supervisor goes down before the child's result is
  // collected. The FAILED event sits BELOW the re-open; an oldest-first scan that stops at it would
  // call the parent finished and release (then reclaim) the child.
  async function reopenedParentChildDone(w: World) {
    const up = boot(w, true);
    await up.runtime.start("broken", {}, { executionId: "P" });
    await until(up.runtime, "P", (s) => s.status === "failed");
    const down = boot(w, false); // the supervisor is down from here
    await down.runtime.resumeAs(
      "P",
      "fixed",
      { eventType: "Retry", payload: {} },
      {
        strategy: "operator-ack",
      }
    );
    await until(down.runtime, "P", (s) => s.status === "suspended");
    await startChildDown(down.runtime, "P::k2", 2, "P");
    await until(down.runtime, "P::k2", (s) => s.status === "completed");
  }

  it("RE-OPEN END TO END: a failed-then-resumeAs'd parent still pins its child; the real supervisor then delivers the child's REAL output", async () => {
    const w = world();
    await reopenedParentChildDone(w);
    const kinds = (await w.events.read("P")).map((e) => e.eventType);
    expect(kinds.lastIndexOf("EXECUTION_FAILED")).toBeGreaterThan(-1);
    expect(kinds.lastIndexOf("EXECUTION_RESUMED")).toBeGreaterThan(
      kinds.lastIndexOf("EXECUTION_FAILED")
    );
    const lifecycle = new LogLifecycle(w.events, w.snaps, {
      pinned: awaitedByParent(w.events, { snapshots: w.snaps }),
    });
    expect(await lifecycle.applyRetention("P::k2", POLICY, Date.now() + 10)).toBe("pinned");
    const up = boot(w, true);
    await up.sup.recover();
    const parent = await done(up.runtime, "P");
    expect(parent.status).toBe("completed");
    expect(parent.variables._output).toEqual({ a: { v: 1 }, b: { v: 2 } });
  }, 30000);

  it("RE-OPEN GUARD FIRES: the same re-opened parent WITHOUT the pin loses the child to retention", async () => {
    const w = world();
    await reopenedParentChildDone(w);
    const unguarded = new LogLifecycle(w.events, w.snaps);
    expect(await unguarded.applyRetention("P::k2", POLICY, Date.now() + 10)).not.toBe("pinned");
    const up = boot(w, true);
    await up.sup.recover();
    const parent = await done(up.runtime, "P");
    expect(parent.status).toBe("failed");
    expect(JSON.stringify(parent)).toMatch(/reclaimed by retention/);
  }, 30000);

  it("through LogLifecycle: a grandparent that is alive does NOT keep a child whose own parent is terminal", async () => {
    const w = world();
    const down = boot(w, false);
    await down.runtime.start("single", {}, { executionId: "G" }); // G alive, parked
    await until(down.runtime, "G", (s) => s.status === "suspended");
    await startChildDown(down.runtime, "G::p", 3, "G"); // P = G::p, finished
    await until(down.runtime, "G::p", (s) => s.status === "completed");
    await startChildDown(down.runtime, "G::p::c", 4, "G::p"); // C = G::p::c, finished
    await until(down.runtime, "G::p::c", (s) => s.status === "completed");
    const lifecycle = new LogLifecycle(w.events, w.snaps, {
      pinned: awaitedByParent(w.events, { snapshots: w.snaps }),
    });
    const now = Date.now() + 10;
    expect(await lifecycle.evaluate("G::p::c", POLICY, now)).toBe("reclaimable"); // its parent G::p is done
    expect(await lifecycle.evaluate("G::p", POLICY, now)).toBe("pinned"); // G is alive
  }, 30000);
});
