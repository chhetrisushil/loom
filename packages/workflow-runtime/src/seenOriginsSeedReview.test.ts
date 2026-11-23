import { tainted } from "@loomwork/classify";
import { step$ } from "@loomwork/core";
import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import {
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  buildSegment,
  segmentDigest,
} from "@loomwork/event-runtime";
import { ReplayVM } from "@loomwork/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { settle } from "./__tests__/r2Harness";
import { LeaseLostError } from "./leaseKeeper";
import { type SeenOriginsMemo, adoptSeenOrigins } from "./seenOriginsSeed";

// ADR 0152 S2c (R17): endpoint-bound memo, segment trimming, coverage, lease loss, archive seal check, recorded-list branches.

const LIMITS = { maxOrigins: 64, maxScanNodes: 10_000 };
const env = (seq: number, eventType = "NOTE", payload: unknown = {}, metadata?: object) =>
  ({
    id: `u-${seq}`,
    executionId: "u",
    workflowId: "f",
    sequence: seq,
    eventType,
    payload,
    timestamp: seq,
    ...(metadata && { metadata }),
  }) as unknown as EventEnvelope;
const dec = (seq: number, origin: string, metadata?: object) =>
  env(
    seq,
    "DECISION_RECORDED",
    { decisionId: `d${seq}`, choice: { __loomTainted: { origin }, value: 1 } },
    metadata
  );
const vmAt = (sequence: number) =>
  new ReplayVM([], { executionId: "u", workflowId: "f", workflowVersion: "1", sequence } as never);
const store = (live: EventEnvelope[]) =>
  ({
    readRange: async (_: string, from: number, to: number) =>
      live.filter((e) => e.sequence >= from && e.sequence <= to),
  }) as unknown as EventStore;
const keyOf = (vm: ReplayVM) =>
  vm.peekState().variables._seenOrigins as {
    origins: string[];
    overflow?: true;
    through: number;
  };
const deps = (
  events: EventStore,
  memo = new Map<string, SeenOriginsMemo>(),
  archive?: unknown
) => ({
  enabled: true,
  limits: LIMITS,
  events,
  memo,
  ...(archive !== undefined && { archive: archive as unknown as never }),
});

describe("memo is bound to BOTH endpoints", () => {
  // log: 0 start, 1 tainted decision (o1), 2 note (= through of the memo), 3 note; the memo's key is a stale CLEAN one
  const log = [env(0, "EXECUTION_STARTED", { input: 1 }), dec(1, "o1"), env(2), env(3)];
  const memo = (e0: EventEnvelope, at: EventEnvelope): Map<string, SeenOriginsMemo> =>
    new Map([
      [
        "u",
        {
          key: { v: 1, limits: LIMITS, origins: [], through: 2 },
          e0: segmentDigest([e0]),
          at: segmentDigest([at]),
        },
      ],
    ]);
  it("a memo whose sequence 0 matches but whose envelope at through differs is a MISS (kills: binding e0 only)", async () => {
    const vm = vmAt(3);
    await adoptSeenOrigins(
      deps(store(log), memo(log[0] as never, env(2, "NOTE", { other: 1 }))),
      vm
    );
    expect(keyOf(vm).origins).toEqual(["o1"]); // rescanned, not the stale clean key
  });
  it("a memo whose envelope at through matches but whose sequence 0 differs is a MISS (kills: binding the at-T digest only)", async () => {
    const vm = vmAt(3);
    await adoptSeenOrigins(
      deps(store(log), memo(env(0, "EXECUTION_STARTED", { input: 2 }), log[2] as never)),
      vm
    );
    expect(keyOf(vm).origins).toEqual(["o1"]);
  });
  it("control: both endpoints equal is a HIT (the stale key folds only the tail)", async () => {
    const vm = vmAt(3);
    await adoptSeenOrigins(deps(store(log), memo(log[0] as never, log[2] as never)), vm);
    expect(keyOf(vm).origins).toEqual([]);
  });
});

