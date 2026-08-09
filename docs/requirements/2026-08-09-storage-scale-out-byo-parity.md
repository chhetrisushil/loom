# Storage scale-out with bring-your-own-backend parity

- Status: **Accepted and implemented** — [ADR 0074](../adr/0074-storage-scale-out-decorators.md).
  R1–R8 all shipped; measured result in [benchmarks](../benchmarks.md) (coalescing 2.3–4.3×
  end to end on Postgres).
- Method: the ADR 0051 discipline — a placement verdict (kernel / package / 1P plugin /
  3P plugin) per item, judged against the best userland alternative, bias outward (P10).
  Every throughput claim below is measured (`tools/bench-throughput`,
  [baselines](../benchmarks.md)) or explicitly marked unmeasured.
- Supersedes the placement in [`scaling.md` §3](../scaling.md) as first drafted, which put
  the coalescer and the sharded store in `plugins/postgres`.

## 0. The requirement

Two things at once:

1. Raise the durable write ceiling far enough to matter — the measured baseline is
   **~5.7K exec/sec** (1-step flow, no-op effect) against a single Postgres primary, and
   the log is the bottleneck, not the interpreter.
2. **Anyone bringing their own `EventStore` must get the scaling benefit too.** Work that
   lands only in `plugins/postgres` fails this outright.

(2) is the binding constraint and it is what forced the placement correction below.

## 1. Factual basis

| # | Fact | Evidence |
|---|---|---|
| F1 | The event log is the ceiling, not the interpreter. 1-step and 3-step flows differ 2.3× in exec/sec but both land at ~20–23K events/sec | benchmarks §D |
| F2 | Worker scale-out (`PlacementDispatcher`, `worker-remote`, `cloudrun`) cannot raise it — every worker writes the same log | F1 |
| F3 | `pg_notify` costs ~37% of append throughput; **4 real subscriber nodes cost 2.07–2.19×**, and delivery is exactly 1 notification per node per event | benchmarks §C, §H |
| F4 | The idle-listener approximation understated fan-out ~4× per node — the gap is `onNotify`'s per-event `SELECT` | benchmarks §H vs §C |
| F5 | Journal-side group commit cannot fill a batch: `ExecutionJournal` is per-execution, a 1-step flow emits 4 envelopes | benchmarks §B, ADR 0065 gate 2 |
| F6 | Cross-execution coalescing reaches 0.55–0.65× of the same-execution batch shape, still ~4–8× over per-event append | benchmarks §G |
| F7 | The local-subscriber registry is **triplicated** across `InMemoryAsyncEventStore`, `SqliteEventStore`, `PostgresEventStore` | source |
| F8 | `LogLifecycle.reclaim` archives with a serialized per-event `append` loop | `LogLifecycle.ts` |
| F9 | `postgresStorage({ url })` builds a **separate pool per store** | `preset.ts` |
| F10 | Every optional `EventStore` method already ships with a working fallback (`readRange`→`readFrom`+filter, `copyPrefix`→append loop) | `types.ts` |

## 2. The placement rule this establishes

> **Capability in packages; optimization in plugins.**
>
> A mechanism that composes over *any* `EventStore` belongs in `packages/event-runtime`
> as a decorator. A plugin's only job is implementing an optional SPI hook efficiently for
> its backend. Optional hooks always ship with a working fallback (F10), so a backend that
> implements nothing still runs — it just does not get that hook's win.

Precedent: `TenantScopedEventStore` is already exactly this shape — a decorator in
`packages/event-runtime` that works over any backend.

## 3. Verdicts

### R1 — `SubscriberRegistry` → **package** (`packages/event-runtime`)

The local subscriber map, self-send dedupe, and local fan-out are backend-independent and
currently triplicated (F7). Extract; every store composes it. A BYO backend then implements
only the genuinely backend-specific part — which topics/channels to subscribe upstream.

Not kernel: no syscall, no event type, no fold.

### R2 — `appendBatch?` on the `EventStore` SPI → **package** (SPI) + **plugin** (impl)

Optional method, `EVENT_STORE_SPI_VERSION` 1.2.0 → **1.3.0**. Semantics: equivalent to N
sequential `append` calls, **atomic per execution**, fencing honoured per envelope, empty
input a no-op. Absent ⇒ callers fall back to per-event `append` via `appendBatchOf`,
byte-identically (F10).

*Amended during implementation.* This was first specified as whole-batch atomic;
conformance caught that `ShardedEventStore` cannot provide it, since separate executions
live on separate logs. Nor is it needed — a batch only groups INDEPENDENT executions, so
nothing in it depends on anything else in it. What a fold depends on is no holes within one
log, i.e. atomicity per execution. A single transactional backend gets whole-batch
atomicity for free; the contract does not require it.

