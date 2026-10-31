# Scaling Loom past 100K QPS

A capacity guide grounded in [measured baselines](benchmarks.md), not projections. It
answers three questions in order:

1. **Is your workload even in the regime where this matters?** (Usually: no.)
2. **What scaling support exists today**, and how do you compose it?
3. **What would have to change** to go further — and what evidence each change is waiting
   on, so nobody builds a speculative primitive.

Every claim below is tagged with how it is known:
**[measured]** = from `tools/bench-throughput` against a real Postgres ·
**[code]** = read from the source, not benchmarked ·
**[open]** = neither; stated as a hypothesis.

---

## 0. First, check which regime you are in

"100K QPS" is not one question. Loom has two execution paths with cost structures two
orders of magnitude apart, and the answer is entirely different depending on which one your
traffic lands on.

| path | entry point | writes | measured ceiling |
|---|---|---|---|
| **Transient** | `runtime.invokeTransient` | none, structurally | **~1.1M calls/sec** per process **[measured]** |
| **Durable** | `runtime.start` | `2*steps + 2` envelopes | **~5.7K exec/sec** (1-step flow) **[measured]** |

**If your 100K QPS is read-shaped — hydration, lookups, rendering over an immutable
manifest — you do not have a scaling problem.** `invokeTransient` holds no event store, no
journal, and no fence ([ADR 0066](adr/0066-transient-effect-invocation-facade.md) D2/R1),
so it writes nothing by construction. One process already exceeds 100K/sec of *kernel*
overhead; size the fleet for what your effect actually does, put it behind a load balancer,
and stop reading this document. There is no shared coordination on that path to contend on.

The rest of this guide is about the durable path.

### The ceiling is not the target

Before planning around ~5.7K exec/sec, understand what that number is: a **no-op effect**
ceiling, deliberately constructed to remove everything except kernel and store cost.

Real Loom workloads are agent runs, LLM calls, and tool invocations — seconds long and
I/O-bound. Sustaining 5.7K exec/sec of 2-second steps would require **~11,000 concurrent
executions**. Long before the event log became your constraint you would hit process memory
(one `ExecutionJournal` + folded VM state per live execution **[code]**), your model
provider's rate limit, and your effect concurrency budget.

**So: profile before you optimise the log.** If event-write throughput is not what your
profile shows saturating, nothing in sections 2–4 will help you, and several items will
make your system more complex for no gain. This is the same discipline
[ADR 0065](adr/0065-group-commit-deferred-evidence-gate.md)'s evidence gate encodes.

---

## 1. Where the durable ceiling actually comes from

Two findings from the benchmark set, and one from reading the code, that together explain
the number.

**The log is the bottleneck, not the interpreter. [measured]** A 1-step flow does 5,695
exec/sec and a 3-step flow 2,488 — but *both* land at ~20–23K events/sec, the same ceiling
as raw `append` in isolation. Execution throughput is simply that ceiling divided by
envelopes per execution. This is the single most important structural fact here, and it has
a direct consequence: **worker scale-out does not raise it.** `PlacementDispatcher`,
`worker-remote`, and `cloudrun` move *compute*; every one of those workers still writes to
the same log.

**Write-path concurrency past c≈8 buys latency, not capacity. [measured]** Raw append
throughput is flat at ~20K events/sec from c=8 all the way to c=1024, while p50 latency
grows linearly (0.32 ms → 48 ms). If you are tuning pool sizes upward hoping for throughput,
you are trading tail latency for nothing. (An earlier reading of this as *regressing* at
c=128 was noise; the wider sweep shows a flat plateau.)

**Execution-layer concurrency is a different thing, and it does scale. [measured]** An
execution with a slow effect is barely writing at all, so concurrency there buys real
throughput: a 1-step flow with a 100 ms effect scales near-linearly to **c=512** at ~90% of
Little's Law (4,025 exec/sec), then plateaus at ~4–5K exec/sec — the write ceiling — with
further concurrency converting to latency (p50 105 → 381 ms). Do not read the write-path
result as a reason to cap execution concurrency at 8.

**Reads do not benefit from snapshots today. [code]** `WorkflowRuntime.foldState`
(`packages/workflow-runtime/src/WorkflowRuntime.ts:843`) unconditionally calls
`eventStore.read(executionId)` — the *entire* log — then, if a snapshot exists, throws that
result away and issues a second `readFrom(snapshot.sequence + 1)`. Snapshots bound the fold
CPU but not the I/O. This compounds badly: `liveQuery` re-folds via `loadState` on every
event **[code]**, so a live subscriber on an N-event execution reads O(N) rows per event —
O(N²) over its lifetime. Not benchmarked, but it is a plain read of the code, and it is
almost certainly a bug rather than a design choice.

