import { cpus, totalmem } from "node:os";
import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { ProfilingEventStore } from "@loom/event-runtime";
import { effectTimingMiddleware } from "@loom/middleware";
import {
  PostgresEventStore,
  PostgresSnapshotStore,
  migratePostgresStores,
} from "@loom/plugin-postgres";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { z } from "zod";
import { drive } from "./harness";

// ── Hardware comparison report ────────────────────────────────────────────────
//
// The numbers in docs/benchmarks.md were all captured on one dev laptop (Apple M2, 8 GB,
// loopback Postgres). That box cuts both ways and the net is genuinely unknown: loopback
// removes network round-trips (flattering), while a laptop's CPU and SSD are far weaker
// than a server's (understating). The only way to settle it is to run the same thing
// elsewhere.
//
// So this emits ONE self-describing markdown report — machine facts, database facts, and
// the four measurements that characterise a host — designed to be diffed against another
// host's output. It exists because "re-measure on your target hardware" is only honest
// advice if it is also a single command.
//
//   LOOM_TEST_POSTGRES_URL=postgres://… pnpm --filter @loom/bench-throughput hardware
//
// Deliberately NOT the full A–H suite: those characterise the *system*, this characterises
// the *host*, and it has to finish in minutes on a box you are paying for by the hour.

const PG_URL = process.env.LOOM_BENCH_POSTGRES_URL ?? process.env.LOOM_TEST_POSTGRES_URL;

