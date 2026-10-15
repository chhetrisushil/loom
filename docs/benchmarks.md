# Loom Benchmarks — Committed Baselines

Run all benches: `pnpm bench`. Per package: `pnpm --filter @loom/<pkg> bench`.

Two kinds of bench live here. Most are `vitest bench` micro-benchmarks measuring the
*latency* of one operation in a serial loop. The **throughput** harness
(`tools/bench-throughput`) is different: it measures sustained ops/sec against a real
Postgres with N writes in flight, which `vitest bench` cannot express. See
[Durable write throughput](#durable-write-throughput-toolsbench-throughput).

These baselines are the **no-regression gate** for the cooperative-scheduling work
(see `packages/scheduler` and the plan). The render fast-path (`traverseBlueprint`)
is deliberately left untouched; treat a >~2% regression on it as a failure.

Numbers below are indicative (Apple Silicon, Node 20, vitest bench). Re-capture on
your CI host to set the authoritative baseline; compare relative movement, not
absolute hz, across machines.

## `@loom/plugin-crypto` — field-level encryption overhead (K10-R7 / ADR 0022 A4)

`plugins/crypto/src/append.bench.ts` — the marked-vs-unmarked-vs-unwired append benchmark ADR
0022 amendment A4 promised, proving the G2 bound (no overhead when unwired) and the honest
opt-in cost. Three shapes on the same payload:

| Shape | Relative | What it shows |
|---|---|---|
| unwired (plain `store.append`) | 1× (baseline) | no wrapper at all |
| wrapped, **empty** sensitive map | ~1.3× | one per-event-type map lookup, no crypto — within noise (**G2**) |
| wrapped, one field encrypted | ~20× | the actual per-marked-field AES cost (paid only for marked fields) |

The empty-map wrapper being ~1.3× (a single lookup) — not the 20×+ of the encrypted path — is the
provable "byte-identical when unmarked" claim. Run: `pnpm --filter @loom/plugin-crypto bench`.

## traverseBlueprint — render fast path (regression gate)

Pure synchronous walk, no scheduler involvement. Scales ~linearly with node count.

| Nodes  | mean (ms) | hz        |
|--------|-----------|-----------|
| 10     | 0.0005    | ~1,970,000 |
| 100    | 0.0048    | ~207,000  |
| 1,000  | 0.0451    | ~22,000   |
| 10,000 | 0.4668    | ~2,140    |

Takeaway: even a 10k-node tree traverses in ~0.47ms — well inside a frame budget.
This is the empirical basis for **not** adding a Fiber-style time-slicer to the
render path.

## @loom/scheduler — overhead guardrails

| Bench                              | Result vs baseline |
|------------------------------------|--------------------|
| `schedule` (Infinity) vs direct await | ~1.0–1.04× (negligible) |
| `parallelLimit` unbounded vs `Promise.all` | ~1.7× (sub-µs absolute; dwarfed by real I/O) |

Takeaway: the unbounded scheduler adds no meaningful latency; gating cost is only
paid when a finite concurrency cap is explicitly configured.

## projection storm — pre-coalescing baseline (Phase 4 target)

One `handleEvent` per streamed token; subscriber fires once per event today.

| Burst  | mean (ms) | subscriber calls |
|--------|-----------|------------------|
| 100    | 0.0131    | 100              |
| 1,000  | 0.1214    | 1,000            |

Phase 4 coalescing target: keep wall time flat or better while collapsing
subscriber calls from O(events) → O(microtask flushes).

## DS&A hot-path optimizations (PR #63)

Algorithmic wins on paths that are hit per-tick or per-append. Each is a strict
complexity improvement with identical outputs — no behavior change, so they only
*widen* the no-regression margin. See [ADR 0015](adr/0015-dsa-performance-optimizations.md#amendments-second-dsa-pass-pr-63-2026-07-10).

| Path | Before | After |
|------|--------|-------|
| `nextOccurrence` cron matching (`workflow-runtime/src/cron.ts`) | minute-by-minute scan | **field-jumping** — advance directly to the next matching field |
| Reasoning model routing (`reasoning/src/router.ts`) | linear scan of routes per call | **prebuilt index** — O(1) tag lookup |
| Crypto field walks (`plugins/crypto/src/crypto.ts`) | repeated full-object traversal | single-pass walk over marked paths |
| `deploy-sim` census | re-derived per flow | hoisted/linearized |

These sit off the render fast-path and within the >~2% regression gate above.

## Advisory pre-warming — cold-start hidden (PR #64)

Off-log, opt-in warming of cold resources (P10 advisory plane; latency-only, never a
fold input). Measured on the K7 isolated-executor boundary — the largest cold start:

| K7 isolated tool — first-call latency | ms |
|---|---|
| cold (lazy fork + module require on first `execute`) | ~54.2 |
| warm (child pre-spawned at boot via `warm()` / `spec.warm`) | ~2.0 |
| **cold start hidden by pre-warm** | **~52** |

Pre-warming boosts *latency, not throughput*, and only pays off at genuine I/O /
cold-start boundaries (K7 child, LLM connection, scheduled fires) — so it is scoped
there and nowhere else. See [ADR 0027](adr/0027-advisory-pre-warming.md).

## Batched content resolution — frozen-snapshot serving (ADR 0062)

`ContentStore.getMany` + batch-scoped two-phase resolution in
`ContentResolvingEventStore` (collect distinct refs across the read batch → one
round-trip → pure substitute). Measured resolving 50 externalized refs through a
2ms-per-round-trip backend (`plugins/content/src/content.bench.ts`):

| resolve 50 refs @ 2ms backend latency | mean ms |
|---|---|
| pre-ADR-0062 shape (serialized per-ref awaits) | ~114 |
| coalesced parallel `get`s (fallback, no `getMany`) | ~2.7 |
| **`getMany` (one batched round-trip)** | **~2.6** |

~44× over the old serialized shape; comfortably inside the TS-10 interactive
budget (p95 ≤ 150ms for ≤ 50 refs, asserted in `batchedResolution.test.ts`).
The batched-vs-coalesced gap is small against an in-memory backend (latency
does not scale with concurrency there); on real network stores with connection
caps the single round-trip is the durable win. `CachingContentStore` layers
cache-forever on top (content-addressed ⇒ immutable), with `delete`-evicts-first
so erasure is never resurrected.

## Durable write throughput (`tools/bench-throughput`)

The first measured answer to "how many requests per second can Loom do". Run:
`LOOM_TEST_POSTGRES_URL=... pnpm --filter @loom/bench-throughput bench` (skips cleanly
without a database). Full method and knobs: `tools/bench-throughput/README.md`.

Captured on Apple Silicon, Node 24, **loopback** PostgreSQL 17.2, 256B payloads. Loopback
flatters the store — no network hop, shared page cache — so treat these as an upper bound
for a single primary and re-capture on the host you intend to quote.

### Append saturates at ~22K events/sec, and past c≈32 concurrency *hurts*

| concurrency | events/sec | p50 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|
| 1   | 5,473  | 0.17 | 0.35  | 0.46   |
| 8   | **22,364** | 0.34 | 0.63 | 1.31 |
| 32  | 22,356 | 1.40 | 1.95  | 3.42   |
| 128 | 17,802 | 5.69 | 37.82 | 150.34 |

Throughput plateaus by c=8; adding in-flight writes past that buys latency, not capacity.

**Correction:** the c=128 row was first read as a regression. A wider sweep (below) shows it
is noise — raw append throughput is flat from c=8 to c=1024.

### Concurrency above 128: throughput flat, latency linear

| conc | events/sec | p50 ms | p99 ms |
|---:|---:|---:|---:|
| 8 | 20,271 | 0.32 | 1.7 |
| 32 | 17,055 | 1.51 | 7.2 |
| 128 | 19,194 | 6.02 | 13.7 |
| 256 | 21,389 | 11.74 | 13.6 |
| 512 | 15,639 | 24.01 | 109.0 |
| 1024 | 20,169 | 48.10 | 73.1 |

Textbook saturated-resource behaviour: throughput pinned at ~20K events/sec across a 128×
concurrency range, while p50 latency grows linearly (0.32 → 48 ms). Past c≈8 every extra
in-flight write is queueing, not work.

### …but execution-layer concurrency scales to ~512, because executions are mostly idle

Raw-append concurrency and *execution* concurrency are different things, and conflating them
is easy. An execution with a slow effect spends almost all its time not writing, so
concurrency there buys real throughput. 1-step flow, 100 ms effect:

| conc | exec/sec | events/sec | Little's Law | efficiency | p50 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 32 | 291 | 1,162 | 320 | 91% | 105 | 116 |
| 128 | 1,173 | 4,691 | 1,280 | 92% | 104 | 115 |
| 512 | 4,025 | 16,100 | 5,120 | 79% | 107 | 147 |
| 1024 | 3,704 | 14,818 | 10,240 | 36% | 195 | 506 |
| 2048 | 4,955 | 19,821 | 20,480 | 24% | 381 | 441 |

Near-linear to **c=512** at ~90% of Little's Law, with p50 latency still at the effect's own
100 ms. Past that it plateaus in a noisy 3.7–5K exec/sec band — ~16–20K events/sec, i.e.
exactly the write ceiling from the table above — and the extra concurrency shows up as
latency (p50 105 → 381 ms), not throughput.

**Practical reading:** on this hardware a 1-step, 100 ms-effect workload saturates at
**~4,000–5,000 exec/sec around c=512**. Earlier guidance extrapolated ~5,500 exec/sec at
c≈550 from the write ceiling alone; the measured plateau is ~25% below that.

### Batching: the SQL shape is worth up to 8×, but most of that is NOT reachable from the journal

Batched append is **not a shipped path**, and it is not an open design question either:
[ADR 0065](adr/0065-group-commit-deferred-evidence-gate.md) already froze the sketch
(`appendBatch(envelopes[])`, drained inside `ExecutionJournal`'s serial tail) and deferred
it behind a **three-part evidence gate**. What follows is evidence about the *SQL shape*,
measured with the same fence guard and one `pg_notify` per batch tip:

| batch | events/sec | vs shipped | p95 ms |
|---|---:|---:|---:|
| 1  | 15,821  | 0.7×  | 16.3 |
| 4  | 69,456  | 3.1×  | 7.8 |
| 16 | **183,141** | **8.2×** | 19.8 |
| 64 | 143,857 | 6.4×  | 143.3 |

**Read the 8.2× carefully — it is an upper bound on the statement, not on the design.**
Every batch here holds 16 events *of one execution*, because that is what a single fence
guard permits. But `ExecutionJournal` is **per-execution**: a 1-step flow emits 4 envelopes
total, a 3-step flow 8. A journal-side batcher can therefore never assemble a 16-event
batch for these flows — batch=4 (**3.1×**) is the hard ceiling for a 1-step flow, and even
that requires all four envelopes to be enqueued before the serial tail drains, which only
happens when the store is already saturated. With a realistic (slow, I/O-bound) effect,
`STEP_STARTED` and `STEP_COMPLETED` are seconds apart and the queue drains between them,
so a journal-side batch collects **one** envelope and wins nothing. This is precisely the
"a 3-events-per-run workload cannot win" case ADR 0065's gate 2 calls out.

The 8.2× is only reachable by coalescing **across** executions — many concurrent journals'
appends merged into one multi-row INSERT — which is *not* ADR 0065's sketch, would belong
in a store decorator rather than the kernel, and is **unmeasured**: a cross-execution batch
needs a per-row fence check (a join against `fences`) instead of the single guard measured
here, and that cost is unknown.

**This bench does not open ADR 0065's gate.** Gate 1 wants event-write throughput to be the
bottleneck *on a real workload*; this harness uses a no-op effect specifically to remove
effect latency, which is the opposite. Gate 3 (transient architecture insufficient) is not
addressed at all. Gate 2 is met only for the SQL shape, and contradicted for the journal.

### `pg_notify` costs ~37% of append throughput, and fan-out is linear in subscribers

| variant (c=128) | events/sec | vs no-notify |
|---|---:|---:|
| append WITHOUT the `pg_notify` CTE | 30,884 | 1.00× |
| append (shipped) | 19,453 | 0.63× |
| append (shipped) + 16 idle `LISTEN` conns | 9,886 | **0.32×** |

Sixteen *idle* listeners — subscribed to nothing in particular, doing no work — cut writer
throughput in half. Measured delivery was exactly **16 notifications per appended event**:
the channel has no server-side interest filter, so every node receives every event and
discards what it does not want. This is an O(events × nodes) broadcast, and it degrades
the writer, not just the readers.

**Correction (2026-09-28):** interest-filtered delivery (bucketed `LISTEN`, ADR 0074 D4)
shipped and fixed exactly the part of this measurement that is client-side — a node no
longer receives events it has no interest in. It did **not** fix the writer-side cost
measured above: that turned out to be per LISTENing backend and channel-independent, so a
listener LISTENing on a channel nobody publishes to costs the writer almost as much as one
receiving every event. `CoalescingEventStore`, not further interest-filtering, is the
mitigation for that cost. See the [ADR 0074 amendment](adr/0074-storage-scale-out-decorators.md)
and [`scaling.md` §3.1](scaling.md) for the re-measured numbers; this baseline is kept
verbatim above as the historical measurement that motivated bucketing in the first place.

### End-to-end durable executions

No-op effect, so this is kernel + store cost with nothing else in it. Events per execution
(`2*steps + 2`) is asserted against rows actually written, so the events/sec column cannot
drift.

| flow | exec/sec | events/sec | p50 ms | p99 ms |
|---|---:|---:|---:|---:|
| 1 step (4 events)  | **5,695** | 22,781 | 11.0 | 15.2 |
| 3 steps (8 events) | 2,488 | 19,901 | 21.3 | 70.7 |

Both land at ~20–23K events/sec — the same ceiling as section A, which is the point: **the
event log is the bottleneck, not the interpreter.** Execution throughput is just that
ceiling divided by events per execution.

### The transient path is not in the same regime

| scenario | calls/sec | events written |
|---|---:|---:|
| `runtime.invokeTransient` (no-op effect) | **1,112,600** | 0 |

ADR 0066 D2/R1 holds under load: zero envelopes. ~195× the durable 1-step rate, because it
writes nothing. On this path the kernel is not the constraint — the effect's own work is.

### Cross-execution coalescing: viable, but not the same-execution headline

Section B batches 16 events of ONE execution under a single fence guard — a shape the
per-execution `ExecutionJournal` can never fill for short flows. The only shape that *can*
fill a batch is a store-level coalescer merging appends across many concurrent executions,
and that cannot use one guard: rows belong to different executions, so each needs its own
fence check (a join against `fences`), and each execution in the batch needs its own
`pg_notify`. This is the cost the guide previously recorded as unknown.

Two full runs, c=128, one row per distinct execution:

| batch | run 1 (events/sec) | run 2 (events/sec) |
|---|---:|---:|
| 4, fenced  | 56,618 | 24,365 |
| 16, fenced | 141,141 | 80,209 |
| 64, fenced | 115,514 | 182,974 |

**Absolute numbers here are noisy — treat the ratio, not the value.** At a matched batch
size of 64 the fenced cross-execution shape ran at **0.55× and 0.65×** of section B's
same-execution batch across the two runs.

So: a cross-execution coalescer is **viable** — roughly 4–8× over the shipped per-event
append — but it does **not** reach section B's headline. Budget for about 0.6× of it once
per-row fencing and per-execution notifies are paid.

**What could not be resolved:** whether the `fences` join itself is the expensive part. The
fenced-vs-unfenced delta flips sign between runs (unfenced faster at b=64 in run 1, slower
in run 2), so it is inside run-to-run variance. Anyone wanting that number needs repeated
runs on a quieter host than a laptop.

None of this opens [ADR 0065](adr/0065-group-commit-deferred-evidence-gate.md)'s gate — it
sizes a design, it does not demonstrate a real workload bottlenecked on event writes.

### Multi-node fan-out: 4 real subscriber nodes cost more than 16 idle listeners

Section C approximates fan-out with idle `LISTEN` connections in-process. A real node does
more: it holds a `PostgresEventStore`, and `onNotify` issues a `SELECT` per notification to
fetch the row. Measured with genuine forked subscriber processes, c=128:

| subscriber nodes | run 1 | run 2 |
|---|---:|---:|
| 0 | 18,096 | 21,175 |
| 2 | 12,521 | 12,742 |
| 4 | 8,275 | 10,223 |

Writer throughput falls **2.19× / 2.07×** from 0 to 4 nodes. Delivery was exactly **1
notification per node per appended event** in both runs — the broadcast, confirmed
end-to-end across processes rather than inferred.

Put against section C: **16 idle listeners cost ~1.97×; just 4 real subscriber nodes cost
~2.1×.** The difference is `onNotify`'s per-event `SELECT`. Fan-out is therefore roughly
4× worse per node than the idle-listener approximation suggested, and the cost lands on the
**writer**.

**Correction (2026-09-28):** this measurement's framing — that interest-filtered delivery
would be *the* fix, ahead of everything else in `scaling.md` — did not hold up. Bucketing
shipped (ADR 0074 D4) and removed the `onNotify` per-event `SELECT` difference this section
measures for nodes outside a listener's interest, but the writer-side fall-off measured here
(2.07×–2.19× at 4 nodes) is caused by the number of LISTENing backends, not by what they are
interested in, and re-measuring after bucketing shipped found the same order of loss
(1.68×–2.63× across repeat runs). The actual highest-leverage change for this cost is
`CoalescingEventStore` (measured 1.21×–1.54× recovery), not further interest-filtering. See
the [ADR 0074 amendment](adr/0074-storage-scale-out-decorators.md) and
[`scaling.md` §3.1](scaling.md).

### Coalescing, as shipped (ADR 0074)

The measurements above size *counterfactuals* in SQL. This is the implementation:
`CoalescingEventStore` over `PostgresEventStore.appendBatch`, including everything the real
path pays — the per-row fence JOIN, per-envelope `pg_notify`, and the all-or-nothing guard.
It is **section A2 of the harness** (`coalescedAppend`), driven exactly like section A — one
serial writer per execution, ops counted per event — so the rows compare line for line.
c=64, 6,400 events, median of 3 runs:

| configuration | events/sec | vs shipped |
|---|---:|---:|
| per-event `append` | 21,614 | 1.0× |
| `CoalescingEventStore` (default `maxBatch: 16`) | 32,190 | **1.5×** |
| `CoalescingEventStore` (`maxBatch: 64`) | 43,126 | **2.0×** |

**These numbers replace an earlier table that nothing in the repo could reproduce.** It
reported 2.3× and 4.3× for the same two configurations, and the harness contained only the
raw-SQL counterfactuals of sections B and G — no scenario ever instantiated the decorator.
The per-event baseline was reproduced closely (18,190 then, 21,614 now, same laptop class),
so the gap is in the coalesced rows rather than in the machine. What is reproducible is what
this table now says, and re-running it is one command:

```sh
LOOM_TEST_POSTGRES_URL=postgres://… LOOM_BENCH_CONCURRENCIES=8,64 LOOM_BENCH_OPS=100 \
  LOOM_BENCH_BATCHES=1,16,64 pnpm --filter @loom/bench-throughput bench
```

Note the default is the conservative one. The earlier "knee at 16, regression at 64" came
from the same-execution statement shape in section B; the cross-execution shape behaves
differently and 64 is faster here. Its tail is where the trade shows: p99 rises from 3.95 ms
at 16 to a 14.2 ms max at 64 in the same run, which is why the default stays at 16 — raise
it deliberately, with your own p99 in hand.

The honest bottom line on batching is therefore **1.5–2.0× measured end to end** on the
shipped decorator — not section B's 8.2×, which was always an upper bound on a statement
rather than on a design, and not the 2.3–4.3× this page previously claimed.

### The decorators without a database: what they cost, and what they buy

Everything above needs a live Postgres, so none of it runs in CI and none of it can be
re-checked on a laptop. `packages/event-runtime/src/scaleDecorators.bench.ts` is the part
that can: it prices ONE round-trip explicitly (`ROUND_TRIP_US`, spun rather than slept, so
scheduler granularity stays out of a measurement about call counts) and appends 512
envelopes across 512 distinct executions concurrently — the real shape, N journals each
holding one pending envelope.

Run it with `npx vitest bench --run src/scaleDecorators.bench.ts` from
`packages/event-runtime`. At a 20µs round-trip, on the same laptop as the rest of this file:

| configuration | ops/sec | vs undecorated |
|---|---:|---:|
| per-event `append` (no decorator) | 96.8 | 1.0× |
| `CoalescingEventStore` (default `maxBatch: 16`) | 1,437 | **14.8×** |
| `CoalescingEventStore` (`maxBatch: 64`) | 4,950 | **51×** |

Those ratios track the round-trips saved (512 → 32 → 8) rather than a property of any
backend: the point of the parameter is that a reader who thinks their own round-trip is
dearer or cheaper can move it and re-run. What the Postgres table above adds — and this one
cannot — is everything a real backend also pays: the fence JOIN, `pg_notify` per envelope,
the all-or-nothing guard. That is why 51× on a modelled round-trip is 2.0× on a database.

The second half of the bench is the counterweight, and it is the reason these decorators are
**inert unless explicitly composed**:

| over a FREE (in-memory) backend | ops/sec | cost |
|---|---:|---:|
| `InMemoryAsyncEventStore` (no decorator) | 8,074 | — |
| `CoalescingEventStore` over in-memory | 5,431 | **1.49×** slower |
| `ShardedEventStore` over 4 in-memory shards | 3,550 | **2.27×** slower |

There are no round-trips to save against a store in the same process, so coalescing there is
pure overhead, and sharding buys parallelism a single-process bench cannot show and this
deliberately does not claim. Wire them where a round-trip is real; leave them out where it
is not.

### Read path: `loadState` no longer reads the whole log

`foldState` used to read the ENTIRE log before checking for a snapshot, then throw that
result away — so snapshots bounded the fold's CPU but not its I/O. Now it loads the
snapshot first and reads only a bounded tail (plus a one-row existence anchor).

Measured with `snapshotEvery: 2`, c=16, median of 3 runs. `p50` is the reliable signal
here; the ops/sec column carries tail-outlier noise on the long-log case.

| log length | before (p50) | after (p50) | before (reads/sec) | after (reads/sec) |
|---|---:|---:|---:|---:|
| 4 events   | 0.72 ms | 0.71 ms | 17,690 | 17,936 |
| 102 events | 4.76 ms | **2.93 ms** | 3,077 | **4,297** |

**~1.6× faster at p50 on a 102-event log, and no regression on short ones** — as expected,
since the un-snapshotted path still issues the same number of queries.

### …and a settle-time checkpoint, because `snapshotEvery` alone does not bound reads

The read fix above only got falloff from ~5.75× to ~4.17×, not to ~1×. Probing why turned
up a second defect: on a 102-event execution with `snapshotEvery: 2`, **exactly one
snapshot was stored, at sequence 2** — every read folded a 99-event tail.

`maybeSnapshot` can only fire while the execution is still committing, and it skips while a
save is in flight. A fast execution commits its entire log inside that first async save, so
it checkpoints once, near the start, and nothing after completion ever revisits it.
`suspend` already checkpoints at its tip; **completion did not**.

Adding the symmetric settle-time checkpoint — gated on `snapshotEvery` being set *and* the
tail since the last checkpoint having reached it, so short executions and the default
unset config are untouched:

| 102-event log, p50 | reads/sec |
|---|---:|
| before both fixes | 4.76 ms · 3,077 |
| bounded `foldState` read only | 2.93 ms · 4,297 |
| **+ settle checkpoint** | **1.22 ms · 10,939** |

**3.9× cumulative at p50**, and the snapshot now lands at the tip (tail folded on read: 99
→ 0). Cost is exactly **one extra snapshot write per completed execution whose tail reached
the cadence** — probed at 2 snapshots per execution rather than 1, and zero when
`snapshotEvery` is unset.

Residual falloff is ~1.6×, and is not log length: a 50-step execution's snapshot *state* is
simply bigger to fetch and parse than a 1-step one (50 frames vs 1). That part is inherent.

**What did NOT work, measured:** changing the cadence trigger from an exact multiple to an
interval since the last checkpoint — the obvious reading of the defect. It is inert in both
regimes. A fast execution has no commits left by the time the save resolves; a slow one lets
the exact-multiple trigger keep up anyway (**299 vs 300** checkpoints over the same
workload). It was dropped rather than shipped as unmeasured complexity.

### Profiling for ADR 0065 gate 1: where the write/effect crossover actually is

[ADR 0065](adr/0065-group-commit-deferred-evidence-gate.md) gate 1 asks for a **real
workload** where event-write throughput — not effect latency — is the **measured**
bottleneck, and insists on a profile rather than intuition. `ProfilingEventStore`
(`@loom/event-runtime`) and `effectTimingMiddleware` (`@loom/middleware`) are the
instruments for answering that on *your* traffic; both are decorators/middleware, so they
are inert until wired.

Sweeping synthetic effect latency locates the boundary. c=32, Postgres, aggregate work-time
attribution:

| effect latency | events/exec | exec/sec | effect ms | write ms | write share | verdict |
|---:|---:|---:|---:|---:|---:|---|
| 0 ms | 4 | 4,158 | 22 | 4,820 | 99.6% | write-bound |
| 1 ms | 4 | 5,585 | 346 | 3,605 | 91.2% | write-bound |
| 1 ms | 22 | 1,001 | 6,093 | 20,392 | 77.0% | write-bound |
| **5 ms** | 4 | 4,902 | 3,008 | 2,176 | **42.0%** | effect-bound |
| 25 ms | 22 | 120 | 41,436 | 14,083 | 25.4% | effect-bound |
| 100 ms | 22 | 31 | 161,837 | 13,767 | 7.8% | effect-bound |

**The crossover sits at roughly 2–3 ms of effect latency.** Below it the write path
dominates; above it, it does not, and batching the write path cannot help however large the
raw event rate looks.

That number is the useful output, and it points **away** from the gate for typical Loom
workloads. An LLM call, an agent step, or a remote tool invocation is 100 ms to seconds —
30× to 1000× above the crossover, landing at 8–25% write share. For those, effect latency is
the constraint and always will be.

Caveats on the method: the share is of *aggregate work time* (writes and effects both run
concurrently, so each column can exceed wall time), which is a first-order attribution
rather than a critical-path analysis. `ExecutionJournal` also queues appends on a serial
tail, so a sharper signal for a borderline workload is time blocked at `drain()` barriers —
not yet instrumented.

### Takeaway for capacity planning

- **Durable executions: ~5.7K/sec** per runtime + single Postgres primary for a 1-step
  flow. 100K/sec of that shape is **18×** this capacity, and because every write lands on
  the same log, that multiplier falls on Postgres — worker scale-out
  (`PlacementDispatcher`, `worker-remote`, `cloudrun`) does not help.
- The best-evidenced headroom is **interest-filtered notify delivery** — measured, no SPI
  change, no gate against it. Batching is gated (ADR 0065) and its journal-side form is
  worth far less than the 8.2× headline; see the batching section above.
- **Stateless/transient: not a scaling problem.** One process already exceeds 100K/sec of
  kernel overhead; size for the effect, not the runtime.
- **Before quoting the 5.7K anywhere: it is a no-op-effect ceiling.** With a realistic
  I/O-bound effect the write path is nowhere near the bottleneck — sustaining 5.7K exec/sec
  of 2-second LLM steps would need ~11K concurrent executions, and concurrency, memory, and
  the provider's rate limit bind first. Treat these numbers as *where the floor is*, not as
  a throughput target any real workload approaches.

See [`docs/scaling.md`](scaling.md) for what to do with all of this.

## Heartbeat lease overhead (`tools/bench-throughput`, ADR 0130 D11 / Q8 gate)

ADR 0130 D11 (Q8) ships eager leasing (every driver holds a heartbeat lease from before its first
append) only if the lease overhead is **at most 10% on the no-op throughput ceiling and none at
I/O-bound durations**, else it falls back to lazy. This measures exactly that: the same 1-step flow,
`heartbeat` OFF vs ON (defaults: ttl 30 s, renew every 10 s, real timers), OFF and ON interleaved per
repeat (alternating which goes first) and reduced to medians.

```
LOOM_BENCH_BACKENDS=memory,sqlite,postgres LOOM_BENCH_CONCS=16,64,256 LOOM_BENCH_REPEATS=9 \
LOOM_BENCH_PG_URL=postgres://... pnpm --filter @loom/bench-throughput bench:lease
```

`LOOM_BENCH_PG_URL` must point at a **throwaway** database: every run leaves its event, snapshot and
lease rows (and the stores' tables) behind. The Postgres pool is capped at 32 connections for OFF and
ON alike, so the conc-256 cells are pool-bound as well as write-bound. The `execs` column is the
count actually run (`round(n / conc) * conc`), not the configured `n`.

(`LOOM_BENCH_SHAPES`, `LOOM_BENCH_EXECS` / `_SQLITE_EXECS` / `_PG_EXECS` / `_IO_EXECS`, `LOOM_BENCH_IO_MS`
also apply.) The non-blocking assertion form is `leaseOverhead.perf.test.ts` (`pnpm test:perf`).
Batching itself is pinned deterministically (call counts, not time) by
`tools/dst/src/leaseBatching.test.ts`: N concurrent executions cost one `renewMany` per chunk per tick
and group-committed acquires/releases.

**How to read this.** The 10% gate is judged on the **DURABLE** backend (Postgres event store +
Postgres lease store + Postgres snapshot store on one pool). The in-memory no-op is the *worst case
for a ratio* (the baseline is almost free, so any fixed per-execution work is a large fraction of it)
and is reported for that reason, not as the figure the gate is read on. SQLite is a single-host
durable store (WAL, files in a temp dir).

**Machine and caveats (local results, not CI).** Apple M2, 8 cores, 8 GB, macOS (Darwin 25.6), Node
v24.18.0, PostgreSQL 17.2 as a throwaway local cluster on loopback TCP (`127.0.0.1`, so no network
latency; a networked Postgres adds a round trip per statement, which this does not price). 2026-10-15.
N = 9 interleaved repeats per cell; 6000 in-memory / 2000 SQLite / 3000 Postgres no-op executions and
1500 I/O-bound at 20 ms per run. No loom job ran concurrently, but the desktop was not idle (a browser
and window server; load average 6-15 on 8 cores during the run), so spreads are wide, especially
in-memory (a single sample can fall to a third of its neighbours). "Overhead (median ratio)" is
(median OFF - median ON) / median OFF; the paired columns are the same repeat's OFF/ON pair (adjacent
in time, so they cancel slow drift), as a median and a min..max range.

### No-op (the throughput ceiling)

| backend | conc | off exec/s | on exec/s | overhead (median ratio) | paired median | paired min..max |
|---|---:|---:|---:|---:|---:|---|
| postgres | 16 | 5,764 | 4,024 | 30.2% | 30.3% | -10.3..34.4% |
| postgres | 64 | 5,300 | 3,996 | 24.6% | 27.2% | 5.4..62.4% |
| postgres | 256 | 5,255 | 3,933 | 25.2% | 25.6% | 1.0..33.0% |
| sqlite | 16 | 5,652 | 5,250 | 7.1% | 7.8% | -33.7..14.8% |
| sqlite | 64 | 5,977 | 5,923 | 0.9% | 0.5% | -18.7..3.0% |
| sqlite | 256 | 5,862 | 5,552 | 5.3% | 6.3% | -5.6..27.0% |
| memory | 16 | 100,139 | 76,195 | 23.9% | 26.3% | 10.5..78.0% |
| memory | 64 | 76,323 | 61,611 | 19.3% | 19.5% | -117.5..40.7% |
| memory | 256 | 74,810 | 57,888 | 22.6% | 23.7% | -140.8..65.2% |

### I/O-bound (20 ms effect)

| backend | conc | off exec/s | on exec/s | overhead (median ratio) | paired median | paired min..max |
|---|---:|---:|---:|---:|---:|---|
| postgres | 16 | 538 | 531 | 1.4% | 1.4% | -4.5..7.5% |
| postgres | 64 | 2,539 | 2,498 | 1.6% | 2.1% | -6.1..17.4% |
| postgres | 256 | 5,178 | 3,520 | 32.0% | 31.4% | 24.6..69.3% |
| sqlite | 16 | 698 | 699 | -0.0% | 0.3% | -0.7..1.1% |
| sqlite | 64 | 2,763 | 2,686 | 2.8% | 2.7% | -14.7..11.0% |
| sqlite | 256 | 5,511 | 4,282 | 22.3% | 22.4% | -16.9..77.0% |
| memory | 16 | 724 | 718 | 0.9% | 1.1% | 0.5..4.1% |
| memory | 64 | 2,863 | 2,842 | 0.7% | 1.0% | -1.6..3.6% |
| memory | 256 | 10,124 | 9,779 | 3.4% | 1.8% | -4.9..11.8% |

At concurrency 256 the I/O-bound shape stops being I/O-bound on the durable stores: 256 workers
each waiting 20 ms could issue ~12,800 exec/s, above the ~5,000 exec/s the Postgres/SQLite write path
sustains, so that cell is write-bound and reads like a no-op cell.

### Does the gate hold?

- **Postgres (durable) no-op: NOT met.** Median overhead is 25-30% at every concurrency (16: 30.2%,
  64: 24.6%, 256: 25.2%), and the OFF/ON samples mostly do not overlap (the paired min at conc 16 is -10.3%; e.g. conc 16: OFF 5.1-6.0K vs ON
  3.8-4.2K exec/s). This is not noise. Each execution pays two extra lease statements (one
  group-committed acquire, one release) on top of a handful of event-store statements, and on a
  write-bound store that is a large share of the work. On the numbers, Q8's fallback ("lazy leasing")
  condition is triggered for the durable backend; this document records the measurement, it does not
  change the default.
- **Postgres I/O-bound (conc 16 and 64): met** (1.4% and 1.6%): the lease work overlaps the wait.
  The 256 cell is write-bound (see above) and shows 32%, the same cost as the no-op row.
- **SQLite no-op: met at 64 (0.9%), borderline at 16 and 256** (7.1%, 5.3% by median ratio, with
  paired ranges that straddle 10%).
- **In-memory no-op: not met (19-24%), as expected for the worst case.** The in-memory stores make the
  baseline ~75-100K exec/s, so the fixed per-execution lease work is a large fraction of a tiny
  denominator. Nobody runs durable workloads on this configuration; it is the upper bound on the
  ratio, not the gate.

(S7g, below, takes that decision: the default became lazy.) These numbers say the Q8 decision needs to be
taken on the durable-backend result above (accept the cost, batch more aggressively than the current
group commit, or fall back to lazy leasing). A re-run on a fully idle machine and against a networked
Postgres would tighten the figures; this run did not have either.

## S7g: lazy heartbeat leases (ADR 0130 D11 amendment, 2026-10-15)

The S7f result above failed the D11 gate on the durable backend (eager: 25-30% no-op overhead on
Postgres), so the default became **lazy** acquisition: a run takes no lease until it has been driving for
`lazyGraceMs` (default TTL/3 = 10 s). (Amended 2026-10-15 after review: lazy applies to a FRESH `start` only;
resume, resumeAs, restoreFromState, the send/notify winner and continue-as-new successors are eager in both
modes. This bench starts fresh one-step flows and never resumes, so its numbers are the fresh-start path (the
tables directly below were taken with CALLER-CHOSEN ids before the round-2 re-run in the last subsection; the
intermediate commit that added a classifying `hasSequenceZero` read to every caller-chosen start was removed in
round 2, since a start never drives an existing stream: see the re-run); the eager resume cost is the S7f protocol, priced by the S7f tables.) The bench (`bench:lease`) now measures three modes per repeat,
interleaved with a rotating order: heartbeat **off**, **eager** (a lease before every run's first
append) and **lazy** (the default). The flow is one step, so with the 10 s grace a lazy run never
leases: this prices the cost a short execution pays for lazy mode (a grace timer set and cleared, no
store call), which is the ceiling shape the gate is about. A run that outlives the grace pays the
eager cost from then on (one group-committed acquire, renewals, one release), amortised over a run long
enough to be I/O-bound, where the S7f table shows it is within noise.

```
LOOM_BENCH_BACKENDS=memory,sqlite,postgres LOOM_BENCH_CONCS=16,64,256 LOOM_BENCH_REPEATS=7 \
LOOM_BENCH_EXECS=6000 LOOM_BENCH_SQLITE_EXECS=2000 LOOM_BENCH_PG_EXECS=3000 \
LOOM_BENCH_PG_URL=postgres://... pnpm --filter @loom/bench-throughput bench:lease
```

Same machine and caveats as above (Apple M2, 8 cores, macOS, Node v24.18.0, PostgreSQL 17 on loopback
as a throwaway cluster with its own throwaway database, 2026-10-15; the desktop was not idle). N = 7
repeats per cell, OFF/EAGER/LAZY interleaved, medians. "Overhead" is (median OFF - median mode) /
median OFF; a negative value means the mode measured faster than OFF (noise). Paired = the same
repeat's OFF/LAZY pair, as a median and a min..max range.

### No-op (the throughput ceiling)

| backend | conc | off exec/s | eager exec/s | lazy exec/s | eager overhead | lazy overhead | lazy paired median (min..max) |
|---|---:|---:|---:|---:|---:|---:|---|
| postgres | 16 | 5,759 | 4,170 | 6,012 | 27.6% | -4.4% | -5.6 (-11.7..2.4)% |
| postgres | 64 | 5,265 | 3,774 | 5,256 | 28.3% | 0.2% | 1.0 (-10.6..7.9)% |
| postgres | 256 | 5,163 | 3,898 | 5,335 | 24.5% | -3.3% | -1.5 (-12.2..10.0)% |
| sqlite | 16 | 5,969 | 5,383 | 5,782 | 9.8% | 3.1% | 1.7 (-11.4..9.7)% |
| sqlite | 64 | 6,007 | 5,708 | 6,104 | 5.0% | -1.6% | -2.0 (-26.5..1.0)% |
| sqlite | 256 | 5,766 | 5,709 | 6,022 | 1.0% | -4.4% | -2.3 (-5.5..0.1)% |
| memory | 16 | 106,019 | 75,614 | 87,260 | 28.7% | 17.7% | 13.7 (-10.7..84.1)% |
| memory | 64 | 75,383 | 62,542 | 74,342 | 17.0% | 1.4% | -0.9 (-34.4..72.3)% |
| memory | 256 | 68,955 | 59,886 | 65,870 | 13.2% | 4.5% | 7.7 (-89.7..19.3)% |

### I/O-bound (20 ms effect)

| backend | conc | off exec/s | eager exec/s | lazy exec/s | eager overhead | lazy overhead | lazy paired median (min..max) |
|---|---:|---:|---:|---:|---:|---:|---|
| postgres | 16 | 543 | 520 | 537 | 4.2% | 1.1% | 0.7 (-1.7..5.1)% |
| postgres | 64 | 2,522 | 2,502 | 2,523 | 0.8% | -0.0% | -2.4 (-16.5..12.9)% |
| postgres | 256 | 5,207 | 3,792 | 5,244 | 27.2% | -0.7% | 0.3 (-25.6..27.2)% |
| sqlite | 16 | 699 | 699 | 701 | -0.0% | -0.3% | -0.1 (-1.4..1.4)% |
| sqlite | 64 | 2,745 | 2,693 | 2,775 | 1.9% | -1.1% | -0.3 (-7.6..1.2)% |
| sqlite | 256 | 5,726 | 4,179 | 5,607 | 27.0% | 2.1% | 2.2 (-7.3..4.6)% |
| memory | 16 | 726 | 721 | 725 | 0.8% | 0.2% | 0.2 (-0.3..1.8)% |
| memory | 64 | 2,875 | 2,772 | 2,848 | 3.6% | 0.9% | 1.0 (-0.7..2.2)% |
| memory | 256 | 10,610 | 10,379 | 10,669 | 2.2% | -0.6% | 0.3 (-17.3..13.4)% |

### Does the gate hold with lazy as the default?

- **Postgres (durable) no-op: MET.** Lazy overhead is -4.4%, 0.2% and -3.3% at concurrency 16, 64 and
  256 (paired medians -5.6%, 1.0%, -1.5%), i.e. indistinguishable from heartbeat off, against eager's
  27.6%, 28.3% and 24.5% in the same run. The eager figure reproduces S7f.
- **Postgres I/O-bound: MET** (lazy 1.1%, 0.0%, -0.7%; eager 4.2%, 0.8%, 27.2% at the write-bound 256 cell).
- **SQLite: MET** (lazy 3.1%, -1.6%, -4.4% no-op; -0.3%, -1.1%, 2.1% I/O-bound).
- **In-memory no-op, the worst case for a ratio: the gate is not read here.** Lazy is 17.7% at conc 16
  (paired median 13.7%, range -10.7..84%), 1.4% at 64 and 4.5% at 256; eager is 28.7%, 17.0%, 13.2%.
  At ~100K exec/s the per-run grace timer (set, cleared) is a visible fraction of a ~10 microsecond
  run. The spread is wide (the machine was not idle), so only the direction is firm.
- What lazy does NOT measure: the cost a run pays once it outlives the grace. That path is the eager
  protocol (S7f's I/O-bound rows: 1-2% where the store is not saturated).

### Round-2 re-run (after removing the classifying read; both id styles)

Review found that a classifying `hasSequenceZero` read on every caller-chosen `start` made the sentence above
false. The read is gone: every `start` goes lazy, and an existing stream is refused by the sequence-0 bootstrap
(ADR 0103) before any effect, with the loser's grace timer cancelled and no lease row written (tested, including
two racing lazy starts of one id on two nodes). Re-measured on Postgres 17 (loopback, throwaway cluster, own
`loombench` database), Apple M2, desktop not idle, N = 5 repeats, OFF/EAGER/LAZY interleaved, medians, 3,000
executions per cell (`LOOM_BENCH_IDS=caller|minted`, new in this round). **Caller-chosen ids** (`executionId`
supplied, which pays the sequence-0 barrier in all three modes) and **minted ids** (runtime-minted ulid):

| ids | shape | conc | off exec/s | eager exec/s | lazy exec/s | eager overhead | lazy overhead | lazy paired median (min..max) |
|---|---|---:|---:|---:|---:|---:|---:|---|
| caller | noop | 16 | 5,842 | 4,095 | 5,830 | 29.9% | 0.2% | 1.0 (-5.6..31.9)% |
| caller | noop | 64 | 5,974 | 4,109 | 5,840 | 31.2% | 2.3% | 2.3 (-1.7..36.1)% |
| caller | noop | 256 | 5,812 | 3,912 | 5,462 | 32.7% | 6.0% | -0.5 (-6.7..30.6)% |
| caller | io | 16 | 591 | 562 | 587 | 4.8% | 0.7% | 3.8 (-3.9..6.2)% |
| caller | io | 64 | 2,750 | 2,652 | 2,729 | 3.6% | 0.8% | 0.9 (-1.8..31.3)% |
| caller | io | 256 | 5,317 | 3,900 | 5,302 | 26.6% | 0.3% | 0.6 (-60.3..1.1)% |
| minted | noop | 16 | 4,983 | 3,795 | 5,329 | 23.9% | -6.9% | -6.7 (-15.6..2.3)% |
| minted | noop | 64 | 5,061 | 3,824 | 5,247 | 24.4% | -3.7% | -2.0 (-6.6..22.1)% |
| minted | noop | 256 | 4,701 | 2,853 | 4,395 | 39.3% | 6.5% | 5.5 (-12.2..14.8)% |
| minted | io | 16 | 607 | 603 | 608 | 0.6% | -0.3% | -0.3 (-1.2..1.8)% |
| minted | io | 64 | 2,794 | 2,711 | 2,796 | 2.9% | -0.1% | -0.1 (-0.6..5.9)% |
| minted | io | 256 | 4,394 | 2,935 | 4,703 | 33.2% | -7.0% | -2.5 (-114.0..39.8)% |

Both id styles meet the gate on Postgres: lazy is at most 6.5% on the no-op ceiling and at most 0.8% at
I/O-bound concurrency 16 and 64 (the 256 cell is write-bound and reads like a no-op cell). Eager is 24-39%,
reproducing S7f. Some lazy samples are single outliers (the paired max columns, e.g. 31.9%, are one slow repeat
in the same run, where the OFF side was also noisy); the medians and the id-style comparison are the firm part.
Caller vs minted does not differ for lazy beyond noise, which is the point: caller-chosen starts pay no extra
read for lazy classification.