---

## 2. What scaling support exists today

The audit. Compose these before changing anything.

### The EventStore is a decorator seam — this is the main extension point

Three backends ship **[code]** (`InMemoryAsyncEventStore`, `SqliteEventStore`,
`PostgresEventStore`), along with the decorators that wrap any store:

| decorator | what it adds | optional SPI it refuses |
|---|---|---|
| `TenantScopedEventStore` | key-prefix isolation | none |
| `EncryptingEventStore` | field-level crypto (retention/compaction guarded by the ADR 0022 key rule) | none |
| `ContentResolvingEventStore` | payload externalization | none |
| `hashChainedEventStore` | tamper-evident chain (`@loom/plugin-audit-chain`) | `truncatePrefix` and `truncatePrefixKeeping`, because a compacted log fails `verifyChain` |
| `CoalescingEventStore` / `ShardedEventStore` / `ProfilingEventStore` | batching, partitioning, write profiling (section 3) | none |
| `TenantScopedSnapshotStore` / `ProfilingSnapshotStore` | snapshot key-prefix isolation, snapshot size profiling (below) | none |

Every one of them forwards, overrides or explicitly refuses each optional method (a
`DecoratorPlan` via `installOptional`, ADR 0074 Amendment). Each is also held to
`runEventStoreDecoratorConformance`, which runs the whole SPI suite *through* it. A decorator
that silently drops a method takes that capability away from everything above it. Until
2026-09-27 four of them dropped `appendBatch`, which is why the composition in 3.3 got no
batching. A bring-your-own decorator proves itself with the same kit.

That pattern is the lever. `defineConfig` accepts `storage: { kind: "custom", eventStore,
snapshotStore, branchRegistry? }` **[code]**, so anything satisfying the `EventStore`
interface composes in without touching `@loom/app`, the kernel, or the ABI. Every scaling
change in section 3 is a decorator, not a kernel change — which is the placement answer
Loom's own triage discipline (P10, bias outward) demands.

### Already available, and worth using first

| capability | what it gives you | where |
|---|---|---|
| **Payload externalization** | Large payloads move out of the hot `events` table into a content store; `getMany` batches resolution (~44× over serialized reads) | `plugins/content` (ADR 0062) |
| **Snapshot cadence** | `snapshotEvery` bounds replay tail length; pair it with `onStorageError`, the only channel a failed checkpoint has | `defineConfig` or `WorkflowRuntime` |
| **Log compaction** | `truncatePrefix` drops the pre-snapshot prefix (keeps seq 0 as anchor); `truncatePrefixKeeping` also keeps the app's pinned event kinds (ADR 0106) | `EventStore` SPI |
| **Retention sweeps** | `deleteExecution` + keyset-paged `listExecutionsPage` for bounded-memory maintenance at year scale | SPI 1.2.0 |
| **Read models** | Durable cross-execution index so queries stop scanning logs; idempotent rows + per-execution watermarks | `plugins/read-model` (ADR 0058) |
| **Compute placement** | Route executions to local / remote-HTTP / Cloud Run targets by policy | `PlacementDispatcher` (ADR 0001/0003) |
| **Fair scheduling** | Per-tenant concurrency fairness; zero-overhead `Infinity` fast path | `packages/fair-scheduler` (ADR 0038) |
| **Tenant isolation** | Key-prefix scoping, unaddressable across tenants by construction | `TenantScopedEventStore` (K12.5) |
| **Selector subscriptions** | Wake a surface only when its bound slice changes | `ProjectionRuntime` (ADR 0068) |

**Payload externalization and read models are the two most under-used.** Neither needs a
kernel change, both are shipped, and both attack real causes: row width on the write path,
and log scans on the read path.

### Not available today

- **`appendBatch` / group commit** — designed and frozen, deferred behind an evidence gate
  (ADR 0065). Not implemented.
- **Writer-side NOTIFY fan-out** — `PostgresEventStore` now buckets delivery (section 3.1),
  which fixes client-side filtering and the per-notification `SELECT`. It does **not** fix
  the cost landing on the writer: that scales with the number of LISTENing backends,
  independent of channel, and is unsolved **[measured]**. `CoalescingEventStore` is the
  available mitigation (section 3.3).
- **Log partitioning / sharding** — nothing. One `events` table, one primary. No
  consistent-hash routing, no multi-primary support, nowhere in the codebase **[code]**.
- **Cross-execution append coalescing** — nothing, and not in any ADR.