describe("archive paging and coverage", () => {
  const all: EventEnvelope[] = [env(0, "EXECUTION_STARTED", { input: 1 })];
  for (let i = 1; i <= 15; i++) all.push(i === 4 ? dec(i, "o4") : env(i));
  const hdr = (from: number, through: number) => ({
    from,
    through,
    count: through - from + 1,
    digest: "d",
    incarnation: "i",
  });
  const archiveOf = (headers: ReturnType<typeof hdr>[], reads: Array<[number, number]> = []) =>
    ({
      headers: async () => headers,
      read: async (_: string, r: { from: number; through: number }) => {
        reads.push([r.from, r.through]);
        return all.filter((e) => e.sequence >= r.from && e.sequence <= r.through);
      },
    }) as never;

  it("a gap that starts and ends INSIDE segments feeds exactly the gap's events", async () => {
    // kills: reading whole segments (would double-feed 1,2 or overshoot to 10) or off-by-one trimming
    const reads: Array<[number, number]> = [];
    const live = all.filter((e) => e.sequence <= 2 || e.sequence >= 8); // 3..7 are archived
    const vm = vmAt(15);
    await adoptSeenOrigins(
      deps(store(live), new Map(), archiveOf([hdr(1, 5), hdr(6, 10), hdr(11, 15)], reads)),
      vm
    );
    expect(reads).toEqual([
      [3, 5],
      [6, 7],
    ]);
    expect(keyOf(vm)).toMatchObject({ origins: ["o4"], through: 15 });
    expect(keyOf(vm).overflow).toBeUndefined();
  });
  it("a hole between segments is a sticky overflow", async () => {
    // kills: treating an uncovered range as clean
    const vm = vmAt(15);
    await adoptSeenOrigins(
      deps(store([all[0] as never]), new Map(), archiveOf([hdr(1, 5), hdr(9, 15)])),
      vm
    );
    expect(keyOf(vm)).toMatchObject({ overflow: true, through: 15 });
  });
  it("an archive with no headers is a sticky overflow", async () => {
    const vm = vmAt(15);
    await adoptSeenOrigins(deps(store([all[0] as never]), new Map(), archiveOf([])), vm);
    expect(keyOf(vm)).toMatchObject({ overflow: true, through: 15 });
  });
});

describe("recorded lists on an unstamped run", () => {
  const start = env(0, "EXECUTION_STARTED", { input: 1 });
  const run = async (events: EventEnvelope[], memo = new Map<string, SeenOriginsMemo>()) => {
    const vm = vmAt(events.length - 1);
    await adoptSeenOrigins(deps(store(events), memo), vm);
    return keyOf(vm);
  };
  it("a recorded originsOverflow gives overflow", async () => {
    // kills: ignoring the live overflow flag
    const k = await run([
      start,
      env(1, "DECISION_RECORDED", { decisionId: "d", choice: 1 }, { originsOverflow: true }),
    ]);
    expect(k.overflow).toBe(true);
  });
  it("a non-array recorded origins gives overflow", async () => {
    // kills: treating a malformed record as absent
    const k = await run([
      start,
      env(1, "DECISION_RECORDED", { decisionId: "d", choice: 1 }, { origins: "x" }),
    ]);
    expect(k.overflow).toBe(true);
  });
  it("the scan path and the memo-tail path give identical keys for the same log", async () => {
    // kills: a rescan that ignores recorded lists, or a tail fold that diverges from it
    const log = [
      start,
      dec(1, "o1"),
      env(2),
      env(3, "DECISION_RECORDED", { decisionId: "d3", choice: 1 }, { origins: ["o2"] }),
      env(4, "DECISION_RECORDED", { decisionId: "d4", choice: 1 }, { origins: [] }),
    ];
    const scanned = await run(log);
    const memo = new Map<string, SeenOriginsMemo>();
    await adoptSeenOrigins(deps(store(log.slice(0, 3)), memo), vmAt(2));
    const tail = await run(log, memo);
    expect(scanned.origins).toEqual(["o1", "o2"]);
    expect(JSON.stringify(tail)).toBe(JSON.stringify(scanned));
  });
});

const io = { inputSchema: z.any(), outputSchema: z.any() };
const mk = (id: string) => step$({ id, name: id, toolId: id, ...io });
const taint = mk("taint");
const probe = mk("probe");

