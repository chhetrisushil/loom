import { type FlowDefinition, step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
  type LeaseStore,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { z } from "zod";

// ── Rig for the heartbeat-lease DST scenarios (ADR 0130 D11, S7f) ─────────────────────────────
//
// N "nodes" (runtimes with their own LeaseKeeper) over ONE event store and ONE lease store, a
// shared fake wall + monotonic clock, hand-driven keeper timers (no real time anywhere), and a
// flow whose middle step blocks on a per-execution gate. A `Probe` counts every ENTRY into a step
// (not the log: an entry whose completion never lands is exactly the double-entry we hunt).

export const TTL = 30_000;

const io = {
  inputSchema: z.object({ id: z.string(), n: z.number().optional() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
export const stepA = step$({ id: "a", name: "A", toolId: "tool-a", ...io });
export const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });
export const stepC = step$({ id: "c", name: "C", toolId: "tool-c", ...io });

export interface Deferred {
  promise: Promise<void>;
  open(): void;
}
export function deferred(): Deferred {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/**
 * Counts entries per `${execution}/${step}`. A DOUBLE ENTRY is an entry into a step while ANOTHER
 * driver that is still ENTITLED (alive and, if leased, inside its lease deadline) is inside the same
 * step. A stalled or crashed driver's in-flight effect is not entitled: re-entering after it is the
 * at-least-once window ADR 0004 already accepts, not a double entry.
 */
export class Probe {
  readonly entries = new Map<string, number>();
  private readonly inside = new Map<string, Set<() => boolean>>();
  /** Double entries observed (see the class comment). Every scenario asserts this is empty. */
  readonly doubleEntries: string[] = [];
  readonly gates = new Map<string, Deferred>();

  gate(executionId: string): Deferred {
    let g = this.gates.get(executionId);
    if (g === undefined) {
      g = deferred();
      this.gates.set(executionId, g);
    }
    return g;
  }
  count(executionId: string, step: string): number {
    return this.entries.get(`${executionId}/${step}`) ?? 0;
  }
  async around<T>(
    executionId: string,
    step: string,
    entitled: () => boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    const k = `${executionId}/${step}`;
    this.entries.set(k, (this.entries.get(k) ?? 0) + 1);
    let live = this.inside.get(k);
    if (live === undefined) {
      live = new Set();
      this.inside.set(k, live);
    }
    for (const other of live) if (other()) this.doubleEntries.push(k);
    live.add(entitled);
    try {
      return await fn();
    } finally {
      live.delete(entitled);
    }
  }
}

export interface Clock {
  mono: number;
  wall: number;
}

export interface Node {
  name: string;
  rt: WorkflowRuntime;
  /** False once the node "crashed": its effects stay in flight but it is no longer entitled to anything. */
  alive: boolean;
  /** Appends this node made without holding a live lease row for the stream (leased nodes only). */
  readonly unleasedAppends: string[];
  /** Run the node's keeper renew round once (the hand-driven timer). */
  tick(): Promise<void>;
  errors: unknown[];
}

export type In = { id: string; n?: number | undefined };

export interface Rig {
  clock: Clock;
  events: InMemoryAsyncEventStore;
  leases: InMemoryLeaseStore;
  /** The lease store's own clock runs `skew.ms` ahead of the nodes' wall clocks (default 0). */
  skew: { ms: number };
  /** The shared timer store the pollers (TimerService) drain; `refusalRow` seeds a D10 re-drive candidate. */
  timers: InMemoryTimerStore;
  /** Park a refusal row stamped at the execution's current head: the poll's re-drive candidate. */
  refusalRow(id: string): Promise<void>;
  probe: Probe;
  flow: RegisteredFlow<In, { ok: boolean }>;
  /** A flow that continues-as-new once (n=0 -> n=1), then runs step c. */
  rot: RegisteredFlow<In, { ok: boolean }>;
  /** Every lease-store and event-store call in order: "lease.acquire:<id>", "append:<id>:<type>", ... */
  timeline: string[];
  node(name: string, opts?: NodeOptions): Node;
  logOf(id: string): Promise<readonly EventEnvelope[]>;
}

export interface NodeOptions {
  leaseStore?: LeaseStore;
  eventStore?: EventStore;
  /** An unleased legacy node (no `heartbeat`). */
  legacy?: boolean;
  ttlMs?: number;
  /** Extra `heartbeat` options (e.g. `chunkSize`). */
  heartbeat?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export function rig(): Rig {
  const clock: Clock = { mono: 1_000, wall: 1_700_000_000_000 };
  const events = new InMemoryAsyncEventStore();
  const snapshots = new InMemoryAsyncSnapshotStore();
  const skew = { ms: 0 };
  const leases = new InMemoryLeaseStore({ now: () => clock.wall + skew.ms });
  // The in-memory store says `scope: "process"`; a fleet shares ONE store, so declare it cluster-visible
  // (what S7d's default re-drive on expired-lease evidence requires).
  Object.defineProperty(leases, "scope", { value: "cluster" });
  const timers = new InMemoryTimerStore();
  const probe = new Probe();
  const timeline: string[] = [];
  const recorded = recordLeases(leases, timeline);
  const definition: FlowDefinition<In, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "leased-dst",
    name: "leased-dst",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [stepA, stepB, stepC],
  };
  const runner: FlowRunner<In, { ok: boolean }> = async (ctx, input) => {
    await ctx.run(stepA, input);
    await ctx.run(stepB, input);
    return await ctx.run(stepC, input);
  };
  const flow = { definition, runner } as RegisteredFlow<In, { ok: boolean }>;
  const rotDef: FlowDefinition<In, { ok: boolean }> = {
    ...definition,
    id: "rot-dst",
    name: "rot-dst",
  };
  const rotRunner: FlowRunner<In, { ok: boolean }> = async (ctx, input) => {
    await ctx.run(stepA, input);
    if (input.n === undefined || input.n === 0)
      return ctx.continueAsNew({ id: input.id, n: 1 }) as never;
    return await ctx.run(stepC, input);
  };
  const rot = { definition: rotDef, runner: rotRunner } as RegisteredFlow<In, { ok: boolean }>;
  return {
    clock,
    events,
    leases,
    skew,
    timers,
    refusalRow: async (id) => {
      const head = (await events.head?.(id)) as number;
      await timers.schedule({ executionId: id, wakeAt: 1, refused: { head } });
    },
    probe,
    flow,
    rot,
    timeline,
    logOf: (id) => events.read(id),
    node(name, opts = {}) {
      const effects = new EffectRuntime();
      for (const [tool, step] of [
        ["tool-a", "a"],
        ["tool-b", "b"],
        ["tool-c", "c"],
      ] as const) {
        effects.register(
          tool,
          new ToolEffect(async (input: In) =>
            probe.around(
              input.id,
              step,
              () => entitled(input.id),
              async () => {
                if (step === "b") await probe.gate(input.id).promise;
                return { ok: true };
              }
            )
          )
        );
      }
      const errors: unknown[] = [];
      const unleasedAppends: string[] = [];
      const self: { node?: Node } = {};
      const entitled = (id: string): boolean =>
        self.node?.alive === true &&
        (opts.legacy === true || self.node.rt.leaseKeeper?.validNow(id) === true);
      const base = opts.eventStore ?? events;
      const audited =
        opts.legacy === true
          ? base
          : auditAppends({
              store: base,
              timeline,
              audit: (id) =>
                leases.get?.(id).then((row) => {
                  if (
                    row === null ||
                    row === undefined ||
                    row.owner !== `${name}:i1` ||
                    row.expiresAt <= clock.wall
                  )
                    unleasedAppends.push(id);
                }),
            });
      const rt = new WorkflowRuntime({
        eventStore: audited as never,
        snapshotStore: snapshots,
        effectRuntime: effects,
        onWarn: () => {},
        now: () => clock.wall,
        ...(opts.legacy === true
          ? {}
          : {
              heartbeat: {
                leaseStore: opts.leaseStore ?? recorded,
                nodeId: name,
                incarnation: "i1",
                ttlMs: opts.ttlMs ?? TTL,
                monotonicNow: () => clock.mono,
                wallNow: () => clock.wall,
                every: () => () => {},
                after: () => () => {},
                onError: (e: unknown) => errors.push(e),
                ...opts.heartbeat,
              },
            }),
        continueAsNewEnabled: true,
        ...opts.extra,
      } as never);
      rt.registerFlow(definition, runner);
      rt.registerFlow(rotDef, rotRunner);
      const node: Node = {
        name,
        rt,
        alive: true,
        errors,
        unleasedAppends,
        tick: async () => {
          if (node.alive) await rt.leaseKeeper?.tick();
        },
      };
      self.node = node;
      return node;
    },
  };
}

/** Advance both fake clocks together. */
export function advance(c: Clock, ms: number): void {
  c.mono += ms;
  c.wall += ms;
}

/** Let queued microtasks and the keeper's group-commit flushes settle (a bounded drain, no timers). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

/** Wait until `cond` holds (a CONDITION, never a fixed sleep). */
export async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`until: ${what} never held`);
}

/**
 * Wrap an event store so every append (single, batch, or conditional) first runs
 * `audit(executionId)`. Reserved `__loom_*` control streams are skipped. Everything else is forwarded.
 */
export function auditAppends(opts: {
  store: EventStore;
  timeline: string[];
  audit: (executionId: string) => Promise<void> | undefined;
}): EventStore {
  const { store, timeline, audit } = opts;
  const idsOf = (prop: string, args: unknown[]): string[] => {
    if (prop === "append") {
      const e = args[0] as EventEnvelope;
      timeline.push(`append:${e.executionId}:${e.eventType}`);
      return [e.executionId];
    }
    if (prop === "appendBatch") {
      for (const e of args[0] as EventEnvelope[])
        timeline.push(`append:${e.executionId}:${e.eventType}`);
      return [...new Set((args[0] as EventEnvelope[]).map((e) => e.executionId))];
    }
    if (prop === "appendIfUnchanged") return [args[0] as string];
    return [];
  };
  return new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (typeof prop === "string" && prop.startsWith("append")) {
        return async (...args: unknown[]) => {
          for (const id of idsOf(prop, args)) if (!id.startsWith("__loom_")) await audit(id);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return v.bind(target);
    },
  });
}

