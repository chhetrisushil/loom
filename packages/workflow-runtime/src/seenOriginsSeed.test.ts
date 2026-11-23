import { tainted } from "@loomwork/classify";
import { step$ } from "@loomwork/core";
import type { ExecutionState, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import {
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
  brandPayloadShredded,
} from "@loomwork/event-runtime";
import { ReplayVM, SEEN_ORIGINS_OVERFLOW } from "@loomwork/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { settle, until } from "./__tests__/r2Harness";
import { LeaseHeldError } from "./leaseKeeper";
import { SealedStreamUnreadableError } from "./sealGuard";
import { SeenOriginsRescanUnavailableError, adoptSeenOrigins } from "./seenOriginsSeed";
import { QuarantineHeldError } from "./types";
import type { FlowRunner } from "./types";

// ADR 0152 S2c: adoption of an untracked run (gate on) and the upgrade rescan.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const mk = (id: string) => step$({ id, name: id, toolId: id, ...io });
const taint = mk("taint");
const probe = mk("probe");
const clean = mk("clean");
const mapTaint = mk("mapTaint");

type Seen = { present: boolean; list?: readonly string[] };

function world() {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const archive = new InMemoryArchiveStore();
  const probes: Seen[] = [];
  const runtime = (deps: Partial<WorkflowRuntimeDeps> = {}, store: EventStore = eventStore) => {
    const effects = new EffectRuntime();
    effects.register("taint", new ToolEffect(async (i: unknown) => tainted(i, "lineage:A")));
    effects.register("clean", new ToolEffect(async (i: unknown) => i));
    effects.register(
      "mapTaint",
      new ToolEffect(async () => new Map([["k", tainted("v", "lineage:M")]]))
    );
    effects.register(
      "probe",
      new ToolEffect(async (i: unknown, ctx) => {
        probes.push({
          present: ctx.seenOrigins !== undefined,
          ...(ctx.seenOrigins && { list: ctx.seenOrigins() }),
        });
        return i;
      })
    );
    const rt = new WorkflowRuntime({
      eventStore: store,
      snapshotStore,
      timerStore,
      effectRuntime: effects,
      inboxEnabled: true,
      onWarn: () => {},
      ...deps,
    });
    const body: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.run(taint, (ctx as unknown as { input?: unknown }).input ?? "x");
      await ctx.receive("go");
      await ctx.run(probe, "p");
      return "done";
    };
    const gated: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.run(taint, "x");
      await ctx.suspend({ on: "go" });
      await ctx.run(probe, "p");
      return "done";
    };
    const flowOf = (id: string, runner: FlowRunner<unknown, unknown>) =>
      rt.registerFlow(
        {
          _tag: "FlowDefinition",
          id,
          name: id,
          version: "1.0.0",
          ...io,
          steps: [taint, probe, clean, mapTaint],
        } as unknown as FlowDefinition<unknown, unknown>,
        runner
      );
    flowOf("clean", async (ctx) => {
      await ctx.run(clean, "x");
      await ctx.suspend({ on: "go" });
      await ctx.run(probe, "p");
      return "done";
    });
    flowOf("map", async (ctx) => {
      await ctx.receive("go");
      await ctx.run(mapTaint, "m");
      await ctx.receive("go2");
      await ctx.run(probe, "p");
      return "done";
    });
    rt.registerFlow(
      {
        _tag: "FlowDefinition",
        id: "g",
        name: "g",
        version: "1.0.0",
        ...io,
        steps: [taint, probe],
      } as unknown as FlowDefinition<unknown, unknown>,
      gated
    );
    rt.registerFlow(
      {
        _tag: "FlowDefinition",
        id: "f",
        name: "f",
        version: "1.0.0",
        ...io,
        steps: [taint, probe],
      } as unknown as FlowDefinition<unknown, unknown>,
      body
    );
    return rt;
  };
  const park = async (id: string, input: unknown = "x") => {
    const rt = runtime(); // the gate is OFF: an untracked, pre-gate run
    await settle(
      await rt.start(id.startsWith("c") || id.startsWith("x") ? "g" : "f", input, {
        executionId: id,
      })
    );
    return rt;
  };
  const finish = async (rt: WorkflowRuntime, id: string) => {
    const n = probes.length;
    if (id.startsWith("c") || id.startsWith("x"))
      await rt.resume(id, { eventType: "go", payload: { answer: "go" } });
    else await rt.send(id, { topic: "go", payload: "p", messageId: `g-${n}` });
    await until(() => probes.length > n);
    const seen = probes.at(-1) as Seen;
    return seen.list === undefined ? seen : { ...seen, list: [...seen.list].sort() };
  };
  return { eventStore, snapshotStore, archive, probes, runtime, park, finish };
}