---

## 3. The changes, ranked by evidence — not by size of the number

This ordering deliberately does **not** lead with the biggest headline multiplier.

### 3.1 Interest-filtered notify delivery — SHIPPED, client-side only (ADR 0074 D4, amended 2026-09-28)

**Status: implemented, but narrower than first claimed.** `PostgresEventStore` now
publishes and LISTENs on bucketed channels (`notifyBuckets`, default 16), so a node
receives only the buckets it holds subscriptions for instead of every event in the
database. `notifyBuckets: 1` keeps the legacy single-channel behaviour verbatim as a
rolling-upgrade escape hatch. The backend-independent half — the subscriber registry and
the interest set a transport narrows on — is `SubscriberRegistry` in
`packages/event-runtime`, so a bring-your-own backend writes only its transport.

Bucketing fixes exactly two things: client-side filtering (a node no longer receives, and
discards, events for executions it has no interest in) and the follow-up `SELECT` volume
(fewer deliveries ⇒ fewer per-notification row fetches). **It does not fix the cost that
lands on the writer.** That cost turned out to be per LISTENing backend on the
database, independent of which channel it LISTENs on — bucketing changes what a listener
*receives*, not how many backends the writer has to signal. This was verified against a
prior "SHIPPED" claim in this section that turned out to be wrong: `tools/bench-throughput`
section C was still LISTENing on the pre-bucketing global channel while the store had moved
to bucketed channels, so it measured "0 delivered" every run — a vacuous, self-contradicting
result that shipped for a release. `attachListeners` now takes the real channel list and the
bench fails outright (`assertDelivered`) if a listener set that should receive something
receives nothing.

**Pre-bucketing measurements (what motivated bucketing in the first place) [measured]:**

| variant (c=128) | events/sec |
|---|---:|
| without the notify CTE | 30,884 |
| shipped (pre-bucketing, single global channel) | 19,453 |
| + 16 **idle** LISTEN connections on that channel | 9,886 |

Notify alone cost ~37% of append throughput; 16 listeners subscribed to *nothing in
particular* (the pre-bucketing shape — every listener held the global channel) roughly
halved it again, with delivery of exactly 16 notifications per event.

**Post-bucketing measurements, re-captured against the fixed bench (own throwaway PG 17,
Apple M2, 8 cores, single host, shared with other local work — see the machine caveat below)
[measured]**, 4 runs at c=128, 16 listeners:

| variant | events/sec (4 runs) | vs. no-listener baseline (same run) |
|---|---|---:|
| no listeners (baseline) | 14,651 – 21,330 | 1× |
| 16 listeners on an **unrelated** channel (nothing published there) | 10,041 – 16,726 | **1.18× – 1.73×** |
| 16 listeners on the real bucket channels (full interest — receives every event, 16/event) | 11,202 – 12,975 | **1.22× – 1.90×** |

The unrelated-channel row is the finding: listeners that receive **zero notifications**
still cost the writer nearly as much as listeners receiving every notification. Bucketing
narrows *what* a listener receives; it does not reduce *how many backends the writer has to
signal*, and that signalling is where most of the cost is. This reading of PostgreSQL's
notify internals (one global, in-memory notify queue that every LISTENing backend on the
database is signalled from, independent of channel) is **[open]** as a mechanism — the
measurement above is what is confirmed.

**Real subscriber processes (scenario H), re-captured — 3 runs, discarding one run that
showed a simultaneous 5–10× slowdown across every H row including the baseline, consistent
with contention from other work on the shared host, not the fan-out mechanism itself:**

| subscriber nodes, shared interest | writer events/sec (3 runs) |
|---|---:|
| 0 | 16,759 – 20,414 |
| 2 | 8,218 – 15,297 |
| 4 | 7,755 – 9,964 |

**1.68× – 2.63× writer throughput lost to 4 subscriber nodes** (consistent with the
pre-bucketing 2.07–2.19× within run-to-run noise), with delivery confirmed at exactly 1
notification per node per event — bucketing did not move this number, because every node in
this variant subscribes to every execution.

A **disjoint-interest** variant (each node subscribed to its own non-overlapping share of
executions, `partitionDisjoint`) confirms bucketing's actual, narrower benefit: delivered
notifications per node per event drop to `1/nodeCount` exactly (1.0 → 0.5 → 0.25 for
2/4 nodes), matching the bucket filter working as designed. Writer throughput does **not**
track a clean prediction from that alone — across runs it sometimes matched shared interest
at the same node count and sometimes measured visibly higher, most plausibly because fewer
per-node `onNotify` SELECTs freed CPU/connections that the writer was contending for **on
this same single-host loopback Postgres** (see the re-measuring caveat below), not because
the writer's own signalling cost went down. A distributed deployment would not get that
side effect.

