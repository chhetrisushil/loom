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

### Batching is worth ~8×, and the sweet spot is bounded

`appendMany` is **not a shipped path** — this is the counterfactual for adding it to the
`EventStore` SPI, measured with the same fence guard and one `pg_notify` per batch tip.

| batch | events/sec | vs shipped | p95 ms |
|---|---:|---:|---:|
| 1  | 15,821  | 0.7×  | 16.3 |
| 4  | 69,456  | 3.1×  | 7.8 |
| 16 | **183,141** | **8.2×** | 19.8 |
| 64 | 143,857 | 6.4×  | 143.3 |

Batch 16 is the knee; 64 regresses on both throughput and tail. A group-commit flush in
`ExecutionJournal` bounded at ~16 envelopes is the single highest-leverage change
available on the write path — one optional SPI method, no kernel semantics touched.

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

ADR 0065 R1 holds under load: zero envelopes. ~195× the durable 1-step rate, because it
writes nothing. On this path the kernel is not the constraint — the effect's own work is.

### Takeaway for capacity planning

- **Durable executions: ~5.7K/sec** per runtime + single Postgres primary for a 1-step
  flow. 100K/sec of that shape is **18×** this capacity, and because every write lands on
  the same log, that multiplier falls on Postgres — worker scale-out
  (`PlacementDispatcher`, `worker-remote`, `cloudrun`) does not help.
- Batched append (~8×) plus interest-filtered delivery gets a single primary into the
  ~45–50K exec/sec range on these numbers. Past that needs a partitioned log.
- **Stateless/transient: not a scaling problem.** One process already exceeds 100K/sec of
  kernel overhead; size for the effect, not the runtime.