const on = { seenOriginsEnabled: true };

describe("seen origins: adoption and rescan (S2c)", () => {
  it("a pre-gate run that saw a tainted output is adopted on resume: the next effect sees the origin, no marker", async () => {
    // kills: no adoption (present=false), a clean seeded key (no lineage:A), a tail-only fold (no lineage:A)
    const w = world();
    await w.park("e1");
    const seen = await w.finish(w.runtime(on), "e1");
    expect(seen.present).toBe(true);
    expect(seen.list).toEqual(["inbox:go", "lineage:A"].sort());
    expect(seen.list).not.toContain(SEEN_ORIGINS_OVERFLOW);
  });

  it("gate off: no adoption, seenOrigins absent, no origins recorded on any event", async () => {
    // kills: adopting regardless of the gate
    const w = world();
    const rt = await w.park("e2");
    const seen = await w.finish(rt, "e2");
    expect(seen.present).toBe(false);
    const log = await w.eventStore.read("e2");
    expect(log.some((e) => e.metadata?.origins !== undefined)).toBe(false);
    const state = (await rt.loadState("e2", rt.systemOptions())) as ExecutionState;
    expect(state.variables._seenOrigins).toBeUndefined();
  });

  it("a compacted run with NO archive configured adopts as overflow; with the archive it sees the archived origins", async () => {
    // kills: treating a truncated prefix as clean; ignoring the archive
    const w = world();
    await w.park("c1");
    await w.park("c2");
    const life = new LogLifecycle(w.eventStore, w.snapshotStore, { compactionArchive: w.archive });
    for (const id of ["c1", "c2"]) {
      expect(await life.compact(id)).not.toBeNull();
      expect((await w.eventStore.read(id)).length).toBeLessThan(5);
    }
    const bare = await w.finish(w.runtime(on), "c1");
    expect(bare.list).toEqual([SEEN_ORIGINS_OVERFLOW]); // origins unknown, never "clean"
    const archived = await w.finish(w.runtime({ ...on, compactionArchive: w.archive }), "c2");
    expect(archived.list).toEqual(["lineage:A"]);
  });

  it("a run whose scan exceeds the node bound adopts as overflow", async () => {
    // kills: dropping a bound-exceeded scan silently (a clean key)
    const w = world();
    await w.park(
      "b1",
      Array.from({ length: 300 }, (_, i) => i)
    );
    const seen = await w.finish(
      w.runtime({ ...on, seenOriginsLimits: { maxScanNodes: 100 } }),
      "b1"
    );
    expect(seen.list).toEqual([SEEN_ORIGINS_OVERFLOW]);
  });

  it("a restored run's forged key is dropped and rebuilt from the log (an untracked run is adopted, not left clean)", async () => {
    // kills: trusting the caller's key; leaving a restored run absent
    const w = world();
    const rt0 = await w.park("r1");
    const state = (await rt0.loadState("r1", rt0.systemOptions())) as ExecutionState;
    const forged: ExecutionState = {
      ...state,
      variables: {
        ...state.variables,
        _seenOrigins: {
          v: 1,
          limits: { maxOrigins: 64, maxScanNodes: 10_000 },
          origins: [],
          through: state.sequence,
        },
      },
    };
    const rt = w.runtime(on);
    await settle(await rt.restoreFromState(forged, undefined, rt.systemOptions()));
    expect((await w.finish(rt, "r1")).list).toEqual(["inbox:go", "lineage:A"].sort());
  });

  it("adoption is memoized: a second resume of the same old snapshot reads only the tail, not the history", async () => {
    // kills: rescanning on every resume
    const w = world();
    await w.park("m1");
    const reads: Array<[number, number]> = [];
    const spy = new Proxy(w.eventStore, {
      get(t, k, r) {
        if (k === "readRange") {
          return (id: string, from: number, to: number) => {
            if (id === "m1") reads.push([from, to]);
            return t.readRange?.(id, from, to);
          };
        }
        const v = Reflect.get(t, k, r) as unknown;
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as EventStore;
    const rt = w.runtime(on, spy);
    await w.finish(rt, "m1");
    expect(reads.some(([from]) => from === 0)).toBe(true); // the first adoption folded from sequence 0
    // a fresh resume path over the same runtime: park again is not possible, so adopt a second vm directly
    const state = (await rt.loadState("m1", rt.systemOptions())) as ExecutionState;
    const before = reads.length;
    const vm = new ReplayVM([], {
      ...state,
      variables: { ...state.variables, _seenOrigins: undefined },
    });
    await (
      rt as unknown as { adoptSeenOrigins(v: ReplayVM, l: unknown): Promise<void> }
    ).adoptSeenOrigins(vm, { valid: () => true });
    const after = reads.slice(before);
    expect(after.every(([from, to]) => from > 0 || to === 0)).toBe(true); // one anchor read at the memoized sequence, no history scan
    const origins = (vm.peekState().variables._seenOrigins as { origins: string[] }).origins;
    expect([...origins].sort()).toEqual(["inbox:go", "lineage:A"]);
  });

  it("two runtimes adopt to byte-identical keys, and a key-reversing store changes nothing", async () => {
    // kills: key-order or node-local state leaking into the rescan
    const w = world();
    await w.park("d1");
    const keyOf = async (rt: WorkflowRuntime) => {
      const state = (await rt.loadState("d1", rt.systemOptions())) as ExecutionState;
      const vm = new ReplayVM([], state);
      await (
        rt as unknown as { adoptSeenOrigins(v: ReplayVM, l: unknown): Promise<void> }
      ).adoptSeenOrigins(vm, { valid: () => true });
      return JSON.stringify(vm.peekState().variables._seenOrigins);
    };
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)])
            )
          : v;
    const rev = new Proxy(w.eventStore, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r) as unknown;
        if (typeof v !== "function") return v;
        return async (...a: unknown[]) => {
          const out: unknown = await (v as (...x: unknown[]) => unknown).apply(t, a);
          return Array.isArray(out) ? reverse(out) : out;
        };
      },
    }) as EventStore;
    const a = await keyOf(w.runtime(on));
    const b = await keyOf(w.runtime(on));
    const c = await keyOf(w.runtime(on, rev));
    expect(a).toContain("lineage:A");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe("seen origins: review fixes (R16)", () => {
  const memoOf = (rt: WorkflowRuntime) =>
    (rt as unknown as { seenOriginsMemo: Map<string, unknown> }).seenOriginsMemo;
  const wipe = async (w: ReturnType<typeof world>, id: string) => {
    await w.eventStore.deleteExecution(id);
    await w.snapshotStore.deleteExecution(id);
  };

  it("I-1: a memo entry never survives delete + id reuse (gate-off restart of the id, then a resume)", async () => {
    // kills: a memo bound only to the event id (ids are <execution>-<sequence>, so reuse repeats them)
    const w = world();
    const first = w.runtime();
    await settle(await first.start("clean", "x", { executionId: "x1" }));
    const rtOn = w.runtime(on);
    await rtOn.resume("x1", { eventType: "go", payload: { answer: "go" } });
    await until(() => w.probes.length > 0);
    await until(
      async () =>
        ((await rtOn.loadState("x1", rtOn.systemOptions())) as ExecutionState).status ===
        "completed"
    );
    expect(memoOf(rtOn).has("x1")).toBe(true);
    await wipe(w, "x1");
    await settle(await w.runtime().start("g", "x", { executionId: "x1" })); // a TAINTED run on the reused id
    const n = w.probes.length;
    await rtOn.resume("x1", { eventType: "go", payload: { answer: "go" } });
    await until(() => w.probes.length > n);
    expect(w.probes.at(-1)?.list).toEqual(["lineage:A"]);
  });

  it("I-1: ...and a gate-on run on a reused id passed through restoreFromState", async () => {
    // kills: the same stale-memo hole through the restore site
    const w = world();
    const first = w.runtime();
    await settle(await first.start("clean", "x", { executionId: "x2" }));
    const rtOn = w.runtime(on);
    await rtOn.resume("x2", { eventType: "go", payload: { answer: "go" } });
    await until(() => w.probes.length > 0);
    await until(
      async () =>
        ((await rtOn.loadState("x2", rtOn.systemOptions())) as ExecutionState).status ===
        "completed"
    );
    await wipe(w, "x2");
    const rt2 = w.runtime(on);
    await settle(await rt2.start("g", "x", { executionId: "x2" }));
    const st = (await rt2.loadState("x2", rt2.systemOptions())) as ExecutionState;
    await settle(await rtOn.restoreFromState(st, undefined, rtOn.systemOptions()));
    const n = w.probes.length;
    await rtOn.resume("x2", { eventType: "go", payload: { answer: "go" } });
    await until(() => w.probes.length > n);
    expect(w.probes.at(-1)?.list).toEqual(["lineage:A"]);
  });

  it("I-2: a Map-carried origin recorded after adoption survives a fresh node's rescan", async () => {
    // kills: stripping the recorded list on an unstamped run (the JSON scan cannot see inside a Map)
    const w = world();
    await settle(await w.runtime().start("map", "x", { executionId: "mp" }));
    const rtA = w.runtime(on);
    await rtA.send("mp", { topic: "go", payload: 1, messageId: "g1" });
    await until(async () => {
      const log = await w.eventStore.read("mp");
      return log.some((e) => JSON.stringify(e.metadata?.origins ?? []).includes("lineage:M"));
    });
    await w.snapshotStore.deleteExecution("mp"); // the snapshot is lost: a fresh node rescans
    const rtB = w.runtime(on);
    const n = w.probes.length;
    await rtB.send("mp", { topic: "go2", payload: 1, messageId: "g2" });
    await until(() => w.probes.length > n);
    expect(w.probes.at(-1)?.list).toContain("lineage:M");
  });

  it("M-9: a stand-down reads no history (the rescan runs only after the lease)", async () => {
    // kills: adopting before takeDriverLease
    const w = world();
    await w.park("x9");
    const leases = new InMemoryLeaseStore();
    const reads: number[] = [];
    const spy = new Proxy(w.eventStore, {
      get(t, k, r) {
        if (k === "readRange") {
          return (id: string, from: number, to: number) => {
            if (id === "x9") reads.push(to);
            return t.readRange?.(id, from, to);
          };
        }
        const v = Reflect.get(t, k, r) as unknown;
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as EventStore;
    const rt = w.runtime(
      {
        ...on,
        heartbeat: {
          leaseStore: leases,
          nodeId: "n1",
          incarnation: "i1",
          ttlMs: 30_000,
        } as never,
      },
      spy
    );
    await leases.acquire("x9", "other:node", 30_000, Date.now());
    await expect(
      rt.resume("x9", { eventType: "go", payload: { answer: "go" } })
    ).rejects.toBeInstanceOf(LeaseHeldError);
    expect(reads.filter((to) => to > 0)).toEqual([]);
  });

  it("M-9: the flow-migration site adopts too", async () => {
    // kills: an unwired migration call site
    const w = world();
    const off = w.runtime();
    await settle(await off.start("g", "x", { executionId: "mg" }));
    const rt = w.runtime(on);
    await rt.resumeAs("mg", "g", { eventType: "go", payload: { answer: "go" } }, {
      strategy: "operator-ack",
      system: true,
    } as never);
    await until(() => w.probes.length > 0);
    expect(w.probes.at(-1)?.list).toEqual(["lineage:A"]);
  });
});

describe("seen origins: rescan error classes", () => {
  const vmOf = () =>
    new ReplayVM([], {
      executionId: "x",
      workflowId: "f",
      workflowVersion: "1",
      sequence: 3,
    } as never);
  const deps = (events: unknown) => ({
    enabled: true,
    limits: { maxOrigins: 64, maxScanNodes: 10_000 },
    events: events as EventStore,
    memo: new Map(),
  });
  it("an erased (crypto-shredded) payload adopts as sticky overflow", async () => {
    // kills: failing the resume on a permanent error; treating it as clean
    const vm = vmOf();
    const events = {
      readRange: async () => {
        throw brandPayloadShredded(new Error("shredded"));
      },
    };
    await adoptSeenOrigins(deps(events), vm);
    expect(vm.peekState().variables._seenOrigins).toMatchObject({ overflow: true, through: 3 });
  });
  it("a transient read failure is a retryable failure that persists and memoizes nothing", async () => {
    // kills: sticky-overflowing a healthy run on an outage
    const vm = vmOf();
    const d = deps({
      readRange: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    await expect(adoptSeenOrigins(d, vm)).rejects.toBeInstanceOf(SeenOriginsRescanUnavailableError);
    expect(vm.peekState().variables._seenOrigins).toBeUndefined();
    expect(d.memo.size).toBe(0);
  });

  const env = (seq: number, eventType = "NOTE", payload: unknown = {}) =>
    ({
      id: `u-${seq}`,
      executionId: "u",
      workflowId: "f",
      sequence: seq,
      eventType,
      payload,
      timestamp: seq,
    }) as never;

  it("I-3: the archive is read one segment at a time (peak events held is O(segment), not O(history))", async () => {
    // kills: one readArchived over the whole gap
    const SEG = 10;
    const total = 100;
    const all = [env(0, "EXECUTION_STARTED", { input: 1 })];
    for (let i = 1; i <= total; i++) all.push(env(i));
    const headers = Array.from({ length: total / SEG }, (_, i) => ({
      from: 1 + i * SEG,
      through: (i + 1) * SEG,
      count: SEG,
      digest: "d",
      incarnation: "i",
    }));
    const batches: number[] = [];
    const d = {
      enabled: true,
      limits: { maxOrigins: 64, maxScanNodes: 10_000 },
      events: {
        readRange: async (_: string, from: number, to: number) =>
          (all as { sequence: number }[]).filter(
            (e) =>
              e.sequence >= from && e.sequence <= to && (e.sequence === 0 || e.sequence > total)
          ),
      } as unknown as EventStore,
      archive: {
        headers: async () => headers as never,
        read: async (_: string, r: { from: number; through: number }) => {
          const out = (all as { sequence: number }[]).filter(
            (e) => e.sequence >= r.from && e.sequence <= r.through
          );
          batches.push(out.length);
          return out as never;
        },
      },
      memo: new Map(),
    };
    const vm = new ReplayVM([], {
      executionId: "u",
      workflowId: "f",
      workflowVersion: "1",
      sequence: total,
    } as never);
    await adoptSeenOrigins(d, vm);
    expect(batches.length).toBe(total / SEG);
    expect(Math.max(...batches)).toBeLessThanOrEqual(SEG);
    expect(vm.peekState().variables._seenOrigins).toMatchObject({ origins: [], through: total });
  });

  it("M-1/M-2: permanent classes give sticky overflow; a key-unavailable seal and a quarantine hold are retryable", async () => {
    // kills: classifying a recoverable seal refusal as permanent (a healthy run would be marked foreign forever)
    const throwing = (err: unknown) => ({
      enabled: true,
      limits: { maxOrigins: 64, maxScanNodes: 10_000 },
      events: {
        readRange: async () => {
          throw err;
        },
      } as unknown as EventStore,
      memo: new Map(),
    });
    const named = (name: string) => Object.assign(new Error(name), { name });
    for (const n of [
      "ArchiveDigestError",
      "ArchiveGapError",
      "ArchiveIncarnationError",
      "PayloadUndecryptableError",
      "PlaintextArchiveError",
    ]) {
      const vm = vmOf();
      await adoptSeenOrigins(throwing(named(n)), vm);
      expect(vm.peekState().variables._seenOrigins, n).toMatchObject({ overflow: true });
    }
    const keyUnavailable = new SealedStreamUnreadableError("resume", "x", {
      reason: "key-unavailable",
    });
    const held = Object.create(QuarantineHeldError.prototype) as Error;
    const marker = new SealedStreamUnreadableError("resume", "x", { reason: "marker-unopenable" });
    for (const [err, retry] of [
      [keyUnavailable, true],
      [held, true],
      [marker, false],
    ] as const) {
      const vm = vmOf();
      const run = adoptSeenOrigins(throwing(err), vm);
      if (retry) await expect(run).rejects.toBeInstanceOf(SeenOriginsRescanUnavailableError);
      else {
        await run;
        expect(vm.peekState().variables._seenOrigins).toMatchObject({ overflow: true });
      }
    }
  });
});
