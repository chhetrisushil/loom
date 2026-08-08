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
*widen* the no-regression margin. See [ADR 0015](adr/0015-dsa-performance-optimizations.md#amendments).

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

Throughput plateaus by c=8 and *regresses* at c=128 while the tail blows out ~100×. Adding
in-flight writes past the plateau buys latency, not capacity.

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
the writer, not just the readers. Interest-filtered or partitioned delivery is the
prerequisite for horizontal scale-out, ahead of any sharding work.

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

### …but snapshot cadence is what caps the win — `snapshotEvery` mostly does not fire

Read falloff across the sweep only improved from ~5.75× to ~4.17×, not to ~1×. Probing why
turned up a separate and larger defect: on a 102-event execution with `snapshotEvery: 2`,
**exactly one snapshot is stored, at sequence 2**, leaving a 99-event tail to fold on every
read.

`maybeSnapshot` (`WorkflowRuntime.ts:1089`) fires only when `sequence % every === 0` **and**
no save is in flight. The first checkpoint starts an async save; every cadence point that
passes while it is pending is skipped, and because the trigger requires an exact multiple,
a skipped point is never retried. A fast execution commits its whole log inside that first
save, so it snapshots once, near the start. The code comment claims a skipped cadence is
"caught by the next tick" — the next tick is another exact multiple, so in practice it is
not.

Consequence: for fast-completing executions `snapshotEvery` does not bound replay at all,
which caps both this read fix and any recovery-time claim that rests on snapshots. Not
fixed here — it is a behavioural change with a real write-amplification trade-off.

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
