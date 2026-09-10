import { migratePostgresStores } from "@loom/plugin-postgres";
import { Pool } from "pg";
import type { Measurement } from "./harness";
import {
  type BenchConfig,
  appendWatched,
  appendWithoutNotify,
  attachListeners,
  batchedAppend,
  coalescedAppend,
  crossExecutionBatch,
  durableExecutions,
  makeRuntime,
  rawAppend,
  readPath,
  spawnSubscriberNodes,
  subscribedExecutionIds,
  transientInvocations,
} from "./scenarios";

// Reuses the same env var the Postgres store's integration tests are gated on, so one
// database serves both. LOOM_BENCH_POSTGRES_URL overrides when you want the bench
// pointed somewhere else (a tuned box) than the test database.
const PG_URL = process.env.LOOM_BENCH_POSTGRES_URL ?? process.env.LOOM_TEST_POSTGRES_URL;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

const cfg: BenchConfig = {
  concurrencies: listEnv("LOOM_BENCH_CONCURRENCIES", [1, 8, 32, 128]),
  opsPerWorker: intEnv("LOOM_BENCH_OPS", 200),
  warmupPerWorker: intEnv("LOOM_BENCH_WARMUP", 20),
  payloadBytes: intEnv("LOOM_BENCH_PAYLOAD_BYTES", 256),
  batchSizes: listEnv("LOOM_BENCH_BATCHES", [1, 4, 16, 64]),
  listeners: intEnv("LOOM_BENCH_LISTENERS", 16),
  executionConcurrency: intEnv("LOOM_BENCH_EXEC_CONCURRENCY", 64),
  executionsPerWorker: intEnv("LOOM_BENCH_EXECS", 40),
};

const TABLES =
  "events, snapshots, refs, lineage, fences, timers, durable_state, read_model_rows, read_model_watermarks";

function fmt(n: number, digits = 1): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function table(rows: Measurement[], unitName: string): string {
  const header = `| scenario | conc | ops | ops/sec | ${unitName}/sec | p50 ms | p95 ms | p99 ms | max ms |`;
  const sep = "|---|---:|---:|---:|---:|---:|---:|---:|---:|";
  const body = rows.map(
    (m) =>
      `| ${m.label} | ${m.concurrency} | ${m.ops} | ${fmt(m.opsPerSec)} | ${fmt(m.unitsPerSec)} | ` +
      `${fmt(m.p50, 2)} | ${fmt(m.p95, 2)} | ${fmt(m.p99, 2)} | ${fmt(m.max, 2)} |`
  );
  return [header, sep, ...body].join("\n");
}

/**
 * Best measurement in a set, ranked by UNITS/sec (events), not ops/sec. Ranking by ops
 * would pick the smallest batch size every time — a batch of 1 always wins on
 * round-trips/sec while losing badly on the throughput that actually matters.
 */
function best(rows: Measurement[]): Measurement | undefined {
  let top: Measurement | undefined;
  for (const m of rows) if (top === undefined || m.unitsPerSec > top.unitsPerSec) top = m;
  return top;
}

/** Node/process count needed to reach `target`, never rounding a real requirement to 0. */
function nodesFor(target: number, perNode: number): number {
  if (!Number.isFinite(perNode) || perNode <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(target / perNode));
}

