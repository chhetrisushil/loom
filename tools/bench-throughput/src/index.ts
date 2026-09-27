import { CoalescingEventStore } from "@loom/event-runtime";
import { migratePostgresStores, notifyChannels } from "@loom/plugin-postgres";
import { Pool } from "pg";
import type { Measurement } from "./harness";
import {
  type BenchConfig,
  appendWatched,
  appendWithoutNotify,
  assertDelivered,
  attachListeners,
  batchedAppend,
  coalescedAppend,
  crossExecutionBatch,
  durableExecutions,
  makeRuntime,
  partitionDisjoint,
  rawAppend,
  readPath,
  spawnSubscriberNodes,
  subscribedExecutionIds,
  transientInvocations,
} from "./scenarios";

// The channel(s) a store built with the default `notifyBuckets` (16) actually publishes
// on — what section C's listeners must LISTEN on to receive anything post-ADR-0074.
const DEFAULT_NOTIFY_BUCKETS = 16;
// A channel no store in this process, or any other, ever publishes on — pins the
// channel-INDEPENDENT part of the writer cost (backlog-A item 3).
const UNRELATED_CHANNEL = "loom_events_bench_unrelated_channel";

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
  //
  // `bundle.eventStore` is built with the default `notifyBuckets` (16 — see
  // DEFAULT_NOTIFY_BUCKETS), so it publishes on `loom_events_<bucket>`, NOT the legacy
  // `NOTIFY_CHANNEL`. Listeners below must LISTEN on the real bucket channels
  // (`notifyChannels`) to receive anything; this section used to LISTEN on the legacy
  // channel alone and silently measured zero deliveries every run (backlog-A item 3).
  const notifyConcurrency = batchConcurrency;
  const notifyRows: Measurement[] = [];
  notifyRows.push(await appendWithoutNotify(pool, cfg, notifyConcurrency));
  await truncate();
  notifyRows.push(await rawAppend(bundle.eventStore, cfg, notifyConcurrency));
  await truncate();

  // Real bucket channels: a node interested in every execution, which is the worst case
  // for delivery and the case the pre-bucketing global channel always was.
  const realChannels = notifyChannels(DEFAULT_NOTIFY_BUCKETS);
  const realListeners = await attachListeners(PG_URL, cfg.listeners, { channels: realChannels });
  const withRealListeners = await rawAppend(bundle.eventStore, cfg, notifyConcurrency);
  withRealListeners.label =
    `append (shipped) + ${cfg.listeners} LISTEN conns on the ${realChannels.length} real ` +
    `bucket channel(s) · c=${notifyConcurrency}`;
  notifyRows.push(withRealListeners);
  // Notifications are delivered asynchronously; give the listeners a beat to drain
  // before reading the counter, so the fan-out figure is not truncated.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const realDelivered = realListeners.received();
  await realListeners.close();
  await truncate();
  const appendsWithRealListeners = withRealListeners.ops + withRealListeners.warmupOps;
  // The section is worthless if this fires silently as "0 delivered" — it must fail
  // outright, because real listeners on the real channels receiving nothing means the
  // wiring is broken, not that the cost is zero.
  assertDelivered(
    "C. real bucket-channel listeners",
    realDelivered,
    cfg.listeners,
    /* expectDelivery */ true
  );

  // Unrelated channel: listeners LISTEN on a channel nobody, ever, publishes on. If the
  // writer still slows down here, the cost cannot be about WHICH channel is used — it is
  // per LISTENing backend, independent of channel or interest (backlog-A item 3's finding;
  // ADR 0074 Amendment).
  const unrelatedListeners = await attachListeners(PG_URL, cfg.listeners, {
    channels: [UNRELATED_CHANNEL],
  });
  const withUnrelatedListeners = await rawAppend(bundle.eventStore, cfg, notifyConcurrency);
  withUnrelatedListeners.label =
    `append (shipped) + ${cfg.listeners} LISTEN conns on an UNRELATED channel · ` +
    `c=${notifyConcurrency}`;
  notifyRows.push(withUnrelatedListeners);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const unrelatedDelivered = unrelatedListeners.received();
  await unrelatedListeners.close();
  await truncate();
  // Zero delivered here is the CORRECT reading (nothing publishes on this channel) —
  // expectDelivery is false, so the guard does not fire on a legitimately empty count.
  assertDelivered(
    "C. unrelated-channel listeners",
    unrelatedDelivered,
    cfg.listeners,
    /* expectDelivery */ false
  );

  sections.push(
    [
      "## C. `pg_notify` cost and LISTEN fan-out\n\n",
      `${table(notifyRows, "events")}\n\n`,
      `Real bucket channels: **${fmt(realDelivered, 0)}** notifications delivered to `,
      `${cfg.listeners} listeners across ${appendsWithRealListeners} appends (measured + `,
      `warmup) = **${fmt(realDelivered / Math.max(1, appendsWithRealListeners), 2)} per `,
      "event** — close to the listener count, since every listener holds interest in every ",
      "bucket. Unrelated channel: **",
      `${fmt(unrelatedDelivered, 0)}** delivered (expected — nothing publishes there), yet `,
      "the writer paid almost the same throughput cost in both rows above. That is the ",
      "point of this section: the cost is NOT about which channel, or whether it matches — ",
      "it is per LISTENing backend on the connection, channel-independent. See ADR 0074's ",
      "amendment to D4.",
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
  interface FanoutDelivery {
    nodes: number;
    delivered: number;
    appends: number;
  }
  const deliveryRow = (d: FanoutDelivery): string =>
    `| ${d.nodes} | ${fmt(d.delivered, 0)} | ${d.appends} | ` +
    `${d.nodes === 0 ? "—" : fmt(d.delivered / d.nodes / Math.max(1, d.appends), 2)} |`;

  /** Run one fan-out measurement: spawn subscriber processes, append, drain, stop. */
  async function measureFanout(
    idsPerNode: string[][],
    writer: { store: typeof bundle.eventStore | CoalescingEventStore; label: string },
    ids: string[]
  ): Promise<{ measurement: Measurement; delivery: FanoutDelivery }> {
    const subs = await spawnSubscriberNodes(PG_URL as string, idsPerNode);
    const measurement = await appendWatched(writer.store, cfg, batchConcurrency, ids, writer.label);
    if (writer.store instanceof CoalescingEventStore) await writer.store.drain();
    // Cross-process delivery is asynchronous; let it drain before counting.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const { delivered, nodes } = await subs.stop();
    return {
      measurement,
      delivery: { nodes, delivered, appends: measurement.ops + measurement.warmupOps },
    };
  }

  // H-shared: every node subscribes to every execution the writer touches. This is the
  // pre-existing shape, kept as the baseline — but it CANNOT show bucketing's own benefit,
  // because there is no execution any node lacks interest in.
  const sharedRows: Measurement[] = [];
  const sharedNodeCounts = [0, 2, 4];
  const sharedDeliveries: FanoutDelivery[] = [];
  for (const nodeCount of sharedNodeCounts) {
    await truncate();
    const ids = subscribedExecutionIds(batchConcurrency, `hs${nodeCount}`);
    const { measurement, delivery } = await measureFanout(
      Array.from({ length: nodeCount }, () => ids),
      {
        store: bundle.eventStore,
        label: `append · ${nodeCount} node(s), shared interest · c=${batchConcurrency}`,
      },
      ids
    );
    sharedRows.push(measurement);
    sharedDeliveries.push(delivery);
  }
  await truncate();

  // H-disjoint: the SAME total execution count, but `partitionDisjoint` gives each node
  // its own non-overlapping share. Delivery should track that share (bucketing's client-
  // side benefit); writer throughput is the open question this variant exists to check.
  const disjointNodeCounts = [2, 4];
  const disjointRows: Measurement[] = [];
  const disjointDeliveries: FanoutDelivery[] = [];
  for (const nodeCount of disjointNodeCounts) {
    await truncate();
    const ids = subscribedExecutionIds(batchConcurrency, `hd${nodeCount}`);
    const { measurement, delivery } = await measureFanout(
      partitionDisjoint(ids, nodeCount),
      {
        store: bundle.eventStore,
        label: `append · ${nodeCount} node(s), disjoint interest · c=${batchConcurrency}`,
      },
      ids
    );
    disjointRows.push(measurement);
    disjointDeliveries.push(delivery);
  }
  await truncate();

  // H-coalesced: the writer appends through the SHIPPED `CoalescingEventStore` instead of
  // one `pg_notify` per event — the mitigation ADR 0074's amendment recommends for
  // multi-node fan-out, since it amortizes the per-commit signalling cost across a batch.
  const coalNodeCount = sharedNodeCounts[sharedNodeCounts.length - 1] as number;
  await truncate();
  const coalIds = subscribedExecutionIds(batchConcurrency, `hc${coalNodeCount}`);
  const coalescingStore = new CoalescingEventStore(bundle.eventStore, { maxBatch: 16 });
  const { measurement: coalescedFanout, delivery: coalescedDelivery } = await measureFanout(
    Array.from({ length: coalNodeCount }, () => coalIds),
    {
      store: coalescingStore,
      label: `append via CoalescingEventStore · ${coalNodeCount} node(s), shared interest · c=${batchConcurrency}`,
    },
    coalIds
  );
  await truncate();

  const sharedBaseline = sharedRows[0];
  const sharedWorst = sharedRows[sharedRows.length - 1];
  sections.push(
    [
      "## H. Multi-node fan-out (real subscriber processes)\n\n",
      "Section C uses idle `LISTEN` connections in this process. These are genuine forked ",
      "processes each holding a `PostgresEventStore` with live `subscribe()` calls, so ",
      "`onNotify`'s per-notification `SELECT` is included — the read amplification a real ",
      "node pays.\n\n",
      "### H1 — shared interest (every node wants every execution)\n\n",
      `${table(sharedRows, "events")}\n\n`,
      "| nodes | notifications delivered | appends | per node per event |\n|---:|---:|---:|---:|\n",
      sharedDeliveries.map(deliveryRow).join("\n"),
      sharedBaseline !== undefined && sharedWorst !== undefined && sharedWorst.opsPerSec > 0
        ? [
            `\n\nWriter throughput with ${sharedWorst.concurrency} writers falls `,
            `**${fmt(sharedBaseline.opsPerSec / sharedWorst.opsPerSec, 2)}×** from 0 to `,
            `${sharedNodeCounts[sharedNodeCounts.length - 1]} subscriber nodes.\n\n`,
          ].join("")
        : "\n\n",
      "### H2 — disjoint interest (delivery drops; writer cost does not, cleanly)\n\n",
      `${table(disjointRows, "events")}\n\n`,
      "| nodes | notifications delivered | appends | per node per event |\n|---:|---:|---:|---:|\n",
      disjointDeliveries.map(deliveryRow).join("\n"),
      "\n\n*Delivered* per node per event tracks the prediction exactly: `1/nodeCount` of H1's, ",
      "since a node's listener set now sees only the buckets its own share touches. *Writer* ",
      "throughput does NOT track a clean prediction either way — across repeat runs it is ",
      "sometimes close to H1 at the same node count and sometimes visibly higher, which is not ",
      "the bucketing win it might look like: fewer per-node `onNotify` SELECTs mean the ",
      "subscriber processes do less work, which can free CPU/connections on this SAME, ",
      "single-host loopback Postgres that the writer is also contending for (see the loopback ",
      "caveat in `docs/scaling.md`). A distributed deployment would not get that side effect. ",
      "The writer-side finding stands: bucketing does not itself reduce the per-LISTENing- ",
      "backend cost (section C).\n\n",
      "### H3 — coalesced writer (the shipped mitigation)\n\n",
      `${table([coalescedFanout], "events")}\n\n`,
      `${deliveryRow(coalescedDelivery)}\n\n`,
      sharedWorst !== undefined && coalescedFanout.opsPerSec > 0
        ? [
            `Against H1 at the same node count (**${fmt(sharedWorst.opsPerSec)} events/sec**): `,
            `**${fmt(coalescedFanout.opsPerSec / sharedWorst.opsPerSec, 2)}×**. `,
            "One notifying commit per BATCH rather than per event amortizes the per-commit ",
            "signalling cost that H1/H2 pay per event — this is the recommended mitigation for ",
            "multi-node fan-out (ADR 0074 D4 amendment), not a transport change.",
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
