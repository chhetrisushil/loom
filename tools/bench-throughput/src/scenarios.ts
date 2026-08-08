import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { NOTIFY_CHANNEL, PostgresEventStore, PostgresSnapshotStore } from "@loom/plugin-postgres";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { Client, type Pool } from "pg";
import { z } from "zod";
import { type Measurement, drive } from "./harness";

/**
 * Shared bench config. Every knob is env-overridable so a run can be scaled to the
 * host without editing code — see README.
 */
export interface BenchConfig {
  /** Concurrency levels swept by the append scenarios. */
  concurrencies: number[];
  /** Measured ops per worker (per concurrency level). */
  opsPerWorker: number;
  /** Unmeasured ops per worker before each measured phase. */
  warmupPerWorker: number;
  /** Approximate payload size in bytes — JSONB (de)serialization is on the hot path. */
  payloadBytes: number;
  /** Batch sizes swept by the batched-append counterfactual. */
  batchSizes: number[];
  /** Idle LISTEN connections attached in the notify fan-out variant. */
  listeners: number;
  /** Concurrency for the end-to-end execution + transient scenarios. */
  executionConcurrency: number;
  /** Measured executions per worker. */
  executionsPerWorker: number;
}

// A per-process tag so ids never collide with a previous run's rows (the events PK is
// `id`), even when the operator skips the truncate.
const RUN_TAG = `${process.pid}-${Date.now().toString(36)}`;

/** Build a payload of roughly `bytes` serialized size. */
function makePayload(bytes: number): Record<string, unknown> {
  const overhead = 64; // the fixed keys below, serialized
  const padLength = Math.max(0, bytes - overhead);
  return { stepId: "noop", ok: true, pad: "x".repeat(padLength) };
}

function envelope(
  executionId: string,
  sequence: number,
  payload: Record<string, unknown>
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "bench-flow",
    executionId,
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    payload,
  };
}

// ── A. Raw single append — the shipped write path ──────────────────────────────
//
// One `PostgresEventStore.append` per op. Worker w owns execution `w`, appending
// sequences 0,1,2,… serially — the real shape (one serial writer per execution, many
// executions concurrent). This is the floor every durable number below sits on.

export async function rawAppend(
  store: PostgresEventStore,
  cfg: BenchConfig,
  concurrency: number
): Promise<Measurement> {
  const payload = makePayload(cfg.payloadBytes);
  return drive({
    label: `append (shipped) · c=${concurrency}`,
    concurrency,
    opsPerWorker: cfg.opsPerWorker,
    warmupPerWorker: cfg.warmupPerWorker,
    op: ({ worker, n }) => store.append(envelope(`raw-${RUN_TAG}-${worker}`, n, payload)),
  });
}

// ── B. Batched append — the `appendBatch` counterfactual ────────────────────────
//
// What an OPTIONAL `appendBatch(envelopes[])` on the EventStore SPI would buy. Kept
// apples-to-apples with the shipped statement: same fence guard (one check per batch —
// every envelope in a journal flush belongs to ONE execution, so a single guard is
// correct) and one pg_notify for the batch tip instead of one per event. `jsonb_to_recordset`
// keeps it a single bind parameter and a single round-trip.
//
// This is NOT a shipped code path. It exists to size the win before anyone commits to
// the SPI change.

const BATCH_SQL = `
  WITH batch AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, workflow_id text, execution_id text, event_type text,
      "sequence" bigint, "timestamp" bigint, payload jsonb, metadata jsonb
    )
  ), ins AS (
    INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
    SELECT id, workflow_id, execution_id, event_type, "sequence", "timestamp", payload, metadata
    FROM batch
    WHERE COALESCE((SELECT fence FROM fences WHERE execution_id = $2), $3::bigint) <= $3::bigint
    RETURNING 1 AS one
  )
  SELECT pg_notify($4, $5) FROM ins LIMIT 1`;