**The available mitigation is `CoalescingEventStore` (section 3.3), not a transport
change.** Batching appends means one notifying commit per BATCH instead of per event, which
amortizes the per-commit signalling cost that the per-event path pays regardless of
channel. Measured recovery, coalesced writer vs. the uncoalesced 4-node case (3 valid runs):
**1.21× – 1.54×**.

**Transport options for the writer-side cost, considered and rejected for now** (see the
[ADR 0074 amendment](adr/0074-storage-scale-out-decorators.md) for the full analysis): a
separate batched notifier connection (the same amortization `CoalescingEventStore` already
gives), watermark polling instead of LISTEN, and a Redis/NATS bus behind `subscribe` as a
3P plugin. `CoalescingEventStore`'s measured headroom is enough that none of these earn
their complexity today; revisit if a real multi-node deployment is still writer-bound after
coalescing.

### 3.2 The read path — fixed, and what it revealed

**Status: [measured]. Fixed; a larger adjacent defect is not.**

`foldState` used to read the entire log before checking for a snapshot, then discard it —
snapshots bounded fold CPU but not I/O. It now loads the snapshot first and reads a bounded
tail plus a one-row existence anchor. Measured (`snapshotEvery: 2`, c=16, median of 3):

| log length | p50 before | p50 after |
|---|---:|---:|
| 4 events | 0.72 ms | 0.71 ms |
| 102 events | 4.76 ms | **2.93 ms** |

~1.6× at p50 on a 102-event log, nothing lost on short ones.

One subtlety worth knowing if you touch this: the full read was load-bearing for
"no events ⇒ null". `LogLifecycle` deletes events and then calls
`snapshotStore.deleteExecution?.()` — **optional** — so a retention sweep against a store
that does not implement it leaves an orphaned snapshot. Folding that orphan would hand back
erased state. Existence is now checked against sequence 0 (the bootstrap anchor,
preserved by `truncatePrefix`, removed by `deleteExecution`) in one indexed row read.

**Also fixed: settle-time checkpointing. [measured]**

The read fix alone left ~4× falloff. Cause: on a 102-event execution with
`snapshotEvery: 2`, exactly one snapshot was stored, at sequence 2. `maybeSnapshot` fires
only while the execution is still committing and skips while a save is in flight, so a fast
execution checkpoints once near the start. `suspend` already checkpoints at its tip;
completion did not.

Completion now takes the symmetric checkpoint, gated on `snapshotEvery` being set *and* the
tail having reached it:

| 102-event log, p50 | |
|---|---:|
| before | 4.76 ms |
| bounded read only | 2.93 ms |
| **+ settle checkpoint** | **1.22 ms** |

3.9× cumulative; tail folded on read goes 99 → 0. Cost is one extra snapshot write per
completed execution whose tail reached the cadence — zero with `snapshotEvery` unset (the
default). Residual ~1.6× is snapshot *state* size (50 frames vs 1), not log length.

Worth recording what did **not** work: changing the trigger from an exact multiple to an
interval — the obvious reading of the defect — is inert in both regimes (299 vs 300
checkpoints on a slow workload; no effect at all on a fast one). Dropped rather than shipped
unmeasured.

### 3.3 Batching — SHIPPED as a decorator (ADR 0074 D2), worth 1.5–2.0×

**Status: implemented as `CoalescingEventStore` + the optional `appendBatch` SPI hook.**
Measured end to end on Postgres by section A2 of the throughput harness: **1.5×** at the
default `maxBatch: 16`, **2.0×** at 64. (This page previously said 2.3–4.3×, from a table
no committed scenario could reproduce — see [benchmarks](benchmarks.md).)
Opt-in — inert unless wired into `storage`.

**Compose it outside the other decorators, and check they batch.** The order is sharding, then
coalescing, then tenant scoping / encryption / content resolution / the audit chain, then the
backend. Every decorator between the coalescer and the backend must implement `appendBatch`.
One that does not makes the coalescer fall back to one `append` per envelope. That wins
nothing, and it also loses the batch's atomicity: a failed flush could leave earlier envelopes
durable while their writers were told it failed. The in-repo decorators all implement it as of
2026-09-27 (they did not before). For your own decorator, `runEventStoreDecoratorConformance`
is the check.

**Blast radius.** One stale-fence zombie rejects its whole coalesced batch, so up to `maxBatch`
healthy writers coalesced with it abort too. Nothing of theirs lands, and recovery re-drives
them. That is fine while fencing is rare. If fencing is common in your deployment, lower
`maxBatch`.

