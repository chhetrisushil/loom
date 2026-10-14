import {
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "../WorkflowRuntime";
import type { HeartbeatOptions } from "../driverLease";
import { Latch, build, flow, slow, until } from "./r2Harness";

// A rig for ADR 0130 D11 slice S7d (the consumers of heartbeat leases): ONE log + ONE timer store +
// ONE lease store shared by several nodes, with a hand-driven clock for every lease timer so nothing
// here waits on wall time. Node A drives an execution and is stuck inside a latched step; the other
// nodes are pollers/sweepers over the same stores.

export interface RigClock {
  /** Wall clock the lease store stamps and judges on, and every keeper's wall anchor. */
  wall: number;
  /** Every keeper's monotonic clock. */
  mono: number;
}

export type Scope = "cluster" | "process";

/** An `InMemoryLeaseStore` that declares `scope` (the in-memory one says `"process"`). */
export function leaseStoreWith(scope: Scope, clock: RigClock): InMemoryLeaseStore {
  const store = new InMemoryLeaseStore({ now: () => clock.wall });
  Object.defineProperty(store, "scope", { value: scope });
  return store;
}

export const TTL = 30_000;

/** Heartbeat deps with every timer inert: only `keeper.tick()` renews, only the rig clock moves time. */
export function heartbeatFor(
  nodeId: string,
  store: InMemoryLeaseStore,
  clock: RigClock,
  extra: Partial<HeartbeatOptions> = {}
): HeartbeatOptions {
  return {
    leaseStore: store,
    nodeId,
    incarnation: "i1",
    ttlMs: TTL,
    monotonicNow: () => clock.mono,
    wallNow: () => clock.wall,
    every: () => () => {},
    after: () => () => {},
    ...extra,
  };
}

/** The flow: one latched step (`slow`), the probe for a double drive. */
export const h = flow("h", async (ctx) => {
  await ctx.run(slow, {});
  return { ok: true };
});

export interface Stuck {
  clock: RigClock;
  raw: { eventStore: InMemoryAsyncEventStore; timers: InMemoryTimerStore };
  leases: InMemoryLeaseStore;
  e: string;
  a: ReturnType<typeof build>;
  latchA: Latch;
  /** A's handle (its run is blocked in the latched step). */
  aHandle: Awaited<ReturnType<WorkflowRuntime["start"]>>;
  /** While `on`, A's lease store throws on renew (a lease-store outage that spares the event store). */
  outage: { on: boolean };
  /** A refusal row at the current head: the poll's re-drive candidate. */
  rowHead: number;
  /** Build another node over the same stores. */
  node(
    nodeId: string,
    over?: { heartbeat?: Partial<HeartbeatOptions> | null; eventStore?: EventStore; latch?: Latch }
  ): ReturnType<typeof build>;
  count(kind: string): Promise<number>;
  rows(): Promise<Array<{ executionId: string; wakeAt: number }>>;
}

let seq = 0;

/**
 * Node A starts `h` and blocks inside the `slow` step (its lease, if any, is held and NOT renewed:
 * A's keeper has no timer). A refusal row stamped at the head waits in the timer store.
 */
export async function stuck(
  opts: {
    scope?: Scope;
    /** A's heartbeat: `null` = a legacy node with no keeper. */
    aHeartbeat?: Partial<HeartbeatOptions> | null;
    executionId?: string;
  } = {}
): Promise<Stuck> {
  const clock: RigClock = { wall: 1_700_000_000_000, mono: 1_000 };
  const raw = { eventStore: new InMemoryAsyncEventStore(), timers: new InMemoryTimerStore() };
  const leases = leaseStoreWith(opts.scope ?? "cluster", clock);
  const latchA = new Latch();
  const e = opts.executionId ?? `s7d-${++seq}-${Math.random().toString(36).slice(2, 6)}`;
  const outage = { on: false };
  const aStore = Object.create(leases) as InMemoryLeaseStore;
  aStore.renew = async (...args) => {
    if (outage.on) throw new Error("lease store outage");
    return leases.renew(...args);
  };
  aStore.renewMany = async (...args) => {
    if (outage.on) throw new Error("lease store outage");
    return (await leases.renewMany?.(...args)) ?? [];
  };
  const nodeDeps = (nodeId: string, hb: Partial<HeartbeatOptions> | null | undefined) =>
    hb === null ? {} : { heartbeat: heartbeatFor(nodeId, leases, clock, hb ?? {}) };
  const node: Stuck["node"] = (nodeId, over = {}) => {
    const n = build(nodeDeps(nodeId, over.heartbeat === undefined ? {} : over.heartbeat), {
      ...raw,
      ...(over.eventStore !== undefined && { eventStore: over.eventStore }),
      ...(over.latch !== undefined && { latch: over.latch }),
    });
    n.rt.registerFlow(h.definition, h.runner);
    return n;
  };
  const a = node("a", {
    heartbeat: opts.aHeartbeat === null ? null : { leaseStore: aStore, ...(opts.aHeartbeat ?? {}) },
    latch: latchA,
  });
  const aHandle = await a.rt.start(h, {}, { executionId: e });
  await latchA.entered;
  await until(async () =>
    (await raw.eventStore.read(e)).some((x) => x.eventType === "STEP_STARTED")
  );
  const rowHead = (await raw.eventStore.head?.(e)) as number;
  await raw.timers.schedule({ executionId: e, wakeAt: 1, refused: { head: rowHead } });
  return {
    clock,
    raw,
    leases,
    e,
    a,
    latchA,
    aHandle,
    outage,
    rowHead,
    node,
    count: async (kind) =>
      (await raw.eventStore.read(e)).filter((x) => x.eventType === kind).length,
    rows: async () =>
      (await raw.timers.due(Number.MAX_SAFE_INTEGER)).filter((r) => r.executionId === e),
  };
}

/** Far enough ahead that every held refusal row is due again. */
export const FAR = Number.MAX_SAFE_INTEGER / 2;

/** Count calls of `rt.resume`. */
export function countResumes(rt: WorkflowRuntime): { n: number } {
  const counter = { n: 0 };
  const real = rt.resume.bind(rt) as (...a: unknown[]) => unknown;
  rt.resume = ((...a: unknown[]) => {
    counter.n++;
    return real(...a);
  }) as never;
  return counter;
}
