# @loom/bench-throughput

Sustained-throughput harness for Loom's durable write path, against a **real Postgres**.

Every other `*.bench.ts` in this repo uses `vitest bench` to measure the *latency* of one
operation in a serial loop. That is the right tool for `traverseBlueprint` or the crypto
wrapper, and the wrong one for a network store: the question there is how many events per
second the log sustains with N writes **in flight**, and how the latency tail behaves as N
grows. This package answers that.

It is dev/test-only — no runtime package imports it.

## Running

Needs a Postgres. Any will do; a throwaway one is fine:

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust --name loom-bench postgres:16
```

or an isolated local cluster with no Docker:

```bash
initdb -D /tmp/loom-bench-pg -U postgres -A trust
pg_ctl -D /tmp/loom-bench-pg -o "-p 55432 -c max_connections=300" -l /tmp/loom-bench-pg.log start
```

Then:

```bash
pnpm --filter @loom/bench-throughput build
LOOM_TEST_POSTGRES_URL=postgres://postgres@localhost:55432/postgres \
  pnpm --filter @loom/bench-throughput bench
```

Without the env var it prints a skip notice and exits 0, so `pnpm bench` stays green on a
machine with no database — the same gating the Postgres store's integration tests use.

**The harness TRUNCATEs every Loom table between scenarios.** Point it at a scratch
database, never at anything you care about.

## Knobs

| env | default | meaning |
|---|---|---|
| `LOOM_TEST_POSTGRES_URL` / `LOOM_BENCH_POSTGRES_URL` | — | connection string; the latter wins |
| `LOOM_BENCH_CONCURRENCIES` | `1,8,32,128` | concurrency levels swept by the append scenarios |
| `LOOM_BENCH_OPS` | `200` | measured ops per worker |
| `LOOM_BENCH_WARMUP` | `20` | unmeasured ops per worker before each measured phase |
| `LOOM_BENCH_PAYLOAD_BYTES` | `256` | approximate event payload size |
| `LOOM_BENCH_BATCHES` | `1,4,16,64` | batch sizes for the `appendBatch` counterfactual |
| `LOOM_BENCH_LISTENERS` | `16` | idle `LISTEN` connections in the fan-out variant |
| `LOOM_BENCH_EXEC_CONCURRENCY` | `64` | concurrency for the end-to-end scenarios |
| `LOOM_BENCH_EXECS` | `40` | measured executions per worker |

## What it measures

**A. `PostgresEventStore.append`** — the shipped write path, swept across concurrency.
Each worker owns one execution and appends to it serially, which is exactly the real
shape: many concurrent executions, one serial writer each (the `ExecutionJournal` FIFO
invariant). A shared work queue would instead fan concurrent appends at a single
execution, a contention profile the kernel never produces.

**B. Batched append** — what an optional `appendBatch(envelopes[])` on the `EventStore`
SPI would buy. **Not a shipped path**, and not an open question: ADR 0065 froze this
design and deferred it behind a three-part evidence gate. Kept honest against A: same
fence guard (one check per batch is correct — every envelope in a journal flush belongs
to one execution) and one `pg_notify` for the batch tip. Ops are scaled down by batch
size so every level writes the same number of events.

**This scenario measures the SQL shape, not an achievable journal batch.** `ExecutionJournal`
is per-execution, so a 1-step flow (4 envelopes) can never fill a batch of 16 — and with a
realistic slow effect the serial tail drains between envelopes, collecting one. Treat
batch≥16 rows as an upper bound that only a *cross-execution* coalescer could reach, and
note that such a coalescer needs a per-row fence check this scenario does not measure.
See `docs/scaling.md` for the full argument.

**C. `pg_notify` cost and `LISTEN` fan-out** — the shipped statement versus the same
statement with the notify CTE removed, then with K listeners attached on the WRITER's own
store instance's real bucket channels (`bundle.eventStore.notifyChannels()`, ADR 0074 D4 —
full interest, the worst case for delivery; asked of the instance rather than hard-coded, so
it cannot drift out of sync with that store's configured `notifyBuckets`), then with K
listeners on a channel nobody publishes to. The unrelated-channel row is the point: it
isolates the writer's per-LISTENing-backend cost from delivery volume, and the two rows read
close together — bucketing narrows what a listener receives, not how many backends the
writer has to signal. `assertDelivered` fails the run outright if ANY expected channel
delivers nothing — not merely if the aggregate total is zero, so a partial coverage gap
cannot hide behind a nonzero sum — so this section cannot go vacuous again (it did, for a
release — see the ADR 0074 amendment).

**D. End-to-end durable executions** — a real `WorkflowRuntime`, a real flow, a no-op
effect, `start()` → `waitForCompletion()`. This is the number that answers "QPS". The
no-op effect is deliberate: it isolates kernel + store cost from whatever the tool does.
A post-run assertion checks the events actually written against the assumed
`2*steps + 2` per execution, so the events/sec column can't silently drift.

**E. `invokeTransient`** — the zero-write ceiling. Same runtime, same tool, no event
store, no journal, no fence (ADR 0066 D2/R1), asserted at 0 events written. The gap between
D and E is what durability costs.

**F. Read path** — `runtime.loadState` over seeded, snapshotted executions, sweeping log
length with `snapshotEvery` fixed. Bounded reads ⇒ roughly flat throughput as the log grows
behind the snapshot; falling throughput means the whole log is being read. Executions are
seeded with real runs, so snapshot placement is whatever the runtime's own cadence produces
— which is itself a finding (see `docs/benchmarks.md`). Each worker reads its own execution
so the measurement is not just the page cache.

**Compare p50, not ops/sec, on the long-log rows.** Throughput there carries tail-outlier
noise across runs while p50 is stable to within a few percent.

**G. Cross-execution coalescing (per-row fencing)** — the shape a store-level coalescer
would actually use: one row per *distinct* execution, so section B's single fence guard
becomes a join against `fences` and each execution in the batch gets its own `pg_notify`.
**Not a shipped path.** Runs both unfenced (no `fences` rows — the G2 case, where the join
matches nothing) and fenced (every execution has a row, the honest worst case). Compare
against section B **at the same batch size**; the report does this automatically.

**H. Multi-node fan-out (real subscriber processes)** — forks genuine subscriber processes
(`subscriberChild.ts`), each holding a `PostgresEventStore` with live `subscribe()` calls,
and sweeps writer throughput against node count. Unlike section C's idle `LISTEN`
connections, this includes `onNotify`'s per-notification `SELECT` — the read amplification
a real node pays. Three variants: **H1** shared interest (every node subscribes to every
execution — delivered notifications per node per event should be exactly 1, the broadcast
confirmed rather than inferred); **H2** disjoint interest (`partitionDisjoint` gives each
node its own non-overlapping share — delivered per node per event should drop to exactly
`1/nodeCount`; writer throughput does not track a clean prediction, and may reflect
single-host resource contention rather than a fan-out result — see `docs/scaling.md` §3.1);
**H3** a `CoalescingEventStore` writer under H1's shared interest, showing the shipped
mitigation for the writer-side cost that bucketing alone does not fix.

## Comparing hosts

`pnpm --filter @loom/bench-throughput hardware` emits one self-describing markdown report —
CPU, memory, Postgres version and settings, **database round-trip time**, and the four
measurements that characterise a host: where the write path saturates, the durable execution
ceiling, Little's-Law efficiency under a realistic effect, and where the write/effect
crossover sits.

It is deliberately narrower and faster than the A–H suite: those characterise the *system*,
this characterises the *host*, and it has to finish in minutes on a box billed by the hour.

Captured baselines live in `baselines/`, one file per host, verbatim. Diff them directly.
Check the round-trip line first — a loopback database is ≲0.1 ms and a networked one is not,
which explains most disagreements between hosts.

## Reading the results

Absolute numbers are host-relative — a laptop with a loopback Postgres has no network
hop and a shared page cache, so it flatters the store relative to a real deployment.
Compare **relative movement** between scenarios on one host, and re-capture a baseline on
whatever box you intend to quote numbers from.

`ops/sec` for a batched row is round-trips/sec; `events/sec` is the column comparable
across sections.

Per-section noise, from repeated runs on a laptop:

- **F** — ops/sec carries tail-outlier noise on long logs; compare p50, which is stable to
  a few percent.
- **G** — absolutes vary substantially run to run (up to ~2×). Compare the ratio against
  section B at the same batch size, and repeat before quoting. The fenced-vs-unfenced delta
  is *inside* that variance on this host — it flipped sign between two runs — so do not
  read it as the cost of the `fences` join.
- **H** — stable across runs, including the delivered-per-node-per-event figure.

Scenario H's "nodes" are separate processes on one host. That captures the per-node
`SELECT` amplification and the notify broadcast, but not network latency or a contended
NIC; a genuinely distributed run would likely be worse, not better.