/** Record every acquire/release (single and batch) of a lease store on `timeline`. */
export function recordLeases(store: LeaseStore, timeline: string[]): LeaseStore {
  return new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const p = String(prop);
      if (p === "acquire" || p === "release") {
        return (...args: unknown[]) => {
          timeline.push(`lease.${p}:${String(args[0])}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (p === "acquireMany" || p === "releaseMany") {
        return (...args: unknown[]) => {
          for (const id of args[0] as string[])
            timeline.push(`lease.${p.replace("Many", "")}:${id}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return v.bind(target);
    },
  });
}

export type StoreMode =
  | "up"
  | "down"
  | "hang-renew"
  | "lose-renew-response"
  | "drop-release"
  | "lose-release-response";

/**
 * A lease store the test can break. `down`: every call rejects like a refused connection.
 * `hang-renew`: a renew never answers and is NOT applied; `lose-renew-response`: it IS applied, then never
 * answers (the caller crashes mid-renew). `drop-release`: a release
 * errors WITHOUT applying. `lose-release-response`: a release APPLIES, then errors (the reply is lost).
 */
export interface Flaky {
  store: LeaseStore;
  mode: StoreMode;
  /** Calls that reached this wrapper, by method. */
  calls: Map<string, number>;
}
export function flaky(inner: LeaseStore): Flaky {
  const calls = new Map<string, number>();
  const f: Flaky = { store: inner, mode: "up", calls };
  f.store = new Proxy(inner, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const p = String(prop);
      return async (...args: unknown[]) => {
        calls.set(p, (calls.get(p) ?? 0) + 1);
        const call = () => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        const refused = () =>
          Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
        if (f.mode === "down") throw refused();
        const isRenew = p === "renew" || p === "renewMany";
        const isRelease = p === "release" || p === "releaseMany";
        if (f.mode === "hang-renew" && isRenew) return new Promise(() => {});
        if (f.mode === "lose-renew-response" && isRenew) {
          await call();
          return new Promise(() => {});
        }
        if (f.mode === "drop-release" && isRelease) throw refused();
        if (f.mode === "lose-release-response" && isRelease) {
          await call();
          throw refused();
        }
        return call();
      };
    },
  });
  return f;
}
