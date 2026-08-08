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
| `LOOM_BENCH_BATCHES` | `1,4,16,64` | batch sizes for the `appendMany` counterfactual |
| `LOOM_BENCH_LISTENERS` | `16` | idle `LISTEN` connections in the fan-out variant |
| `LOOM_BENCH_EXEC_CONCURRENCY` | `64` | concurrency for the end-to-end scenarios |
| `LOOM_BENCH_EXECS` | `40` | measured executions per worker |

## What it measures

**A. `PostgresEventStore.append`** — the shipped write path, swept across concurrency.
Each worker owns one execution and appends to it serially, which is exactly the real
shape: many concurrent executions, one serial writer each (the `ExecutionJournal` FIFO
invariant). A shared work queue would instead fan concurrent appends at a single
execution, a contention profile the kernel never produces.

**B. Batched append** — what an optional `appendMany(envelopes[])` on the `EventStore`
SPI would buy. **Not a shipped path.** Kept honest against A: same fence guard (one check
per batch is correct — every envelope in a journal flush belongs to one execution) and
one `pg_notify` for the batch tip. Ops are scaled down by batch size so every level
writes the same number of events.

**C. `pg_notify` cost and `LISTEN` fan-out** — the shipped statement versus the same
statement with the notify CTE removed, then with K idle listeners attached. Every append
notifies one global channel and every subscribing node receives every event, filtering
client-side; the delivered-notifications count makes that concrete.

**D. End-to-end durable executions** — a real `WorkflowRuntime`, a real flow, a no-op
effect, `start()` → `waitForCompletion()`. This is the number that answers "QPS". The
no-op effect is deliberate: it isolates kernel + store cost from whatever the tool does.
A post-run assertion checks the events actually written against the assumed
`2*steps + 2` per execution, so the events/sec column can't silently drift.

**E. `invokeTransient`** — the zero-write ceiling. Same runtime, same tool, no event
store, no journal, no fence (ADR 0065 R1), asserted at 0 events written. The gap between
D and E is what durability costs.

## Reading the results

Absolute numbers are host-relative — a laptop with a loopback Postgres has no network
hop and a shared page cache, so it flatters the store relative to a real deployment.
Compare **relative movement** between scenarios on one host, and re-capture a baseline on
whatever box you intend to quote numbers from.

`ops/sec` for a batched row is round-trips/sec; `events/sec` is the column comparable
across sections.