export async function batchedAppend(
  pool: Pool,
  cfg: BenchConfig,
  concurrency: number,
  batchSize: number
): Promise<Measurement> {
  const payload = makePayload(cfg.payloadBytes);
  // Ops are scaled DOWN by the batch size so every batch level writes the same number
  // of EVENTS — otherwise a bigger batch would just be doing more work.
  const opsPerWorker = Math.max(1, Math.round(cfg.opsPerWorker / batchSize));
  return drive({
    label: `appendBatch (counterfactual) · b=${batchSize} · c=${concurrency}`,
    concurrency,
    opsPerWorker,
    warmupPerWorker: Math.max(1, Math.round(cfg.warmupPerWorker / batchSize)),
    unitsPerOp: batchSize,
    op: async ({ worker, n }) => {
      const executionId = `batch${batchSize}-${RUN_TAG}-${worker}`;
      const rows = new Array(batchSize);
      for (let k = 0; k < batchSize; k++) {
        const sequence = n * batchSize + k;
        rows[k] = {
          id: `${executionId}-${sequence}`,
          workflow_id: "bench-flow",
          execution_id: executionId,
          event_type: "STEP_COMPLETED",
          sequence,
          timestamp: 1_700_000_000_000 + sequence,
          payload,
          metadata: null,
        };
      }
      const tip = n * batchSize + batchSize - 1;
      await pool.query(BATCH_SQL, [
        JSON.stringify(rows),
        executionId,
        0,
        NOTIFY_CHANNEL,
        JSON.stringify(["bench", executionId, tip]),
      ]);
    },
  });
}

// ── C. pg_notify cost + LISTEN fan-out ────────────────────────────────────────
//
// Every shipped append fires a pg_notify on ONE global channel, and every subscribing
// node's listener connection receives EVERY event and filters client-side. Two costs to
// separate: the notify itself on the writer, and the fan-out as listeners are added.

// The shipped statement with the pg_notify CTE removed — everything else identical
// (same fence guard, same bind shape), so the delta is the notify and nothing else.
const NO_NOTIFY_SQL = `
  INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
  SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb
  WHERE COALESCE((SELECT fence FROM fences WHERE execution_id = $3), $9::bigint) <= $9::bigint`;

export async function appendWithoutNotify(
  pool: Pool,
  cfg: BenchConfig,
  concurrency: number
): Promise<Measurement> {
  const payloadJson = JSON.stringify(makePayload(cfg.payloadBytes));
  return drive({
    label: `append WITHOUT pg_notify · c=${concurrency}`,
    concurrency,
    opsPerWorker: cfg.opsPerWorker,
    warmupPerWorker: cfg.warmupPerWorker,
    op: async ({ worker, n }) => {
      const executionId = `nonotify-${RUN_TAG}-${worker}`;
      await pool.query(NO_NOTIFY_SQL, [
        `${executionId}-${n}`,
        "bench-flow",
        executionId,
        "STEP_COMPLETED",
        n,
        1_700_000_000_000 + n,
        payloadJson,
        null,
        0,
      ]);
    },
  });
}

/** Attach `count` idle LISTEN connections; returns a disposer. */
export async function attachListeners(
  connectionString: string,
  count: number
): Promise<{ received: () => number; close: () => Promise<void> }> {
  const clients: Client[] = new Array(count);
  let received = 0;
  for (let i = 0; i < count; i++) {
    const client = new Client({ connectionString });
    await client.connect();
    client.on("notification", () => {
      received++;
    });
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    clients[i] = client;
  }
  return {
    received: () => received,
    close: async () => {
      await Promise.all(clients.map((c) => c.end()));
    },
  };
}

// ── D. End-to-end durable executions ──────────────────────────────────────────
//
// The number that actually answers "QPS": a real WorkflowRuntime, a real flow, a no-op
// effect (so what is measured is kernel + store, not the tool's own work), against
// Postgres. Reported per EXECUTION; the events/sec column is the same run counted in
// envelopes, which is what the store sees.

const noopSchema = z.object({ i: z.number() });

function benchStep(id: string) {
  return step$({
    id,
    name: id,
    toolId: "noop-tool",
    inputSchema: noopSchema,
    outputSchema: z.object({ ok: z.boolean() }),
  });
}

