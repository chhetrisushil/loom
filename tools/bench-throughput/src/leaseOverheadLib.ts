import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import type { EventStore, LeaseStore } from "@loom/event-runtime";
import { SqliteEventStore, SqliteLeaseStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { drive } from "./harness";

// ── ADR 0130 D11 (Q8) cost gate: what does the eager heartbeat lease cost? ────────────────────────
//
// The same 1-step flow, heartbeat OFF vs ON (defaults: ttl 30 s, renew every 10 s, real timers), on
// the in-memory stores and on SQLite files. Two shapes:
//
//   noop   the effect returns at once: the throughput CEILING, where every extra store round trip
//          shows (the gate: lease overhead <= 10% here, else fall back to lazy leasing)
//   io     the effect waits `ioMs` (a timer), the I/O-bound regime: the gate is that overhead is
//          NONE here, because the lease work overlaps the wait
//
// OFF and ON runs are INTERLEAVED per repeat and reduced to medians, so drift in machine load hits
// both sides alike. Single-process, loopback or in-memory: it prices the lease protocol's extra
// store calls, not network latency (a Postgres lease store adds a round trip per acquire/release batch).

const io = z.object({ i: z.number() });
const out = z.object({ ok: z.boolean() });

export type Backend = "memory" | "sqlite";
export type Shape = "noop" | "io";

export interface LeaseBenchConfig {
  backend: Backend;
  shape: Shape;
  concurrency: number;
  executions: number;
  ioMs: number;
  repeats: number;
}

export interface LeaseBenchRow {
  backend: Backend;
  shape: Shape;
  concurrency: number;
  executions: number;
  ioMs: number;
  /** Median executions/sec, heartbeat off then on. */
  off: number;
  on: number;
  /** (off - on) / off, in percent. Positive = the lease costs throughput. */
  overheadPct: number;
  offSamples: number[];
  onSamples: number[];
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
}

function makeStores(backend: Backend): Stores {
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

async function once(cfg: LeaseBenchConfig, heartbeat: boolean, tag: string): Promise<number> {
  const stores = makeStores(cfg.backend);
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
    ...(heartbeat && { heartbeat: { leaseStore: stores.leases } }),
  });
  const flow = makeFlow();
  runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
  try {
    const m = await drive({
      label: `${cfg.backend}/${cfg.shape}/${heartbeat ? "on" : "off"}`,
      concurrency: cfg.concurrency,
      opsPerWorker: Math.max(1, Math.round(cfg.executions / cfg.concurrency)),
      warmupPerWorker: 2,
      op: async ({ global }) => {
        const h = await runtime.start(flow, { i: global }, { executionId: `${tag}-${global}` });
        await h.waitForCompletion();
      },
    });
    return m.opsPerSec;
  } finally {
    await runtime.closeHeartbeat();
    stores.cleanup();
  }
}

/** Interleaved OFF/ON repeats, reduced to medians. */
export async function measureLeaseOverhead(cfg: LeaseBenchConfig): Promise<LeaseBenchRow> {
  const off: number[] = [];
  const on: number[] = [];
  const prefix = `lb${Date.now().toString(36)}`;
  for (let r = 0; r < cfg.repeats; r++) {
    // Alternate which side goes first so a systematic warm-up/cool-down effect cancels.
    const order = r % 2 === 0 ? [false, true] : [true, false];
    for (const hb of order) {
      const v = await once(cfg, hb, `${prefix}-${r}-${hb ? "on" : "off"}`);
      (hb ? on : off).push(v);
    }
  }
  const mOff = median(off);
  const mOn = median(on);
  return {
    backend: cfg.backend,
    shape: cfg.shape,
    concurrency: cfg.concurrency,
    executions: cfg.executions,
    ioMs: cfg.ioMs,
    off: mOff,
    on: mOn,
    overheadPct: ((mOff - mOn) / mOff) * 100,
    offSamples: off,
    onSamples: on,
  };
}