const io = z.object({ i: z.number() });
const out = z.object({ ok: z.boolean() });
const PAYLOAD = { pad: "x".repeat(200) };

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listEnv(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

const fmt = (n: number, d = 0): string => n.toLocaleString("en-US", { maximumFractionDigits: d });

function benchFlow(steps: number, toolId: string): RegisteredFlow<{ i: number }, { ok: boolean }> {
  const defs = Array.from({ length: steps }, (_, k) =>
    step$({ id: `s${k}`, name: `s${k}`, toolId, inputSchema: io, outputSchema: out })
  );
  const runner: FlowRunner<{ i: number }, { ok: boolean }> = async (ctx, input) => {
    for (const d of defs) await ctx.run(d, { i: input.i });
    return { ok: true };
  };
  return {
    definition: flow$({
      id: `hw-${steps}-${toolId}`,
      name: "hw",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: out,
      steps: defs,
    }),
    runner,
  };
}

/** Run `executions` through a fresh runtime at `concurrency`, with an `effectMs` effect. */
async function runExecutions(
  pool: Pool,
  opts: { steps: number; effectMs: number; concurrency: number; executions: number }
) {
  const store = new ProfilingEventStore(new PostgresEventStore(pool));
  const timer = effectTimingMiddleware();
  // NOTE: middleware is the FIRST POSITIONAL argument. Passing `{ middleware }` is silently
  // ignored and every effect measures 0 ms — which is how this was first written.
  const effects = new EffectRuntime([timer.middleware]);
  effects.register(
    "work",
    new ToolEffect(async () => {
      if (opts.effectMs > 0) await new Promise((r) => setTimeout(r, opts.effectMs));
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new PostgresSnapshotStore(pool),
    effectRuntime: effects,
  });
  const flow = benchFlow(opts.steps, "work");
  runtime.registerFlow(flow.definition, flow.runner as FlowRunner<unknown, unknown>);

  const measured = await drive({
    label: "executions",
    concurrency: opts.concurrency,
    opsPerWorker: Math.max(1, Math.round(opts.executions / opts.concurrency)),
    warmupPerWorker: 1,
    op: async ({ global }) => {
      const handle = await runtime.start(flow, { i: global });
      await handle.waitForCompletion();
    },
  });
  return { measured, write: store.writeProfile(), effect: timer.profile() };
}

async function main(): Promise<void> {
  if (PG_URL === undefined) {
    console.log(
      "SKIP: the hardware report needs a real Postgres.\n" +
        "  LOOM_TEST_POSTGRES_URL=postgres://user@host/db pnpm --filter @loom/bench-throughput hardware"
    );
    return;
  }

  const pool = new Pool({ connectionString: PG_URL, max: intEnv("LOOM_BENCH_POOL_MAX", 100) });
  await migratePostgresStores(pool);

  const lines: string[] = [];
  const say = (s = ""): void => {
    lines.push(s);
  };

  // ── host + database facts ───────────────────────────────────────────────────
  // Without these a comparison is meaningless, and they are the first thing you lose
  // when numbers get copied between documents.
  const cpu = cpus();
  const { rows: ver } = await pool.query<{ version: string }>("SELECT version()");
  const settings = await pool.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings
     WHERE name IN ('shared_buffers','work_mem','max_connections','synchronous_commit','wal_level','fsync')
     ORDER BY name`
  );
  const { rows: rtt } = await pool.query<{ ms: number }>("SELECT 0 AS ms");
  void rtt;
  // Round-trip time separates a loopback database from a networked one — the single
  // biggest reason two hosts disagree.
  const rttStart = performance.now();
  for (let i = 0; i < 50; i++) await pool.query("SELECT 1");
  const rttMs = (performance.now() - rttStart) / 50;

  say("# Loom hardware report");
  say();
  say(`- node: ${process.version} · ${process.platform}/${process.arch}`);
  say(`- cpu: ${cpu[0]?.model ?? "unknown"} × ${cpu.length} logical`);
  say(`- memory: ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);
  say(`- postgres: ${ver[0]?.version ?? "unknown"}`);
  say(
    `- **db round-trip: ${rttMs.toFixed(3)} ms** (a loopback database is ≲0.1 ms; a networked one is not)`
  );
  for (const s of settings.rows) {
    say(`- pg.${s.name}: ${s.setting}${s.unit ?? ""}`);
  }
  say();

  const truncate = () => pool.query("TRUNCATE events, snapshots, fences");

  // ── 1. write ceiling vs concurrency ─────────────────────────────────────────
  say("## 1. Write path — where it saturates, and what concurrency buys past that");
  say();
  say("| concurrency | events/sec | p50 ms | p99 ms |");
  say("|---:|---:|---:|---:|");
  const writeConc = listEnv("LOOM_BENCH_HW_CONC", [8, 32, 128, 512]);
  const totalWrites = intEnv("LOOM_BENCH_HW_EVENTS", 12_000);
  let peakWrite = 0;
  for (const c of writeConc) {
    await truncate();
    const store = new PostgresEventStore(pool);
    const m = await drive({
      label: `append c=${c}`,
      concurrency: c,
      opsPerWorker: Math.max(1, Math.round(totalWrites / c)),
      warmupPerWorker: 2,
      op: ({ worker, n }) =>
        store.append({
          id: `hw-${c}-${worker}-${n}`,
          workflowId: "wf",
          executionId: `hw-${c}-${worker}`,
          eventType: "STEP_COMPLETED",
          sequence: n,
          timestamp: 1_700_000_000_000 + n,
          payload: PAYLOAD,
        }),
    });
    peakWrite = Math.max(peakWrite, m.opsPerSec);
    say(`| ${c} | ${fmt(m.opsPerSec)} | ${m.p50.toFixed(2)} | ${m.p99.toFixed(1)} |`);
  }
  say();
  say(`Peak sustained write throughput: **${fmt(peakWrite)} events/sec**.`);
  say();

  // ── 2. durable execution ceiling ────────────────────────────────────────────
  say("## 2. Durable executions — the ceiling, and whether it matches `writes ÷ events-per-exec`");
  say();
  say("| steps | events/exec | exec/sec | events/sec | predicted exec/sec |");
  say("|---:|---:|---:|---:|---:|");
  for (const steps of [1, 3]) {
    await truncate();
    const r = await runExecutions(pool, {
      steps,
      effectMs: 0,
      concurrency: intEnv("LOOM_BENCH_HW_EXEC_CONC", 64),
      executions: intEnv("LOOM_BENCH_HW_EXECS", 1500),
    });
    const perExec = 2 * steps + 2;
    say(
      `| ${steps} | ${perExec} | ${fmt(r.measured.opsPerSec)} | ${fmt(r.measured.opsPerSec * perExec)} | ` +
        `${fmt(peakWrite / perExec)} |`
    );
  }
  say();

  // ── 3. Little's Law efficiency with a realistic effect ──────────────────────
  say("## 3. Realistic effects — does execution concurrency scale?");
  say();
  say("1-step flow, 100 ms effect. Efficiency is against Little's Law (`concurrency ÷ latency`).");
  say();
  say("| concurrency | exec/sec | Little's Law | efficiency | p50 ms | p99 ms |");
  say("|---:|---:|---:|---:|---:|---:|");
  for (const c of listEnv("LOOM_BENCH_HW_EXEC_SWEEP", [32, 128, 512])) {
    await truncate();
    const r = await runExecutions(pool, {
      steps: 1,
      effectMs: 100,
      concurrency: c,
      executions: Math.max(200, c * 3),
    });
    const little = c / 0.1;
    say(
      `| ${c} | ${fmt(r.measured.opsPerSec)} | ${fmt(little)} | ` +
        `${((100 * r.measured.opsPerSec) / little).toFixed(0)}% | ` +
        `${r.measured.p50.toFixed(0)} | ${r.measured.p99.toFixed(0)} |`
    );
  }
  say();

  // ── 4. where the write/effect crossover sits ────────────────────────────────
  say("## 4. Write/effect crossover — which workloads are write-bound on this host");
  say();
  say("Share is of aggregate work time; ADR 0065 gate 1 asks exactly this question.");
  say();
  say("| effect latency | effect ms | write ms | write share | verdict |");
  say("|---:|---:|---:|---:|---|");
  for (const effectMs of listEnv("LOOM_BENCH_HW_EFFECTS", [0, 1, 5, 25])) {
    await truncate();
    const r = await runExecutions(pool, {
      steps: 1,
      effectMs,
      concurrency: 32,
      executions: effectMs >= 25 ? 200 : 600,
    });
    const share = r.write.totalWriteMs / (r.write.totalWriteMs + r.effect.totalEffectMs);
    say(
      `| ${effectMs} ms | ${fmt(r.effect.totalEffectMs)} | ${fmt(r.write.totalWriteMs)} | ` +
        `${(100 * share).toFixed(1)}% | ${share > 0.5 ? "**write-bound**" : "effect-bound"} |`
    );
  }
  say();
  say(
    "Where this flips is the number that matters: above it, batching the write path cannot " +
      "help however large the raw event rate looks."
  );

  await truncate();
  await pool.end();
  console.log(lines.join("\n"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