function rig(
  hb: Record<string, unknown> = {},
  store?: EventStore,
  shared?: { ev: InMemoryAsyncEventStore; snaps: InMemoryAsyncSnapshotStore }
) {
  const eventStore = shared?.ev ?? new InMemoryAsyncEventStore();
  const snapshotStore = shared?.snaps ?? new InMemoryAsyncSnapshotStore();
  const probes: unknown[] = [];
  const effects = new EffectRuntime();
  effects.register("taint", new ToolEffect(async (i: unknown) => tainted(i, "lineage:A")));
  effects.register(
    "probe",
    new ToolEffect(async (i: unknown) => {
      probes.push(i);
      return i;
    })
  );
  const rt = new WorkflowRuntime({
    eventStore: store ?? eventStore,
    snapshotStore,
    effectRuntime: effects,
    inboxEnabled: true,
    onWarn: () => {},
    ...hb,
  } as WorkflowRuntimeDeps);
  rt.registerFlow(
    {
      _tag: "FlowDefinition",
      id: "g",
      name: "g",
      version: "1.0.0",
      ...io,
      steps: [taint, probe],
    } as unknown as FlowDefinition<unknown, unknown>,
    async (ctx) => {
      await ctx.run(taint, "x");
      await ctx.suspend({ on: "go" });
      await ctx.run(probe, "p");
      return "done";
    }
  );
  return { rt, eventStore, snapshotStore, probes };
}

describe("lease loss and the archive seal check", () => {
  for (const site of ["resume", "migration"] as const) {
    it(`${site}: a lease that turns invalid during the rescan fails the call with LeaseLostError and runs no effect`, async () => {
      // kills: no lease check after adoption (the effect would run on a lost hold)
      const base = rig();
      await settle(await base.rt.start("g", "x", { executionId: `ll-${site}` }));
      const clock = { mono: 1_000, wall: 1_700_000_000_000 };
      const leases = new InMemoryLeaseStore({ now: () => clock.wall });
      const after: string[] = []; // store calls made once the hold was lost
      const spy = new Proxy(base.eventStore, {
        get(t, k, r) {
          if (k === "readRange") {
            return async (id: string, from: number, to: number) => {
              if (from === 0 && to > 0) {
                clock.mono += 100_000; // the rescan outlives the lease
                clock.wall += 100_000;
              }
              return t.readRange?.(id, from, to);
            };
          }
          const v = Reflect.get(t, k, r) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (clock.mono > 1_000) after.push(String(k));
            return (v as (...x: unknown[]) => unknown).apply(t, args);
          };
        },
      }) as EventStore;
      const r = rig(
        {
          seenOriginsEnabled: true,
          now: () => clock.wall,
          heartbeat: {
            leaseStore: leases,
            nodeId: "n1",
            incarnation: "i1",
            ttlMs: 30_000,
            monotonicNow: () => clock.mono,
            wallNow: () => clock.wall,
            every: () => () => {},
            after: () => () => {},
          },
        },
        spy,
        { ev: base.eventStore, snaps: base.snapshotStore }
      );
      const before = (await base.eventStore.read(`ll-${site}`)).length;
      const ev = { eventType: "go", payload: { answer: "go" } };
      const call =
        site === "resume"
          ? r.rt.resume(`ll-${site}`, ev)
          : r.rt.resumeAs(`ll-${site}`, "g", ev, {
              strategy: "operator-ack",
              system: true,
            } as never);
      await expect(call).rejects.toBeInstanceOf(LeaseLostError);
      expect(r.probes).toEqual([]);
      expect((await base.eventStore.read(`ll-${site}`)).length).toBe(before);
      expect(after).toEqual([]); // no store call once the hold was lost
    });
  }

  it("an archived batch carrying a seal marker this node cannot open adopts as sticky overflow", async () => {
    // kills: skipping assertStreamReadable on archived batches (the batch would be scanned as plain history)
    const w = rig();
    await settle(await w.rt.start("g", "x", { executionId: "sl" }));
    const log = await w.eventStore.read("sl");
    const state = (await w.rt.loadState("sl", w.rt.systemOptions())) as ExecutionState;
    const S = state.sequence;
    const middle = log
      .slice(1, S)
      .map((e, i) => (i === 0 ? { ...e, metadata: { ...e.metadata, seal: {} } } : e));
    const archive = new InMemoryArchiveStore();
    await archive.append("sl", buildSegment(middle, segmentDigest([log[0] as EventEnvelope])));
    await w.eventStore.truncatePrefix("sl", S - 1);
    const on = rig({ seenOriginsEnabled: true, compactionArchive: archive }, undefined, {
      ev: w.eventStore,
      snaps: w.snapshotStore,
    });
    const vm = new ReplayVM([], state);
    await (
      on.rt as unknown as { adoptSeenOrigins(v: ReplayVM, l: unknown): Promise<void> }
    ).adoptSeenOrigins(vm, { valid: () => true });
    expect(keyOf(vm)).toMatchObject({ overflow: true, through: S });
  });
});