/** A flow with `stepCount` sequential steps. Events per execution = 2*stepCount + 2. */
export function benchFlow(stepCount: number): RegisteredFlow<{ i: number }, { ok: boolean }> {
  const steps = Array.from({ length: stepCount }, (_, k) => benchStep(`s${k}`));
  const runner: FlowRunner<{ i: number }, { ok: boolean }> = async (ctx, input) => {
    for (const step of steps) await ctx.run(step, { i: input.i });
    return { ok: true };
  };
  return {
    definition: flow$({
      id: `bench-flow-${stepCount}`,
      name: `Bench Flow (${stepCount} steps)`,
      version: "1.0.0",
      inputSchema: noopSchema,
      outputSchema: z.object({ ok: z.boolean() }),
      steps,
    }),
    runner,
  };
}

export interface RuntimeBundle {
  runtime: WorkflowRuntime;
  eventStore: PostgresEventStore;
  snapshotStore: PostgresSnapshotStore;
  close: () => Promise<void>;
}

export function makeRuntime(pool: Pool, snapshotEvery?: number): RuntimeBundle {
  const eventStore = new PostgresEventStore(pool);
  const snapshotStore = new PostgresSnapshotStore(pool);
  const effectRuntime = new EffectRuntime();
  // No `mode` declared, so the same tool serves both the durable seam (scenario D) and
  // the ambient/transient seam (scenario E) — the comparison is like-for-like.
  effectRuntime.register("noop-tool", new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime,
    ...(snapshotEvery !== undefined && { snapshotEvery }),
  });
  return {
    runtime,
    eventStore,
    snapshotStore,
    close: async () => {
      await eventStore.close();
    },
  };
}

export async function durableExecutions(
  bundle: RuntimeBundle,
  cfg: BenchConfig,
  stepCount: number
): Promise<Measurement> {
  const flow = benchFlow(stepCount);
  bundle.runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
  const eventsPerExecution = 2 * stepCount + 2;
  return drive({
    label: `runtime.start → completion · ${stepCount} step(s) · c=${cfg.executionConcurrency}`,
    concurrency: cfg.executionConcurrency,
    opsPerWorker: cfg.executionsPerWorker,
    warmupPerWorker: Math.max(1, Math.round(cfg.executionsPerWorker / 10)),
    unitsPerOp: eventsPerExecution,
    op: async ({ global }) => {
      const handle = await bundle.runtime.start(flow, { i: global });
      await handle.waitForCompletion();
    },
  });
}

// ── E. Transient invocation — the zero-write ceiling ──────────────────────────
//
// `invokeTransient` holds no event store, no journal, no fence (ADR 0066 D2/R1): zero
// envelopes by construction. Same runtime, same registered tool, same concurrency —
// so the gap between this and scenario D is exactly what durability costs.

export async function transientInvocations(
  bundle: RuntimeBundle,
  cfg: BenchConfig
): Promise<Measurement> {
  return drive({
    label: `runtime.invokeTransient · c=${cfg.executionConcurrency}`,
    concurrency: cfg.executionConcurrency,
    opsPerWorker: cfg.executionsPerWorker,
    warmupPerWorker: Math.max(1, Math.round(cfg.executionsPerWorker / 10)),
    op: async ({ global }) => {
      await bundle.runtime.invokeTransient("noop-tool", { i: global });
    },
  });
}

// ── F. Read path — loadState over snapshotted executions ──────────────────────
//
// Whether snapshots bound the READ, not just the fold. `foldState` folds
// snapshot + bounded tail; the question this answers is whether cost stays flat as the
// log grows behind that snapshot. Sweeping step count with `snapshotEvery` fixed is the
// experiment: if reads are bounded, throughput is roughly flat across log lengths; if the
// whole log is being read, it falls off linearly.
//
// Seeded with real runs (not synthetic rows) so snapshot placement is whatever the
// runtime's own cadence produces.

/** Seed `count` completed executions of `stepCount` steps; returns their ids. */
async function seedExecutions(
  bundle: RuntimeBundle,
  stepCount: number,
  count: number
): Promise<string[]> {
  const flow = benchFlow(stepCount);
  bundle.runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);
  const ids: string[] = new Array(count);
  // Bounded fan-out so seeding does not itself saturate the pool.
  const LANES = 16;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, count) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= count) return;
        const handle = await bundle.runtime.start(flow, { i });
        await handle.waitForCompletion();
        ids[i] = handle.executionId;
      }
    })
  );
  return ids;
}

