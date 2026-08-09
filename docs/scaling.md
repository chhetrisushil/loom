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

**Concurrency past c≈8 buys latency, not capacity. [measured]** Throughput plateaus at
c=8 (22.4K events/sec) and *regresses* at c=128 (17.8K) while p99 goes 0.63ms → 37.8ms.
If you are tuning pool sizes upward hoping for throughput, you are trading tail latency for
nothing.

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

Six implementations ship **[code]**: three backends (`InMemoryAsyncEventStore`,
`SqliteEventStore`, `PostgresEventStore`) and three *decorators* that wrap any store —
`TenantScopedEventStore` (key-prefix isolation), `EncryptingEventStore` (field-level
crypto), `ContentResolvingEventStore` (payload externalization).

That pattern is the lever. `defineConfig` accepts `storage: { kind: "custom", eventStore,
snapshotStore, branchRegistry? }` **[code]**, so anything satisfying the `EventStore`
interface composes in without touching `@loom/app`, the kernel, or the ABI. Every scaling
change in section 3 is a decorator, not a kernel change — which is the placement answer
Loom's own triage discipline (P10, bias outward) demands.

### Already available, and worth using first

| capability | what it gives you | where |
|---|---|---|
| **Payload externalization** | Large payloads move out of the hot `events` table into a content store; `getMany` batches resolution (~44× over serialized reads) | `plugins/content` (ADR 0062) |
| **Snapshot cadence** | `snapshotEvery` bounds replay tail length | `WorkflowRuntime` |
| **Log compaction** | `truncatePrefix` drops the pre-snapshot prefix (keeps seq 0 as anchor) | `EventStore` SPI |
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
- **Interest-filtered event delivery** — `PostgresEventStore` broadcasts on one global
  channel; filtering is client-side **[code]**.
- **Log partitioning / sharding** — nothing. One `events` table, one primary. No
  consistent-hash routing, no multi-primary support, nowhere in the codebase **[code]**.
- **Cross-execution append coalescing** — nothing, and not in any ADR.

---

## 3. The changes, ranked by evidence — not by size of the number

This ordering deliberately does **not** lead with the biggest headline multiplier.

### 3.1 Interest-filtered notify delivery — SHIPPED (ADR 0074 D4)

**Status: implemented.** `PostgresEventStore` now publishes and LISTENs on bucketed
channels (`notifyBuckets`, default 16), so a node receives only the buckets it holds
subscriptions for. `notifyBuckets: 1` keeps the legacy single-channel behaviour verbatim as
a rolling-upgrade escape hatch. The backend-independent half — the subscriber registry and
the interest set a transport narrows on — is `SubscriberRegistry` in
`packages/event-runtime`, so a bring-your-own backend writes only its transport.

The measurements below are what motivated it.

Every append fires `pg_notify` on a single global channel, and every subscribing node
receives every event and filters client-side **[code]**. The measured cost **[measured]**:

| variant (c=128) | events/sec |
|---|---:|
| without the notify CTE | 30,884 |
| shipped | 19,453 |
| shipped + 16 **idle** LISTEN connections | 9,886 |

Notify alone costs ~37% of append throughput. Sixteen listeners subscribed to *nothing in
particular* halve it again — delivery measured at exactly 16 notifications per appended
event. This is O(events × nodes), and critically **the cost lands on the writer**, not just
on readers. It gets worse with every node you add, which makes it the thing that breaks
horizontal scale-out specifically.

There is a further multiplier: `onNotify` issues a `SELECT` per notification to fetch the
event row **[code]**, so each interested node adds a round-trip per event on top.

**Why this is the cleanest change in the document:** `EventStore.subscribe(executionId,
handler)` is *already* per-execution. The interest scope exists in the API — only the
Postgres transport ignores it. So this is a transport-internal fix: no SPI change, no
kernel change, no event-schema change, no ADR conflict. Options, cheapest first:

1. **Per-execution channels** — `LISTEN loom_events_<hash(executionId)>` over a fixed
   channel space, so a node receives only buckets it subscribes to.
2. **Carry the payload in the notification** to eliminate the follow-up SELECT (bounded by
   the 8000-byte NOTIFY limit — falls back to a fetch when over).
3. Drop to a purpose-built bus (Redis, NATS) behind the same `subscribe` seam if Postgres
   delivery stays the constraint.

Option 1 alone should recover most of the fan-out cost. **[open]** — the specific recovery
is still unmeasured (nothing implements it yet), but the cost being recovered is now
measured end-to-end. Scenario H forks **real subscriber processes** rather than idle
listeners, so `onNotify`'s per-notification `SELECT` is included:

| subscriber nodes | writer events/sec (2 runs) |
|---|---:|
| 0 | 18,096 · 21,175 |
| 2 | 12,521 · 12,742 |
| 4 | 8,275 · 10,223 |

**2.19× / 2.07× writer throughput lost to 4 subscriber nodes**, with delivery confirmed at
exactly 1 notification per node per event. For scale: 16 *idle* listeners cost ~1.97×, so
**4 real nodes cost about what 16 idle ones did** — the gap is the per-event `SELECT`. The
idle-listener approximation understated fan-out by roughly 4× per node.

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

### 3.3 Batching — SHIPPED as a decorator (ADR 0074 D2), worth 2.3–4.3×

**Status: implemented as `CoalescingEventStore` + the optional `appendBatch` SPI hook.**
Measured end to end on Postgres: **2.3×** at the default `maxBatch: 16`, **4.3×** at 64.
Opt-in — inert unless wired into `storage`.

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
scatter-gather preserving the lexicographic contract; cross-shard fork degrades to the
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

## Re-measuring

```bash
LOOM_TEST_POSTGRES_URL=postgres://… pnpm --filter @loom/bench-throughput bench
```

See `tools/bench-throughput/README.md`. Absolute numbers are host-relative — compare
relative movement between scenarios on one host, and re-capture a baseline on the hardware
you intend to quote.

Scenario coverage: A–F as described above, plus **G** (cross-execution coalescing with
per-row fencing) and **H** (multi-node fan-out with real forked subscriber processes).

Reading notes: section F's ops/sec column carries tail-outlier noise on long logs — compare
p50. Section G's absolutes are noisy run to run; compare the ratio against section B at the
same batch size, and repeat runs before quoting a number. Section H is stable across runs.

Remaining gap: every measurement is single-host loopback Postgres. Scenario H's "nodes" are
separate processes on one machine, which captures the per-node `SELECT` amplification and
the notify broadcast but not real network latency or a contended NIC. A genuinely
distributed run would likely make the fan-out cost worse, not better.