This is the one item a BYO backend must act on to benefit. The win *is* the single
round-trip; nothing above the store boundary can synthesize it. Implementation is typically
small — one multi-row `INSERT`, `BatchWriteItem`, `bulkWrite`, a producer batch.

### R3 — `CoalescingEventStore` → **package** (`packages/event-runtime`)

Merges concurrent appends **across executions** into one `appendBatch`. Corrects the
placement in ADR 0065's frozen sketch, which put group commit inside `ExecutionJournal` —
measured unable to fill a batch (F5). A store decorator sees all executions at once and
can.

Ordering safety: each `ExecutionJournal` still serializes its own execution (D3 unchanged);
the coalescer only groups envelopes from *independent* executions. Durability safety: an
`append` promise resolves only after its batch has committed — never early — so every
`drain()` barrier keeps its meaning.

**Opt-in composition, off unless wired.** See ADR 0074 §"Relationship to ADR 0065" for why
this is outside that ADR's gate rather than a bypass of it.

### R4 — `ShardedEventStore` → **package** (`packages/event-runtime`)

Routes by `hash(executionId)` over N inner stores. **Requires zero backend cooperation** —
a BYO store gets the full horizontal-scale story free, and shards may be heterogeneous.

Consequences to handle explicitly:
- `listExecutions` / `listExecutionsPage` become scatter-gather with a merged cursor. The
  SPI contract is lexicographic ordering, which a k-way merge satisfies.
- Cross-shard `copyPrefix` (fork) has no server-side path; degrade to the documented
  per-event fallback (F10). Same-shard forks keep the fast path.
- Fencing is per-execution, so it shards cleanly with no coordination.
- `BranchRegistry` stays **unsharded** — it is small, and refs are global by nature.

### R5 — Interest-filtered delivery → **plugin** (`plugins/postgres`), on R1

Bucketed channels: `LISTEN loom_events_<hash(executionId) % N>` so a node receives only
buckets it holds subscriptions for, instead of every event in the database. Fixes the
O(events × nodes) broadcast whose cost lands on the *writer* (F3, F4).

Backend-specific by nature — a store on Redis/NATS/Kafka gets interest filtering natively
from topics. R1 is what makes that cheap for them to write.

### R6 — Pool consolidation → **plugin** (`plugins/postgres`)

One shared pool per `postgresStorage()` rather than one per store (F9). At N nodes the
current shape burns 3× the connections, and Postgres `max_connections` binds before
throughput does. Requires care: each store currently believes it owns its pool.

### R7 — Retention/archive throughput → **package** (`packages/workflow-runtime`)

`LogLifecycle.reclaim` archives event-by-event (F8). At 100K exec/sec the ingest is ~34B
events/day and reclamation must run at ingest rate or the table grows without bound. Use
`appendBatch` when the archive store has it (R2). Backend-agnostic; benefits every backend
that adopts R2.

### R8 — Conformance coverage → **package** (`packages/conformance`)

`runEventStoreConformance` gains `appendBatch` coverage, skipped when the method is absent:
equivalence with N appends, atomicity, fencing, empty-input. This is what makes "BYO
benefits too" testable rather than aspirational — a third-party author runs the same suite
the first-party stores run.

## 4. Rejected / not now

| Item | Verdict |
|---|---|
| Group commit inside `ExecutionJournal` | **Rejected on measurement** (F5) — cannot fill a batch. Placement moves to R3. |
| Durability classes / ephemeral runs / flush-boundary semantics | **Stays rejected** (ADR 0065). Rejected on invariants, not cost; no benchmark reopens them. |
| A `ShardedBranchRegistry` | Not now — refs are global and small (R4). |
| Kernel changes of any kind | None required. `KERNEL_ABI` stays 1.1.0; `EVENT_SCHEMA_VERSION` stays 1.17.0. |

## 5. What this does *not* claim

- No item here is validated against a **real workload**. Every number comes from a no-op
  effect, which is exactly what ADR 0065 gate 1 excludes. These changes raise a measured
  ceiling; they do not demonstrate that any real deployment is against it.
- All measurements are single-host loopback Postgres. Scenario H's "nodes" are processes on
  one machine — no network latency, no contended NIC. A distributed run would likely make
  fan-out worse, not better.
- The recovery from R5 is **unmeasured**: the cost is measured, the fix's benefit is not,
  because nothing implements it yet. Scenario H has the shape to measure it after.

## 6. Sequencing

R1 → R2 + R8 → R3 → R4 → R5 → R6 → R7. R1 first because it is a prerequisite for R5 on any
backend and removes triplicated code today; R4 before R5 because sharding needs no backend
cooperation and so delivers the BYO parity requirement soonest.