**Are your snapshots even big?** Wrap your `SnapshotStore` in `ProfilingSnapshotStore`
(`@loom/snapshot-runtime`) before building anything for snapshot growth. `profile()` reports
saves, total and max bytes, a power-of-two `histogram` and `largest` (the top N executions by
their latest snapshot size); `onLargeSnapshot(executionId, bytes)` fires once when an
execution first crosses `largeThresholdBytes`. Placement decides the question: wrapped OUTSIDE
`EncryptingSnapshotStore` it measures the plaintext state, around the raw backend it measures
what is stored (ciphertext). It costs one extra `JSON.stringify` per measured save, off the
resume path; set `sampleRate` if that shows up, but note sampling can MISS a rare huge snapshot
(a sampled-out save updates neither `largest` nor the hook). The size is the UTF-8 text size of
`JSON.stringify(state)`: SQLite stores exactly that, while Postgres casts to JSONB (normalised
whitespace and key order, TOAST compression), so read the on-disk size there with
`pg_column_size`. A SYNC `onLargeSnapshot` runs on the save path; only an async hook is off it,
and the hook needs `largeThresholdBytes` (the constructor throws otherwise). Memory is bounded
(a top-N heap and an LRU dedupe set), so an execution evicted from the dedupe set may fire
again. Saves that complete out of order never overwrite a newer size, and a prune forgets an
execution only when its latest snapshot was deleted.

**Make snapshots smaller (opt-in zstd codec, [ADR 0140](adr/0140-snapshot-zstd-codec.md)).** The
codec stores each state as zstd-3 compressed JSON behind a format byte: a `state_z BYTEA` column on
Postgres (storage `EXTERNAL`), a BLOB in SQLite's `state` column, a frame in memory. Measured on a
running agent execution at 200 turns (`snapshotCodec.perf.test.ts`, `pnpm test:perf`): 138 KB vs
174 KB as JSONB pglz (0.79x) plain, 13.7 KB vs 27.7 KB (0.49x) claim-checked, and the resume read is
about 1.8x faster (the JSONB server cost, `jsonb_out` plus detoast, is what it removes). Turn it on
with `sqliteStorage({ snapshotCodec: "zstd" })` / `postgresStorage({ snapshotCodec: "zstd" })` (or
`durability: { snapshots: { codec: "zstd" } }` for the stores `defineConfig` builds). It is OFF by
default and needs Node >= 22.15 (it refuses loudly otherwise). Old snapshots stay readable and are never
rewritten; upgrade every node before opting in. With an `EncryptingSnapshotStore` pass
`{ sealState: true, codec: "zstd", lengthLeak: "accept" }` so the state is compressed BEFORE it is sealed (ciphertext does not
compress); the length of the ciphertext then reveals the compressed length (a CRIME/BREACH-style oracle), so the
acknowledgment is required (construction throws without it; `defineConfig` takes
`durability.snapshots.lengthLeak: "accept"`), and `ProfilingSnapshotStore` never reports stored size over a sealing store.
A snapshot store you pass to `defineConfig` whose codec disagrees with `durability.snapshots.codec` makes boot throw.
On Postgres `state` stays `NOT NULL` (a frame row holds a fixed sentinel there so an older node fails loudly). Read a
snapshot with `loom snapshot show <executionId>` (SQL on `snapshots.state` cannot traverse a frame), and
note `ProfilingSnapshotStore` reports stored (compressed) bytes for a zstd store.

**Is your workload even write-bound?** Wrap your store in `ProfilingEventStore` and add
`effectTimingMiddleware` to your effect runtime, run real traffic, and compare
`totalWriteMs` against `totalEffectMs`. The measured crossover is ~2–3 ms of effect latency
(see [benchmarks](benchmarks.md)); above it, batching cannot help you. Typical agent/LLM
effects sit 30–1000× above it.

ADR 0074 records why this is outside ADR 0065's gate rather than a bypass of it: the gate
guarded speculative machinery *inside the kernel* changing durability semantics for
everyone, and a composable store decorator that changes no semantics is a different object.
ADR 0065's gate itself remains unopened — no real workload has been shown bottlenecked on
event writes.

The analysis below explains why the journal-side placement it froze does not work.