export async function readPath(
  bundle: RuntimeBundle,
  cfg: BenchConfig,
  stepCount: number
): Promise<Measurement> {
  const eventsPerExecution = 2 * stepCount + 2;
  // One execution per worker so concurrent reads do not all hit the same row set (which
  // would measure the page cache rather than the read path).
  const ids = await seedExecutions(bundle, stepCount, cfg.executionConcurrency);
  return drive({
    label: `runtime.loadState · ${stepCount} step(s) = ${eventsPerExecution} events · c=${cfg.executionConcurrency}`,
    concurrency: cfg.executionConcurrency,
    opsPerWorker: cfg.executionsPerWorker,
    warmupPerWorker: Math.max(1, Math.round(cfg.executionsPerWorker / 10)),
    op: async ({ worker }) => {
      await bundle.runtime.loadState(ids[worker] as string);
    },
  });
}

// ── G. Cross-execution coalescing, with PER-ROW fencing ───────────────────────
//
// The gap scenario B leaves open. B batches 16 events of ONE execution, so one fence
// check covers the batch — but `ExecutionJournal` is per-execution and a short flow never
// has 16 envelopes pending, so B's headline is unreachable from the journal (see
// docs/scaling.md 3.3). The only shape that CAN fill a batch is a store-level coalescer
// merging appends across many concurrent executions.
//
// That shape cannot use B's single guard: rows belong to different executions, so each
// needs its own fence check — a join against `fences` instead of one scalar subquery.
// This measures what that costs, which is the number the guide records as unknown.
//
// Two fence populations, because the codebase's G2 guarantee is that executions which
// never fence pay nothing:
//   - unfenced: no `fences` rows, the LEFT JOIN matches nothing (the cheap case)
//   - fenced:   every execution has a fence row, so the join does real work (the honest
//               worst case for a fencing deployment)
//
// One pg_notify per DISTINCT execution in the batch, not one per batch — a cross-execution
// flush has to wake every execution's subscribers, and pretending otherwise would flatter
// the result.

const CROSS_BATCH_SQL = `
  WITH batch AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, workflow_id text, execution_id text, event_type text,
      "sequence" bigint, "timestamp" bigint, payload jsonb, metadata jsonb, fence bigint
    )
  ), ins AS (
    INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
    SELECT b.id, b.workflow_id, b.execution_id, b.event_type, b."sequence", b."timestamp",
           b.payload, b.metadata
    FROM batch b
    LEFT JOIN fences f ON f.execution_id = b.execution_id
    WHERE COALESCE(f.fence, b.fence) <= b.fence
    RETURNING execution_id, sequence
  ), tips AS (
    SELECT execution_id, MAX(sequence) AS tip FROM ins GROUP BY execution_id
  )
  SELECT pg_notify($2, json_build_array($3::text, execution_id, tip)::text) FROM tips`;

export interface CrossBatchOptions {
  batchSize: number;
  /** Give every execution a `fences` row, so the per-row join actually matches. */
  fenced: boolean;
}

/** Pre-create fence rows for the executions a fenced run will write to. */
async function seedFences(pool: Pool, executionIds: string[]): Promise<void> {
  if (executionIds.length === 0) return;
  await pool.query(
    `INSERT INTO fences (execution_id, fence)
     SELECT unnest($1::text[]), 1
     ON CONFLICT (execution_id) DO UPDATE SET fence = 1`,
    [executionIds]
  );
}

