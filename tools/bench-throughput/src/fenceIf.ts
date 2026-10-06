import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  PostgresEventStore,
  PostgresSnapshotStore,
  migratePostgresStores,
} from "@loom/plugin-postgres";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { z } from "zod";
import { drive } from "./harness";

// ── ADR 0118 acceptance: fenced vs unfenced executions, before/after R8k ─────────────────────
//
// R8k changes the Postgres append guard for ANSWERING events (a resume, a park, a terminal): it reads
// the fence row `FOR SHARE` so an in-flight `acquireFenceIf` and an answering append cannot both
// succeed, and a park also ensures a token-0 fence row. Non-answering appends are untouched. This
// measures what that costs on the shapes that matter:
//
//   unfenced  1-step execution, no fence (no fence row exists): the guard probes an absent row
//   fenced    the same, the execution holds a fence from the start: every guard finds the row
//   p-unf     park -> resume, unfenced           (answering: SUSPENDED, RESUMED, COMPLETED)
//   p-acq     park -> resume under acquireFence  (the pre-R8k way to fence a resume)
//   p-cond    park -> resume under fenceIfParkedAt (R8k; skipped where the option is not honoured)
//
//   LOOM_BENCH_BACKEND=memory|postgres  LOOM_TEST_POSTGRES_URL=postgres://…  node dist/fenceIf.js
//
// Run it on the commit BEFORE the Postgres guard change and on the one after, same database, and
// compare the rows. Numbers are medians of LOOM_BENCH_REPEATS runs (default 3).

const PG_URL = process.env.LOOM_BENCH_POSTGRES_URL ?? process.env.LOOM_TEST_POSTGRES_URL;
const BACKEND = process.env.LOOM_BENCH_BACKEND ?? (PG_URL !== undefined ? "postgres" : "memory");

const io = z.object({ i: z.number() });
const out = z.object({ ok: z.boolean() });

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function flows() {
  const work = step$({ id: "w", name: "w", toolId: "work", inputSchema: io, outputSchema: out });
  const plain: RegisteredFlow<{ i: number }, { ok: boolean }> = {
    definition: flow$({
      id: "plain",
      name: "plain",
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
  const parked: RegisteredFlow<{ i: number }, { ok: boolean }> = {
    definition: flow$({
      id: "parked",
      name: "parked",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: out,
      steps: [work],
    }),
    runner: (async (ctx, input) => {
      await ctx.suspend({ on: "GO" });
      await ctx.run(work, { i: input.i });
      return { ok: true };
    }) as FlowRunner<{ i: number }, { ok: boolean }>,
  };
  return { plain, parked };
}

interface Row {
  scenario: string;
  execPerSec: number;
  p50: number;
  p99: number;
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  let makeStore: () => {
    events: EventStore;
    snaps: PostgresSnapshotStore | InMemoryAsyncSnapshotStore;
  };
  if (BACKEND === "postgres") {
    if (PG_URL === undefined) {
      console.log("SKIP: set LOOM_TEST_POSTGRES_URL for the postgres backend");
      return;
    }
    pool = new Pool({ connectionString: PG_URL, max: intEnv("LOOM_BENCH_POOL_MAX", 100) });
    await migratePostgresStores(pool);
    const p = pool;
    makeStore = () => ({ events: new PostgresEventStore(p), snaps: new PostgresSnapshotStore(p) });
  } else {
    makeStore = () => ({
      events: new InMemoryAsyncEventStore(),
      snaps: new InMemoryAsyncSnapshotStore(),
    });
  }

  const concurrency = intEnv("LOOM_BENCH_CONC", 64);
  const executions = intEnv("LOOM_BENCH_EXECS", 3000);
  const repeats = intEnv("LOOM_BENCH_REPEATS", 3);
  const prefix = `fb${Date.now().toString(36)}`;
  let run = 0;

  async function once(scenario: string): Promise<Row | undefined> {
    if (pool !== undefined) await pool.query("TRUNCATE events, snapshots, fences");
    const { events, snaps } = makeStore();
    const effects = new EffectRuntime();
    effects.register("work", new ToolEffect(async () => ({ ok: true })));
    const runtime = new WorkflowRuntime({
      eventStore: events,
      snapshotStore: snaps,
      effectRuntime: effects,
    });
    const { plain, parked } = flows();
    runtime.registerFlow(plain.definition, plain.runner as FlowRunner<unknown, unknown>);
    runtime.registerFlow(parked.definition, parked.runner as FlowRunner<unknown, unknown>);
    const tag = `${prefix}-${run++}`;
    const m = await drive({
      label: scenario,
      concurrency,
      opsPerWorker: Math.max(1, Math.round(executions / concurrency)),
      warmupPerWorker: 2,
      op: async ({ global }) => {
        const id = `${tag}-${global}`;
        if (scenario === "unfenced" || scenario === "fenced") {
          const fence = scenario === "fenced" ? await events.acquireFence?.(id) : undefined;
          const h = await runtime.start(
            plain,
            { i: global },
            {
              executionId: id,
              ...(fence !== undefined && { fence }),
            }
          );
          await h.waitForCompletion();
          return;
        }
        const h = await runtime.start(parked, { i: global }, { executionId: id });
        await h.waitForSuspend();
        const go = { eventType: "GO", payload: {} };
        let resumed: Awaited<ReturnType<typeof runtime.resume>>;
        if (scenario === "p-unf") {
          resumed = await runtime.resume(id, go);
        } else if (scenario === "p-acq") {
          const fence = await events.acquireFence?.(id);
          resumed = await runtime.resume(id, go, { ...(fence !== undefined && { fence }) });
        } else {
          const parkSeq = await runtime.parkedAtSequence(id);
          // `as never`: the option does not exist on the pre-R8k runtime this is also built against.
          resumed = await runtime.resume(id, go, { fenceIfParkedAt: parkSeq } as never);
        }
        await resumed.waitForCompletion();
      },
    });
    return { scenario, execPerSec: m.opsPerSec, p50: m.p50, p99: m.p99 };
  }

  const scenarios = ["unfenced", "fenced", "p-unf", "p-acq", "p-cond"];
  const results = new Map<string, Row[]>();
  for (let r = 0; r < repeats; r++) {
    for (const s of scenarios) {
      const row = await once(s);
      if (row !== undefined) results.set(s, [...(results.get(s) ?? []), row]);
    }
  }
  const median = (xs: number[]): number =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  console.log(
    `backend=${BACKEND} concurrency=${concurrency} executions=${executions} repeats=${repeats}`
  );
  console.log("| scenario | exec/sec | p50 ms | p99 ms |");
  console.log("|---|---:|---:|---:|");
  for (const s of scenarios) {
    const rows = results.get(s);
    if (rows === undefined) continue;
    console.log(
      `| ${s} | ${Math.round(median(rows.map((r) => r.execPerSec))).toLocaleString("en-US")} | ${median(rows.map((r) => r.p50)).toFixed(2)} | ${median(rows.map((r) => r.p99)).toFixed(1)} |`
    );
  }
  if (pool !== undefined) {
    await pool.query("TRUNCATE events, snapshots, fences");
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