The headline is 8.2× (183K events/sec at batch=16) **[measured]**, and it is easy to
misread. That batch holds 16 events *of one execution*. But `ExecutionJournal` is
**per-execution** **[code]** — a 1-step flow emits 4 envelopes, a 3-step flow 8. A
journal-side batcher can never fill 16 for these flows. Batch=4 (3.1×) is the hard ceiling
for a 1-step flow, and even that needs all four envelopes enqueued *before* the serial tail
drains — which happens only when the store is already saturated. With a realistic slow
effect, `STEP_STARTED` and `STEP_COMPLETED` are seconds apart, the tail drains between
them, and the batch collects one envelope. That is exactly ADR 0065 gate 2's
"a 3-events-per-run workload cannot win".

Against the gate, honestly:

| gate | status |
|---|---|
| 1. Write throughput is the bottleneck **on a real workload** | ❌ The harness uses a no-op effect *specifically to remove* effect latency — the opposite of a real workload |
| 2. Win demonstrated on that workload's event mix | ⚠️ Shown for the SQL shape; contradicted for the journal on short flows |
| 3. Transient architecture confirmed insufficient | ❌ Not addressed |

**The 8.2× is only reachable by coalescing across executions** — merging many concurrent
journals' appends into one multi-row INSERT. That is *not* ADR 0065's sketch, and it needs
a per-row fence check (a join against `fences`) plus one notify per execution in the batch,
rather than the single guard section B measured. That cost is now **[measured]** (scenario
G): at a matched batch size the cross-execution shape runs at **0.55–0.65×** of the
same-execution one across two runs — still roughly **4–8× over the shipped per-event
append**, so a coalescer is viable, but budget ~0.6× of B's headline, not B's headline.

Absolute numbers in that scenario are noisy; the fenced-vs-unfenced delta flips sign
between runs and is inside run-to-run variance, so whether the `fences` join specifically
is the expensive part remains **[open]**.
It also belongs in a **store decorator**, not the journal — which is a better placement
anyway (outside the kernel), and preserves ordering because each journal's FIFO still
serializes its own events while the batcher only groups *independent* executions.

If you want to open this properly: run a real workload, profile it, and if writes genuinely
dominate, measure the cross-execution coalescer *with* per-row fencing. Do not implement
from the 8.2× alone.

Do **not** reintroduce durability classes, ephemeral runs, or flush-boundary semantics.
ADR 0065 rejected those on invariants, not on cost — no benchmark reopens them.

### 3.4 Log partitioning — SHIPPED as a decorator (ADR 0074 D3)

**Status: implemented as `ShardedEventStore`.** Routes by `hash(executionId)` over N inner
stores, needs **zero backend cooperation**, and shards may be heterogeneous. Enumeration is
scatter-gather preserving the paging order — Unicode code point order, pinned in EventStore
SPI 2.0.0 ([ADR 0108](adr/0108-execution-id-order-and-fail-soft-migrations.md)) because a Postgres shard used to page in its database collation and the merge
skipped ids (L10); cross-shard fork degrades to the
per-event fallback; an optional capability is advertised only if every shard has it.

Still the LAST thing to reach for — exhaust 3.1–3.3 and vertical scaling first. The
analysis below of what it costs you remains accurate.

Sharding `events` by `hash(execution_id)` across primaries is the only thing that lifts the
single-primary ceiling. The good news is placement: a `ShardedEventStore` decorator routing
by execution id composes exactly like `TenantScopedEventStore` does today **[code]**, so
the kernel and ABI stay untouched.

The hard parts are not the routing:

- **Cross-execution reads.** `listExecutions` / `listExecutionsPage` must scatter-gather;
  read models and retention sweeps consume them.
- **Fencing** is per-execution, so it shards cleanly — but `BranchRegistry` and fork
  (`copyPrefix`) assume one database, and a cross-shard fork loses its server-side path.
- **Rebalancing.** Solved by [ADR 0075](adr/0075-shard-rebalancing.md): supply a
  `ShardPlan` and `plan.rebalanced(n)` marks the moved buckets `migrating`, which is a
  routing change only — **nothing is copied**. Executions already on the source keep being
  served there, new ones start on the destination, and the bucket drains by itself as
  executions complete. Reassignment moves the theoretical minimum (~1/N of buckets, not the
  ~80–89% a naive `bucket % shardCount` would). Two limits stand:
  `migrateExecution()` cannot safely move a *live* execution, and fence state does not
  travel across shards.

Exhaust sections 3.1–3.3 and vertical scaling first. Most systems that think they need
sharding need a read model and interest-filtered delivery.

---

## 4. A practical order of work

1. **Profile.** Confirm event-write throughput is actually your bottleneck. Usually it is
   not — it is effect latency or concurrency limits.
2. **Compose what already ships**: payload externalization, read models for query traffic,
   snapshot cadence + compaction, fair scheduling per tenant.