async function main(): Promise<void> {
  if (PG_URL === undefined) {
    console.log(
      "SKIP: throughput bench needs a real Postgres.\n" +
        "  Set LOOM_TEST_POSTGRES_URL (or LOOM_BENCH_POSTGRES_URL), e.g.\n" +
        "    docker run --rm -d -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust --name loom-bench postgres:16\n" +
        "    LOOM_TEST_POSTGRES_URL=postgres://postgres@localhost:55432/postgres pnpm --filter @loom/bench-throughput bench"
    );
    return;
  }

  // One pool shared by every scenario and store, sized above the highest concurrency —
  // otherwise the pool's default max (10) becomes the bottleneck and the bench measures
  // queueing rather than the database.
  const maxConcurrency = Math.max(
    ...cfg.concurrencies,
    cfg.executionConcurrency,
    cfg.listeners + 1
  );
  const pool = new Pool({ connectionString: PG_URL, max: maxConcurrency + 8 });
  const truncate = () => pool.query(`TRUNCATE ${TABLES}`);
  const countEvents = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM events");
    return Number(rows[0]?.n ?? 0);
  };

  const sections: string[] = [];
  const { rows: versionRows } = await pool.query<{ version: string }>("SELECT version()");
  // Migrate ONCE, serially, before any store is constructed. Each Postgres store kicks
  // off `migrate(pool)` from its own constructor, and `CREATE TABLE IF NOT EXISTS` is
  // NOT atomic in Postgres — two of them racing on a shared pool can both pass the
  // catalog check and one then fails on pg_type_typname_nsp_index. Running it to
  // completion first makes every constructor's copy a no-op.
  await migratePostgresStores(pool);
  const bundle = makeRuntime(pool);
  await truncate();

  console.log("# Loom throughput bench — Postgres\n");
  console.log(`- server: ${versionRows[0]?.version ?? "unknown"}`);
  console.log(`- node: ${process.version} · platform: ${process.platform}/${process.arch}`);
  console.log(
    [
      `- config: ops/worker=${cfg.opsPerWorker} warmup=${cfg.warmupPerWorker} `,
      `payload≈${cfg.payloadBytes}B pool.max=${maxConcurrency + 8}\n`,
    ].join("")
  );

  // ── A. shipped append ───────────────────────────────────────────────────────
  const appendRows: Measurement[] = [];
  for (const c of cfg.concurrencies) {
    appendRows.push(await rawAppend(bundle.eventStore, cfg, c));
    await truncate();
  }
  sections.push(
    `## A. \`PostgresEventStore.append\` — the shipped write path\n\n${table(appendRows, "events")}`
  );

  // ── B. appendBatch counterfactual ────────────────────────────────────────────
  const batchConcurrency = cfg.concurrencies[cfg.concurrencies.length - 1] as number;
  const batchRows: Measurement[] = [];
  for (const b of cfg.batchSizes) {
    batchRows.push(await batchedAppend(pool, cfg, batchConcurrency, b));
    await truncate();
  }
  sections.push(
    [
      "## B. Batched append — the `appendBatch` counterfactual\n\n",
      "Not a shipped path. Same fence guard, one `pg_notify` per batch instead of per event.\n",
      "`ops/sec` = round-trips/sec; `events/sec` is the comparable number against section A.\n\n",
      table(batchRows, "events"),
    ].join("")
  );

  // ── C. pg_notify cost + LISTEN fan-out ──────────────────────────────────────
  const notifyConcurrency = batchConcurrency;
  const notifyRows: Measurement[] = [];
  notifyRows.push(await appendWithoutNotify(pool, cfg, notifyConcurrency));
  await truncate();
  notifyRows.push(await rawAppend(bundle.eventStore, cfg, notifyConcurrency));
  await truncate();
  const listeners = await attachListeners(PG_URL, cfg.listeners);
  const withListeners = await rawAppend(bundle.eventStore, cfg, notifyConcurrency);
  withListeners.label = `append (shipped) + ${cfg.listeners} idle LISTEN conns · c=${notifyConcurrency}`;
  notifyRows.push(withListeners);
  // Notifications are delivered asynchronously; give the listeners a beat to drain
  // before reading the counter, so the fan-out figure is not truncated.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const delivered = listeners.received();
  await listeners.close();
  await truncate();
  const appendsWhileListening = withListeners.ops + withListeners.warmupOps;
  sections.push(
    [
      "## C. `pg_notify` cost and LISTEN fan-out\n\n",
      `${table(notifyRows, "events")}\n\n`,
      `Notifications delivered to ${cfg.listeners} idle listeners: **${fmt(delivered, 0)}** across `,
      `${appendsWhileListening} appends (measured + warmup) = `,
      `**${fmt(delivered / Math.max(1, appendsWhileListening), 2)} per event**. `,
      "That figure IS the listener count: the channel has no server-side interest filter, ",
      "so every subscribing node receives every event and discards the ones it does not want.",
    ].join("")
  );

  // ── D. end-to-end durable executions ────────────────────────────────────────
  const execRows: Measurement[] = [];
  for (const stepCount of [1, 3]) {
    const m = await durableExecutions(bundle, cfg, stepCount);
    // Invariant check: the events/sec column is derived from an assumed 2*steps+2
    // envelopes per execution. Verify it against what actually landed rather than
    // trusting the arithmetic.
    const written = await countEvents();
    const expected = (m.ops + m.warmupOps) * m.unitsPerOp;
    console.error(
      [
        `  [check] ${stepCount}-step: ${written} events on disk, expected ${expected} `,
        `(${m.ops} measured + ${m.warmupOps} warmup executions × ${m.unitsPerOp}) — `,
        written === expected ? "OK" : "MISMATCH: events/sec column is wrong",
      ].join("")
    );
    execRows.push(m);
    await truncate();
  }
  sections.push(
    [
      "## D. End-to-end durable executions (`runtime.start` → `waitForCompletion`)\n\n",
      "No-op effect, so this is kernel + store cost only.\n\n",
      table(execRows, "events"),
    ].join("")
  );

  // ── E. transient ceiling ────────────────────────────────────────────────────
  const transient = await transientInvocations(bundle, cfg);
  const afterTransient = await countEvents();
  sections.push(
    [
      "## E. `invokeTransient` — the zero-write ceiling\n\n",
      `${table([transient], "calls")}\n\n`,
      `Events written during this scenario: **${afterTransient}** (ADR 0066 D2/R1 — must be 0).`,
    ].join("")
  );

  // ── F. read path ────────────────────────────────────────────────────────────
  // Sweeps log length with snapshot cadence FIXED. If reads are bounded by the snapshot,
  // throughput stays roughly flat as the log grows behind it; if the whole log is being
  // read, it falls off with length.
  const READ_STEP_COUNTS = [1, 10, 50];
  const readRows: Measurement[] = [];
  const readBundle = makeRuntime(pool, 2); // snapshotEvery: 2 — a snapshot near the tip
  for (const stepCount of READ_STEP_COUNTS) {
    await truncate();
    readRows.push(await readPath(readBundle, cfg, stepCount));
  }
  await readBundle.close();
  await truncate();
  const shortest = readRows[0];
  const longest = readRows[readRows.length - 1];
  const falloff =
    shortest !== undefined && longest !== undefined && longest.opsPerSec > 0
      ? shortest.opsPerSec / longest.opsPerSec
      : Number.NaN;
  const shortEvents = 2 * (READ_STEP_COUNTS[0] as number) + 2;
  const longEvents = 2 * (READ_STEP_COUNTS[READ_STEP_COUNTS.length - 1] as number) + 2;
  sections.push(
    [
      "## F. Read path (`runtime.loadState` over snapshotted executions)\n\n",
      "Log length sweeps; `snapshotEvery` is fixed at 2. Bounded reads ⇒ roughly flat ",
      "throughput across log lengths.\n\n",
      `${table(readRows, "reads")}\n\n`,
      `Falloff from a ${shortEvents}-event log to a ${longEvents}-event one `,
      `(**${longEvents / shortEvents}× the events**): **${fmt(falloff, 2)}×** slower. `,
      "Near 1× means snapshots bound the read; scaling with the log means they do not.",
    ].join("")
  );

  // ── A2. the SHIPPED coalescer, over the real store ──────────────────────────
  const coalescedRows: Measurement[] = [];
  for (const b of cfg.batchSizes.filter((n) => n > 1)) {
    await truncate();
    coalescedRows.push(await coalescedAppend(bundle.eventStore, cfg, batchConcurrency, b));
  }
  await truncate();
  const shippedBaseline = appendRows.find((m) => m.concurrency === batchConcurrency);
  sections.push(
    [
      "## A2. `CoalescingEventStore`, as shipped\n\n",
      "The decorator itself over the real `PostgresEventStore.appendBatch` — every cost the ",
      "shipped path pays is in these numbers (the per-row fence join, one `pg_notify` per ",
      "envelope, the all-or-nothing guard). Driven exactly like section A, one serial writer ",
      "per execution, so `ops` are per EVENT and comparable line for line.\n\n",
      `${table(coalescedRows, "events")}\n\n`,
      shippedBaseline !== undefined
        ? [
            `Against section A at the same concurrency (**${fmt(shippedBaseline.unitsPerSec)} `,
            "events/sec** per-event): ",
            coalescedRows
              .map(
                (m) =>
                  `maxBatch=${m.label.replace(/^.*maxBatch=(\d+).*$/, "$1")} → **${fmt(m.unitsPerSec / shippedBaseline.unitsPerSec, 2)}×**`
              )
              .join(", "),
            ". The default is 16 and stays there: tail latency at 64 is a trade a deployment ",
            "makes with its own p99 in hand, not one the framework makes for it.",
          ].join("")
        : "",
    ].join("")
  );

  // ── G. cross-execution coalescing with per-row fencing ──────────────────────
  const crossRows: Measurement[] = [];
  for (const fenced of [false, true]) {
    for (const b of cfg.batchSizes.filter((n) => n > 1)) {
      await truncate();
      crossRows.push(
        await crossExecutionBatch(pool, cfg, batchConcurrency, { batchSize: b, fenced })
      );
    }
  }
  await truncate();
  // Compare at the SAME batch size, not best-vs-best: the two shapes must differ only in
  // the fence check and the notify count, or the ratio measures batch size instead.
  const cmpBatch = Math.max(...cfg.batchSizes.filter((n) => n > 1), 0);
  const bestCross = crossRows.find(
    (m) => m.unitsPerOp === cmpBatch && m.label.includes("· fenced")
  );
  const bestSameExec = batchRows.find((m) => m.unitsPerOp === cmpBatch);
  sections.push(
    [
      "## G. Cross-execution coalescing (per-row fencing)\n\n",
      "The shape a store-level coalescer would actually use: one row per DISTINCT execution, ",
      "so the single fence guard of section B is replaced by a join against `fences`, and one ",
      "`pg_notify` fires per execution in the batch rather than one per batch. **Not a shipped ",
      "path** — this is the cost section B left unmeasured.\n\n",
      `${table(crossRows, "events")}\n\n`,
      bestCross !== undefined && bestSameExec !== undefined
        ? [
            `At batch=${cmpBatch}: fenced cross-execution **${fmt(bestCross.unitsPerSec)} events/sec** `,
            `vs **${fmt(bestSameExec.unitsPerSec)}** for section B's same-execution batch — `,
            `**${fmt(bestCross.unitsPerSec / bestSameExec.unitsPerSec, 2)}×**. `,
            "Same batch size, so the ratio isolates the per-row fence join plus the extra ",
            "per-execution notifies. The unfenced rows are the G2 case: executions that never ",
            "fence match nothing in the join and pay only for the notifies.\n\n",
            "Absolutes in this section are noisy run to run — compare the ratio, and repeat ",
            "before quoting a number.",
          ].join("")
        : "",
    ].join("")
  );

  // ── H. multi-node fan-out with real subscriber processes ────────────────────
  const fanoutRows: Measurement[] = [];
  const fanoutNodeCounts = [0, 2, 4];
  const deliveries: { nodes: number; delivered: number; appends: number }[] = [];
  for (const nodeCount of fanoutNodeCounts) {
    await truncate();
    const ids = subscribedExecutionIds(batchConcurrency, `n${nodeCount}`);
    const subs = await spawnSubscriberNodes(PG_URL, nodeCount, ids);
    const m = await appendWatched(
      bundle.eventStore,
      cfg,
      batchConcurrency,
      ids,
      `append · ${nodeCount} real subscriber node(s) · c=${batchConcurrency}`
    );
    // Cross-process delivery is asynchronous; let it drain before counting.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const { delivered, nodes } = await subs.stop();
    fanoutRows.push(m);
    deliveries.push({ nodes, delivered, appends: m.ops + m.warmupOps });
  }
  await truncate();
  const baseline = fanoutRows[0];
  const worst = fanoutRows[fanoutRows.length - 1];
  sections.push(
    [
      "## H. Multi-node fan-out (real subscriber processes)\n\n",
      "Section C uses idle `LISTEN` connections in this process. These are genuine forked ",
      "processes each holding a `PostgresEventStore` with live `subscribe()` calls, so ",
      "`onNotify`'s per-notification `SELECT` is included — the read amplification a real ",
      "node pays.\n\n",
      `${table(fanoutRows, "events")}\n\n`,
      "| nodes | notifications delivered | appends | per node per event |\n|---:|---:|---:|---:|\n",
      deliveries
        .map(
          (d) =>
            `| ${d.nodes} | ${fmt(d.delivered, 0)} | ${d.appends} | ` +
            `${d.nodes === 0 ? "—" : fmt(d.delivered / d.nodes / Math.max(1, d.appends), 2)} |`
        )
        .join("\n"),
      baseline !== undefined && worst !== undefined && worst.opsPerSec > 0
        ? [
            `\n\nWriter throughput with ${worst.concurrency} writers falls `,
            `**${fmt(baseline.opsPerSec / worst.opsPerSec, 2)}×** from 0 to `,
            `${fanoutNodeCounts[fanoutNodeCounts.length - 1]} subscriber nodes — the cost of `,
            "fan-out landing on the WRITER, which is what makes this the scale-out blocker.",
          ].join("")
        : "",
    ].join("")
  );

  // ── projection ──────────────────────────────────────────────────────────────
  const bestAppend = best(appendRows);
  const bestBatch = best(batchRows);
  const oneStep = execRows[0];
  const projection: string[] = ["## What this means for 100K QPS\n"];
  if (bestAppend !== undefined) {
    projection.push(
      [
        `- Best single-append throughput: **${fmt(bestAppend.unitsPerSec)} events/sec** `,
        `(at c=${bestAppend.concurrency}).`,
      ].join("")
    );
  }
  if (bestBatch !== undefined && bestAppend !== undefined) {
    projection.push(
      [
        `- Best batched throughput: **${fmt(bestBatch.unitsPerSec)} events/sec** `,
        `(batch=${bestBatch.unitsPerOp}) — `,
        `**${fmt(bestBatch.unitsPerSec / bestAppend.unitsPerSec, 2)}×** `,
        "over the shipped per-event path — but see section G for the shape a coalescer could\n" +
          "      actually reach, and ADR 0065 for the gate this does not open.",
      ].join("")
    );
  }
  if (oneStep !== undefined) {
    projection.push(
      [
        `- 1-step durable executions: **${fmt(oneStep.opsPerSec)} exec/sec** per runtime+DB `,
        `(${fmt(oneStep.unitsPerSec)} events/sec). Reaching 100K/sec of this shape needs `,
        `**${fmt(nodesFor(100_000, oneStep.opsPerSec), 0)}×** that capacity — and every one of `,
        "those writes lands on the SAME log, so the multiplier falls on Postgres, not just on Node.",
      ].join("")
    );
  }
  projection.push(
    [
      `- Transient (zero-write): **${fmt(transient.opsPerSec)} calls/sec** per process with a no-op `,
      `effect. 100K/sec needs **${fmt(nodesFor(100_000, transient.opsPerSec), 0)}** process(es) of `,
      "kernel headroom — i.e. the kernel is not the constraint on this path; whatever the effect ",
      "actually does is.",
    ].join("")
  );

  console.log(sections.join("\n\n"));
  console.log(`\n${projection.join("\n")}`);

  await bundle.close();
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