export async function crossExecutionBatch(
  pool: Pool,
  cfg: BenchConfig,
  concurrency: number,
  opts: CrossBatchOptions
): Promise<Measurement> {
  const { batchSize, fenced } = opts;
  const payload = makePayload(cfg.payloadBytes);
  const opsPerWorker = Math.max(1, Math.round(cfg.opsPerWorker / batchSize));
  const tag = `${fenced ? "gf" : "gu"}${batchSize}-${RUN_TAG}`;
  // Execution ids are fixed up front so fences can be seeded for exactly this set.
  const idsFor = (worker: number): string[] =>
    Array.from({ length: batchSize }, (_, k) => `${tag}-${worker}-${k}`);
  if (fenced) {
    const all: string[] = [];
    for (let w = 0; w < concurrency; w++) all.push(...idsFor(w));
    await seedFences(pool, all);
  }
  // The envelope's own token. Matches the seeded fence so rows are accepted; an unfenced
  // run carries 0 and the COALESCE falls through to it.
  const fenceToken = fenced ? 1 : 0;
  return drive({
    label: `cross-exec batch · b=${batchSize} · ${fenced ? "fenced" : "unfenced"} · c=${concurrency}`,
    concurrency,
    opsPerWorker,
    warmupPerWorker: Math.max(1, Math.round(cfg.warmupPerWorker / batchSize)),
    unitsPerOp: batchSize,
    op: async ({ worker, n }) => {
      const ids = idsFor(worker);
      // One row per DISTINCT execution — the real coalescer shape: at concurrency C each
      // of C journals contributes its single pending envelope to the flush.
      const rows = ids.map((executionId) => ({
        id: `${executionId}-${n}`,
        workflow_id: "bench-flow",
        execution_id: executionId,
        event_type: "STEP_COMPLETED",
        sequence: n,
        timestamp: 1_700_000_000_000 + n,
        payload,
        metadata: null,
        fence: fenceToken,
      }));
      await pool.query(CROSS_BATCH_SQL, [JSON.stringify(rows), NOTIFY_CHANNEL, "bench"]);
    },
  });
}

// ── H. Multi-node fan-out, with REAL subscriber processes ─────────────────────
//
// Scenario C approximates fan-out with idle LISTEN connections inside the bench's own
// process. That captures the notification traffic but not what a node actually does with
// it: a real subscriber holds a PostgresEventStore, and `onNotify` issues a SELECT per
// delivered notification to fetch the row. This spawns genuine processes running the real
// store, so the writer faces a realistic multi-node load and the per-event read
// amplification is included rather than assumed.

export interface SubscriberNodes {
  /** Total notifications delivered across all nodes, once stopped. */
  stop: () => Promise<{ delivered: number; nodes: number }>;
}

/**
 * Fork `count` subscriber processes, each subscribing to every id in `executionIds`.
 * Resolves once all of them report ready, so no node misses events the writer emits.
 */
export async function spawnSubscriberNodes(
  pgUrl: string,
  count: number,
  executionIds: string[]
): Promise<SubscriberNodes> {
  if (count === 0) {
    return { stop: async () => ({ delivered: 0, nodes: 0 }) };
  }
  // Sibling of this module in dist/ — the child is compiled alongside it.
  const childPath = join(__dirname, "subscriberChild.js");
  const children: ChildProcess[] = [];
  await Promise.all(
    Array.from({ length: count }, () => {
      const child = fork(childPath, [pgUrl, executionIds.join(",")], { stdio: "inherit" });
      children.push(child);
      return new Promise<void>((resolve, reject) => {
        child.once("message", (msg: { type?: string }) => {
          if (msg?.type === "ready") resolve();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) reject(new Error(`subscriber node exited early with code ${code}`));
        });
      });
    })
  );

  return {
    stop: async () => {
      const reports = await Promise.all(
        children.map(
          (child) =>
            new Promise<number>((resolve) => {
              child.once("message", (msg: { type?: string; delivered?: number }) => {
                if (msg?.type === "report") resolve(msg.delivered ?? 0);
              });
              // Never hang the bench on a wedged child.
              const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve(0);
              }, 10_000);
              child.once("exit", () => clearTimeout(timer));
              child.send({ type: "stop" });
            })
        )
      );
      return { delivered: reports.reduce((a, b) => a + b, 0), nodes: children.length };
    },
  };
}

/**
 * Append to `concurrency` executions while `nodes` real subscriber processes watch them,
 * and report the writer's throughput. Returns the ids written to so the caller can hand
 * the same set to {@link spawnSubscriberNodes} beforehand.
 */
export function subscribedExecutionIds(concurrency: number, tag: string): string[] {
  return Array.from({ length: concurrency }, (_, w) => `h-${tag}-${RUN_TAG}-${w}`);
}

export async function appendWatched(
  store: PostgresEventStore,
  cfg: BenchConfig,
  concurrency: number,
  ids: string[],
  label: string
): Promise<Measurement> {
  const payload = makePayload(cfg.payloadBytes);
  return drive({
    label,
    concurrency,
    opsPerWorker: cfg.opsPerWorker,
    warmupPerWorker: cfg.warmupPerWorker,
    op: ({ worker, n }) => store.append(envelope(ids[worker] as string, n, payload)),
  });
}