3. **Move read traffic off the durable path** — `invokeTransient` for anything that does
   not need to be recorded. This is the largest single lever in the document, and it is a
   design choice, not an optimisation.
4. **Fix interest-filtered delivery (3.1)** before adding nodes. It is the change that
   makes horizontal scale-out stop fighting itself.
5. **Fix the read path (3.2)** if you have long-running executions or live subscribers.
6. **Scale vertically**, and re-measure on your own hardware — every number here is
   loopback Postgres on a laptop, which flatters the store.
7. Only then consider batching (3.3) or partitioning (3.4), each behind its own evidence.

## 5. Agent state growth (`agentLoop$` without compaction)

An `agentLoop$` run with no `compaction` journals each turn's whole model input (`<id>#turn:N:input`: the
transcript, re-sent every turn), so its folded state grows **O(turns^2)**, and resume reads the latest
snapshot in full, so resume cost grows the same way. 97-99.9% of the state is those `frames`; tool outputs
and variables are small. **[measured, offline harness]** (issue #721, re-measured 2026-10-31; scaled
`agentLoop$` run with a deterministic offline model, one tool returning 1-4 kB per turn, in-memory stores
whose event store JSON-clones every payload as a durable store does; sizes are `JSON.stringify` of the state
folded from the log, which is what a resume rebuilds). The first #721 table was ~2x too high: its store did
not clone, so every folded frame aliased the one live transcript (issue #722); those figures are retracted.

| Config | Turns | Folded state (what resume reads) | Per-turn growth |
|---|---|---|---|
| no levers | 50 | 3.5 MB | ~105 kB/turn |
| no levers | 200 | 54.9 MB | ~480 kB/turn |
| no levers | 450 | 279 MB | quadratic |
| no levers | 600 / 650 | 497 MB / `RangeError: Invalid string length` serializing the state | V8's ~512 MiB string cap, ~610 turns |
| compaction only (`afterMessages: 20`, `keepRecent: 4`) | 50 / 200 / 1000 | 1.0 MB / 4.2 MB / 21.3 MB | ~21 kB/turn (linear) |
| compaction + claim-check (1 kB cap) | 50 / 200 / 1000 | 153 kB / 639 kB / 3.3 MB | ~3.3 kB/turn (linear) |

The transcript the loop counts (`transcriptBytes`, the figure `warnTranscriptBytes` and `afterBytes` read) is
~2.5 kB per turn here: 128 kB at turn 50, 246 kB at 100, 372 kB at 150, 500 kB at 200, 1.1 MB at 450.

Caveats: offline stubs (a real model's transcript shape differs, but the re-sent-transcript quadratic shape
holds); in-memory stores (on-disk sizes differ, e.g. TOAST); a trivial summarizer; the "latest snapshot" a
live in-process run saves was ~2x the folded figures above until #722 was fixed (the live fold aliased the
transcript). Total bytes written with a small `snapshotEvery` and no pruning are (saves x state), so cubic in
turns; snapshot pruning (`keepLatest: 1`, ADR 0134) removes almost all of that (not re-measured). A Postgres
JSONB value caps at 255 MB, which an uncompacted run reaches near turn 430, before V8's string limit.

**The lever is compaction** (bounds the state), plus claim-check on top. Claim-check alone does not help: it
offloads a tool RESULT's bytes, not the transcript. Compaction is **opt-in** and stays so (ADR 0137), but
loom now tells you when you need it and ships the summarizer:

```ts
effects.register("summarize", createSummarizerEffect(provider)); // you supply the model
agentLoop$(ctx, { definition, modelToolId: "model",
  compaction: { toolId: "summarize", afterBytes: 256 * 1024 } }, input);
```

- With no `compaction`, the loop warns ONCE per run (through `onWarn` / `observability.onWarn`, else a process
  warning `LOOM_AGENT_STATE_GROWTH`) when its transcript passes `warnTranscriptBytes` (default 256 KiB, about
  turn 107 and ~16 MB of state in the harness above; `false` disables). It only reports: the log and replay are unchanged.
- `createSummarizerEffect` is an ordinary effect, so it runs in the capability ring and is journaled once and
  served from the log on replay. Pick `afterBytes` well below the point where resume hurts; the kept suffix is
  at most half of it.
- Folding completed turns' inputs out of the folded state altogether would make state linear for everyone,
  but it is a kernel change that needs its own root-cause read and ADR (not done; since landed as ADR 0138
  part B, which is why the "no levers" folded state above is the pre-fix figure).

