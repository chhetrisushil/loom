import { tainted } from "@loomwork/classify";
import { step$ } from "@loomwork/core";
import type { ExecutionState, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import {
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
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
import { SeenOriginsRescanUnavailableError, adoptSeenOrigins } from "./seenOriginsSeed";
import type { FlowRunner } from "./types";

// ADR 0152 S2c: adoption of an untracked run (gate on) and the upgrade rescan.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const mk = (id: string) => step$({ id, name: id, toolId: id, ...io });
const taint = mk("taint");
const probe = mk("probe");

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
    await settle(await rt.start(id.startsWith("c") ? "g" : "f", input, { executionId: id }));
    return rt;
  };
  const finish = async (rt: WorkflowRuntime, id: string) => {
    const n = probes.length;
    if (id.startsWith("c")) await rt.resume(id, { eventType: "go", payload: { answer: "go" } });
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
    await (rt as unknown as { adoptSeenOrigins(v: ReplayVM): Promise<void> }).adoptSeenOrigins(vm);
    const after = reads.slice(before);
    expect(after.every(([from]) => from > 0)).toBe(true); // one anchor read at the memoized sequence, no history scan
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
      await (rt as unknown as { adoptSeenOrigins(v: ReplayVM): Promise<void> }).adoptSeenOrigins(
        vm
      );
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
});
