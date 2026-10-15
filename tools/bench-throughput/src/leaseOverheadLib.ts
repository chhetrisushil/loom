import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import type { EventStore, LeaseStore } from "@loom/event-runtime";
import {
  PostgresEventStore,
  PostgresLeaseStore,
  PostgresSnapshotStore,
} from "@loom/plugin-postgres";
import { SqliteEventStore, SqliteLeaseStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { z } from "zod";
import { drive } from "./harness";

// ── ADR 0130 D11 (Q8) cost gate: what does the heartbeat lease cost, eager vs lazy? ───────────────
//
// The same 1-step flow with heartbeat OFF, EAGER (a lease before every run's first append) and LAZY
// (the default since S7g: a run leases only once it outlives its grace, TTL/3 = 10 s here, so these
// short runs lease nothing). Defaults otherwise: ttl 30 s, renew every 10 s, real timers. Two shapes:
//
//   noop   the effect returns at once: the throughput CEILING, where every extra store round trip
//          shows (the gate: lease overhead <= 10% here, else fall back to lazy leasing)
//   io     the effect waits `ioMs` (a timer), the I/O-bound regime: the gate is that overhead is
//          NONE here, because the lease work overlaps the wait
//
// The modes are INTERLEAVED per repeat (the order rotates) and reduced to medians, so drift in machine
// load hits all sides alike. Single-process, loopback or in-memory: it prices the lease protocol's
// extra store calls, not network latency (a Postgres lease store adds a round trip per acquire/release batch).

const io = z.object({ i: z.number() });
const out = z.object({ ok: z.boolean() });

export type Backend = "memory" | "sqlite" | "postgres";
export type Shape = "noop" | "io";

export interface LeaseBenchConfig {
  backend: Backend;
  shape: Shape;
  concurrency: number;
  executions: number;
  ioMs: number;
  repeats: number;
  /** Required for the `postgres` backend: event, snapshot and lease stores all live here. */
  pgUrl?: string;
  /** `caller` (default): a caller-chosen executionId, which pays the durable sequence-0 bootstrap barrier; `minted`: the runtime mints the ulid. */
  ids?: "caller" | "minted";
}

export type LeaseMode = "off" | "eager" | "lazy";
const MODES: readonly LeaseMode[] = ["off", "eager", "lazy"];

export interface LeaseBenchRow {
  backend: Backend;
  shape: Shape;
  concurrency: number;
  executions: number;
  ioMs: number;
  /** Median executions/sec per mode. */
  off: number;
  eager: number;
  lazy: number;
  /** (off - mode) / off, in percent, of the medians. Positive = the lease costs throughput. */
  eagerOverheadPct: number;
  lazyOverheadPct: number;
  offSamples: number[];
  eagerSamples: number[];
  lazySamples: number[];
  /** Overhead % of each interleaved pair (same repeat) vs that repeat's OFF run, in repeat order. */
  eagerPairedPct: number[];
  lazyPairedPct: number[];
  /** Median / min / max of the paired overheads: the spread the medians-ratio hides. */
  eagerPairedMedianPct: number;
  eagerPairedMinPct: number;
  eagerPairedMaxPct: number;
  lazyPairedMedianPct: number;
  lazyPairedMinPct: number;
  lazyPairedMaxPct: number;
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

function makeFlow(): RegisteredFlow<{ i: number }, { ok: boolean }> {
  const work = step$({ id: "w", name: "w", toolId: "work", inputSchema: io, outputSchema: out });
  return {
    definition: flow$({
      id: "lease-bench",
      name: "lease-bench",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: out,
      steps: [work],
    }),
    runner: (async (ctx, input) => {
      await ctx.run(work, { i: input.i });
      return { ok: true };
    }) as FlowRunner<{ i: number }, { ok: boolean }>,
  };
}

interface Stores {
  events: EventStore;
  snaps: SnapshotStore;
  leases: LeaseStore;
  cleanup(): void;
  close?(): Promise<void>;
}

function makeStores(backend: Backend, pgUrl?: string): Stores {
  if (backend === "postgres") {
    if (pgUrl === undefined) throw new Error("the postgres backend needs pgUrl");
    // The pool max is 32 for OFF and ON alike, so the concurrency-256 cells are pool-bound as well as
    // write-bound (256 workers share 32 connections). pgUrl must name a THROWAWAY database: every run
    // leaves its event/snapshot/lease rows (and any tables the stores create) behind.
    // One pool for the event, snapshot and lease stores (the real deployment shape), the same size
    // for OFF and ON. Unique execution ids per run, so no truncation is needed between runs.
    const pool = new Pool({ connectionString: pgUrl, max: 32 });
    return {
      events: new PostgresEventStore(pool),
      snaps: new PostgresSnapshotStore(pool),
      leases: new PostgresLeaseStore(pool),
      cleanup() {},
      async close() {
        await pool.end();
      },
    };
  }
  if (backend === "memory")
    return {
      events: new InMemoryAsyncEventStore(),
      snaps: new InMemoryAsyncSnapshotStore(),
      leases: new InMemoryLeaseStore(),
      cleanup() {},
    };
  const dir = mkdtempSync(join(tmpdir(), "loom-lease-bench-"));
  return {
    events: new SqliteEventStore(join(dir, "events.db")),
    snaps: new SqliteSnapshotStore(join(dir, "snaps.db")),
    leases: new SqliteLeaseStore(join(dir, "leases.db")),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function once(cfg: LeaseBenchConfig, mode: LeaseMode, tag: string): Promise<number> {
  const stores = makeStores(cfg.backend, cfg.pgUrl);
  const effects = new EffectRuntime();
  effects.register(
    "work",
    new ToolEffect(async () => {
      if (cfg.shape === "io") await new Promise<void>((r) => setTimeout(r, cfg.ioMs));
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: stores.events as never,
    snapshotStore: stores.snaps,
    effectRuntime: effects,
    onWarn: () => {},
    ...(mode !== "off" && { heartbeat: { leaseStore: stores.leases, acquire: mode } }),
  });
  const flow = makeFlow();
  runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
  try {
    const m = await drive({
      label: `${cfg.backend}/${cfg.shape}/${mode}`,
      concurrency: cfg.concurrency,
      opsPerWorker: Math.max(1, Math.round(cfg.executions / cfg.concurrency)),
      warmupPerWorker: 2,
      op: async ({ global }) => {
        const h = await runtime.start(
          flow,
          { i: global },
          cfg.ids === "minted" ? undefined : { executionId: `${tag}-${global}` }
        );
        await h.waitForCompletion();
      },
    });
    return m.opsPerSec;
  } finally {
    await runtime.closeHeartbeat();
    await stores.close?.();
    stores.cleanup();
  }
}

/** Interleaved OFF/EAGER/LAZY repeats (the order rotates per repeat), reduced to medians. */
export async function measureLeaseOverhead(cfg: LeaseBenchConfig): Promise<LeaseBenchRow> {
  const samples: Record<LeaseMode, number[]> = { off: [], eager: [], lazy: [] };
  const prefix = `lb${Date.now().toString(36)}`;
  for (let r = 0; r < cfg.repeats; r++) {
    // Rotate which mode goes first so a systematic warm-up/cool-down effect cancels.
    const order = [...MODES.slice(r % 3), ...MODES.slice(0, r % 3)];
    for (const mode of order) samples[mode].push(await once(cfg, mode, `${prefix}-${r}-${mode}`));
  }
  const pairedOf = (mode: LeaseMode): number[] =>
    samples.off.map((o, i) => ((o - (samples[mode][i] as number)) / o) * 100);
  const eagerPaired = pairedOf("eager");
  const lazyPaired = pairedOf("lazy");
  const mOff = median(samples.off);
  const mEager = median(samples.eager);
  const mLazy = median(samples.lazy);
  return {
    backend: cfg.backend,
    shape: cfg.shape,
    concurrency: cfg.concurrency,
    // The executions actually run per side: opsPerWorker is rounded, so this is not always the config.
    executions: Math.max(1, Math.round(cfg.executions / cfg.concurrency)) * cfg.concurrency,
    ioMs: cfg.ioMs,
    off: mOff,
    eager: mEager,
    lazy: mLazy,
    eagerOverheadPct: ((mOff - mEager) / mOff) * 100,
    lazyOverheadPct: ((mOff - mLazy) / mOff) * 100,
    offSamples: samples.off,
    eagerSamples: samples.eager,
    lazySamples: samples.lazy,
    eagerPairedPct: eagerPaired,
    lazyPairedPct: lazyPaired,
    eagerPairedMedianPct: median(eagerPaired),
    eagerPairedMinPct: Math.min(...eagerPaired),
    eagerPairedMaxPct: Math.max(...eagerPaired),
    lazyPairedMedianPct: median(lazyPaired),
    lazyPairedMinPct: Math.min(...lazyPaired),
    lazyPairedMaxPct: Math.max(...lazyPaired),
  };
}
