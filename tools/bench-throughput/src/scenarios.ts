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