**Claim-check the tool outputs (opt-in, ADR 0140).** Tool outputs are ~80% of what is left of a mid-run state,
so the second lever is one line:

```ts
defineConfig({
  storage, flows,
  execution: { claimCheck: { store: contentStore, toolIds: ["export_report"] } },
});
```

A listed tool's result over `inlineCapBytes` (default 1 KiB of JSON) goes to `store` and the log records
`{ __loomClaimCheck, ref, size, digest }`; smaller results stay inline; nothing changes unless you set it.
`toolIds` is required (no "all": the model and summarizer effects must stay inline). **The model does not see an
offloaded tool's result, only its digest**: list only tools whose output it does not need in full (a bulk export
it needs the row count of), never a search whose hits it must read. A tool without a `digests[toolId]` entry
records the default digest `{ preview, truncated: true }` (the first 256 characters of its JSON; `preview: n` or
`false` to change it; never for tainted content, which is recorded as a tainted envelope). Replay and resume read the envelope from the log: zero content-store reads, even after the blobs were
erased. **[measured, offline harness, `claimCheckOptIn.perf.test.ts`, `pnpm test:perf`]** a real `defineConfig`
app and `agentLoop$`, 1.5-4 kB tool output per turn, JSON-cloning log, no compaction:

| Turns | claim-check | Folded state (what resume reads) | Log |
|---|---|---|---|
| 50 | off | 297.8 KB | 4043 KB |
| 50 | on (default preview) | 70.8 KB | 953 KB |
| 50 | on, `preview: false` | 43.0 KB | 551 KB |
| 200 | off | 1201.4 KB | 60421 KB |
| 200 | on (default preview) | 283.4 KB | 13807 KB |
| 200 | on, `preview: false` | 172.1 KB | 7787 KB |

That is 4.2x less state at 200 turns (7.0x without the preview), still linear; the log is still dominated by
the re-sent transcript, which only `compaction` bounds, so use both. **Auditability stays intact**: the
envelopes are marked `retain: true`, so the content sweep never TTL-reclaims a blob while any log, archive or
snapshot cites it; only erasure (or discarding the citing history) frees it. List tool ids in
`claimCheck.reclaimable` only for genuine telemetry (the explicit audit trade). With `security.crypto` the opt-in
is refused at boot (the blobs would be plaintext outside the per-subject keys); with `compliance.erase` the
store must `delete()`, and `eraseSubject` deletes the subject's blobs (keeping an identical blob another subject
still cites) and records it. The ADR 0137 warning names this opt-in too.

## Re-measuring

```bash
LOOM_TEST_POSTGRES_URL=postgres://… pnpm --filter @loom/bench-throughput bench
```

See `tools/bench-throughput/README.md`. Absolute numbers are host-relative — compare
relative movement between scenarios on one host, and re-capture a baseline on the hardware
you intend to quote. The section 3.1 numbers above were captured on a throwaway local PG 17
cluster on an 8-core Apple M2, on a host also running other local work — not a dedicated
benchmark machine — which is exactly why they are reported as 3–4-run ranges rather than
single points; do not read the specific bounds as a portable SLA.

Scenario coverage: A–F as described above, plus **G** (cross-execution coalescing with
per-row fencing) and **H** (multi-node fan-out with real forked subscriber processes: **H1**
shared interest, **H2** disjoint interest, **H3** a coalesced writer). Section C also LISTENs
on the real bucket channels the store publishes on (not the legacy channel — a prior version
of this bench got that wrong; see 3.1) and on a channel nobody publishes to, and fails the
run outright (`assertDelivered`) if a listener set that should receive something delivers
zero.

Reading notes: section F's ops/sec column carries tail-outlier noise on long logs — compare
p50. Section G's absolutes are noisy run to run; compare the ratio against section B at the
same batch size, and repeat runs before quoting a number. **Section H is NOT stable across
runs** (corrected — a prior version of this document claimed it was): writer throughput
under fan-out varied 1.68×–2.63× loss at 4 nodes across otherwise-identical repeat runs, and
one run showed every H row simultaneously degrade 5–10×, consistent with contention from
other processes on the host rather than the mechanism being measured. Run it more than
once, on an otherwise-idle host, before quoting a number from section H.

Remaining gap: every measurement is single-host loopback Postgres. Scenario H's "nodes" are
separate processes on one machine, which captures the per-node `SELECT` amplification and
the notify broadcast but not real network latency or a contended NIC. A genuinely
distributed run would likely make the fan-out cost worse, not better. H2's writer-throughput
numbers in particular may be a single-host artifact (see 3.1) rather than a fan-out result
that would reproduce across a real network.
