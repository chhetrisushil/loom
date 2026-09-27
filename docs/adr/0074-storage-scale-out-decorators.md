# ADR 0074 — Storage scale-out as composable decorators, not backend features

- Status: **Accepted** (2026-08-09)
- Date: 2026-08-09
- Builds on: [ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md) (adapters live in `plugins/`),
  [ADR 0065](0065-group-commit-deferred-evidence-gate.md) (group-commit deferral — amended
  here on placement), [ADR 0033](0033-spi-conformance-contracts.md) (the `EventStore` SPI and its
  optional-with-fallback discipline), K12.5 `TenantScopedEventStore` (the decorator
  precedent), and the measured baselines in [`benchmarks.md`](../benchmarks.md).
- Requirements: [storage scale-out with BYO parity](../requirements/2026-08-09-storage-scale-out-byo-parity.md).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged
  (1.1.0); EVENT_SCHEMA unchanged (1.17.0)** — no syscall, no event type, no fold change.
  `EVENT_STORE_SPI_VERSION` 1.2.0 → **1.3.0** (one additive optional method).

## Context

The measured durable ceiling is ~5.7K exec/sec against a single Postgres primary, and the
**event log is the bottleneck, not the interpreter** — 1-step and 3-step flows differ 2.3×
in exec/sec but both land at ~20–23K events/sec. Worker scale-out cannot raise that: every
worker writes the same log.

The obvious response is to make `PostgresEventStore` faster. That fails a requirement we
hold explicitly: **an app that brings its own `EventStore` must get the scaling benefit
too.** `defineConfig` accepts `storage: { kind: "custom", eventStore, … }` precisely so
backends are symmetric (ADR 0043); scaling work that lands only in the first-party Postgres
plugin makes that symmetry a lie.

## Decision

**Capability in packages; optimization in plugins.**

A mechanism that composes over *any* `EventStore` is a decorator in
`packages/event-runtime`. A plugin's only job is implementing an optional SPI hook
efficiently for its backend. Optional hooks always ship with a working fallback, so a
backend that implements nothing still runs correctly — it simply does not get that hook's
win.

This is not a new pattern. `TenantScopedEventStore` (K12.5) is already exactly this: a
decorator in `packages/event-runtime` that works over any backend. So are `readRange`,
`copyPrefix`, `listExecutionsPage`, and `ContentStore.getMany` — every one optional, every
one with a fallback.

### D1 — `appendBatch?(envelopes[])` joins the SPI (additive, optional)

Equivalent to N sequential `append` calls; atomic (all-or-nothing); fencing honoured **per
envelope**, not per batch. Callers use `appendBatchOf(store, envelopes)`, which prefers the
hook and otherwise loops `append` — so absence is byte-identical to today.

Fencing per envelope is the load-bearing detail. A same-execution batch can share one fence
check; a **cross**-execution batch cannot, because rows belong to different executions. The
SPI is specified for the general case so a backend cannot implement the cheap version and
silently break fencing for the coalescer.

### D2 — `CoalescingEventStore` merges appends ACROSS executions

This **amends ADR 0065's frozen sketch**, which placed group commit inside
`ExecutionJournal`'s serial tail. That placement is now measured unworkable: the journal is
per-execution, a 1-step flow emits 4 envelopes, and with a realistic slow effect the tail
drains between `STEP_STARTED` and `STEP_COMPLETED` so a journal-side batch collects **one**
envelope. ADR 0065's own gate 2 names this case — "a 3-events-per-run workload cannot win".

A store decorator sees all executions at once and can fill a batch. Measured at 0.55–0.65×
of the same-execution batch shape, still ~4–8× over per-event append.

Two safety properties, by construction:

- **Ordering.** Each `ExecutionJournal` still serializes its own execution (D3 unchanged).
  The coalescer only ever groups envelopes from *independent* executions, and preserves
  per-execution arrival order within a batch.
- **Durability.** An `append` promise resolves only after its batch has committed — never
  early. Every `drain()` barrier keeps exactly the meaning it has today. A bounded linger
  window plus a flush-on-fill ensures a batch cannot wait indefinitely.

### D3 — `ShardedEventStore` routes by `hash(executionId)`

Zero backend cooperation required, so a BYO store gets the full horizontal-scale story
free, and shards may be heterogeneous. Consequences handled explicitly:

- `listExecutions` / `listExecutionsPage` become scatter-gather with a **k-way merge**; the
  SPI's lexicographic contract is preserved.
- Cross-shard `copyPrefix` has no server-side path and degrades to the documented per-event
  fallback; same-shard forks keep the fast path.
- Fencing is per-execution, so it shards with no coordination.
- `BranchRegistry` stays **unsharded** — refs are global by nature and small.
- Changing the shard count re-routes existing executions. Addressed as a follow-up in
  [ADR 0075](0075-shard-rebalancing.md) (virtual buckets + a `migrating` bucket state);
  without a `ShardPlan`, routing here is still fixed at construction.

### D4 — Interest-filtered delivery is a plugin concern, over a shared registry

The local-subscriber map, self-send dedupe, and local fan-out are backend-independent and
were triplicated across the in-memory, SQLite, and Postgres stores. They become
`SubscriberRegistry` in `packages/event-runtime`.

What remains genuinely backend-specific is which topics/channels to subscribe upstream. For
Postgres that is bucketed `LISTEN loom_events_<hash % N>` instead of one global channel,
which fixes an O(events × nodes) broadcast whose cost lands on the **writer**: 4 real
subscriber nodes cost 2.07–2.19× writer throughput, with delivery measured at exactly 1
notification per node per event. A backend on Redis/NATS/Kafka gets the same property
natively from topics; `SubscriberRegistry` is what makes it cheap for them to write.

### D5 — Conformance is how BYO parity stays honest

`runEventStoreConformance` gains `appendBatch` coverage — equivalence, atomicity, fencing,
empty input — skipped when the method is absent. A third-party author runs the same suite
the first-party stores run. Without this, "bring your own storage benefits too" is a claim;
with it, it is testable.

## Relationship to ADR 0065

ADR 0065 deferred **engine-side** group commit behind a three-part evidence gate and froze a
journal-side sketch. This ADR:

- **Amends its placement finding**: the journal-side sketch is measured unable to fill a
  batch. Anyone implementing group commit should build D2, not that sketch.
- **Does not claim to open its gate.** Gate 1 (a real workload measurably bottlenecked on
  event writes) and gate 3 (transient architecture insufficient) remain unmet; every number
  here comes from a no-op effect, which is precisely what gate 1 excludes.

D2 is nevertheless built rather than deferred, because it is a different object from what
was gated. ADR 0065 guarded against speculative machinery *inside the kernel* changing
durability semantics for everyone. `CoalescingEventStore` is opt-in composition: it is not
in the kernel, it is inert unless explicitly wired into `storage`, it changes no durability
semantics (D2), and it is one more decorator alongside `TenantScopedEventStore` and
`EncryptingEventStore`. The risk the gate exists to manage is not present.

What ADR 0065 rejected on **invariants** — durability classes, ephemeral runs,
flush-boundary semantics — stays rejected. No benchmark reopens those.

## Consequences

- `EVENT_STORE_SPI_VERSION` 1.2.0 → 1.3.0. Backends need do nothing; implementing
  `appendBatch` is how they opt into the batching win.
- Composition order matters and is documented: sharding outermost, then coalescing, then
  tenant scoping / encryption / content resolution, then the backend.
- Kernel untouched. `KERNEL_ABI` 1.1.0, `EVENT_SCHEMA_VERSION` 1.17.0, `ExecutionJournal`'s
  single-writer invariant unchanged.
- The honest limits are recorded in the requirements doc §5: no real-workload validation,
  single-host measurements, and R5's benefit unmeasured until it exists.

## Amendment (2026-09-27) — every decorator carries the whole optional SPI

The composition order above, sharding then coalescing then tenant scoping / encryption /
content resolution then the backend, did not deliver the batching it exists for. Four
decorators in that middle layer dropped `appendBatch`: `TenantScopedEventStore`,
`EncryptingEventStore`, `ContentResolvingEventStore` and `hashChainedEventStore`. The coalescer
calls `appendBatchOf`, which falls back to a sequential `append` loop when the method is
absent. Measured with 50 concurrent appends, `Coalescing(backend)` issued `appendBatch=4,
append=0`, while `Coalescing(TenantScoped(backend))` issued `appendBatch=0, append=50`. Every
multi-tenant, encrypted, content-externalized or audit-chained deployment that followed this
ADR got no batching and no warning. The same drift cost other capabilities. Encrypted logs
could be neither retained nor compacted. The audit chain lost enumeration. The DST fault store
and the crash harness hid `head`, `acquireFence` and retention from anything under test.

The fallback also broke D2's failure claim. That loop is not atomic, so when a batch holding a
stale-fence zombie failed, the healthy envelopes ahead of it were already durable while their
writers were told the batch had failed.

Decided:

- **Every decorator between the coalescer and the backend MUST implement `appendBatch`**, and
  every decorator MUST decide each optional method explicitly. It forwards the method,
  overrides it, or refuses it with a reason. `installOptional` (`@loom/event-runtime`) installs
  a `DecoratorPlan`, a mapped type over the whole `OptionalEventStoreMethod` union in which
  every key is required (`-?`; a mapped type over `EventStore` would otherwise inherit the
  methods' `?` and let a plan omit one). A plan that omits a method, including one added to
  the SPI later, fails to compile; `decoratorPlan.typecheck.ts` pins that under `pnpm
  typecheck`. The compiler cannot make a decorator USE a plan: that is what the conformance
  kit and the fitness test below enforce. A method is installed only when the inner store has
  it, so capability probes are unchanged.
- **`runEventStoreDecoratorConformance` / `runSnapshotStoreDecoratorConformance`
  (`@loom/conformance`)** wrap a full-capability store and assert that every optional method
  survives or is refused with a reason. They then run the whole SPI suite THROUGH the
  decorator, so the `appendBatch` atomicity cases actually execute. A 3P decorator proves
  itself the same way. A discovery-based fitness test (`packages/spec`) fails when a decorator
  in the repo is not registered with the kit.
- **Refusals are recorded.** `hashChainedEventStore` refuses `truncatePrefix`, because a
  compacted log fails `verifyChain` at the first surviving event. That was measured: it breaks
  with `prevHash mismatch` at sequence `through + 1`. The chain was forwarding the method
  before this amendment, so a routine compaction pass could break every later audit.
- **Blast radius of a coalesced zombie.** Even with a native `appendBatch`, one stale-fence
  envelope rejects its whole batch, so up to `maxBatch` healthy writers coalesced with it abort
  with a storage error. None of their events land, and recovery re-drives them from the log.
  Coalescing widens a fencing rejection from one execution to one batch. That trade is right
  while fencing is rare. A split-and-retry of the non-offending rows is deferred until fencing
  proves common in production.

`EVENT_STORE_SPI_VERSION` stays 1.4.0 because no method was added. The encryption half of this
change, which covers what may leave the erasure boundary once retention and compaction reach
an encrypted log, is ADR 0022's amendment of the same date.

## Amendment (2026-09-28) — bucketing fixes delivery, not the writer cost

D4 claimed bucketed `LISTEN loom_events_<hash % N>` "fixes an O(events × nodes) broadcast
whose cost lands on the **writer**." That claim is wrong. Bucketing fixes what a listener
*receives* (client-side filtering) and the per-notification `SELECT` volume that follows
from it. It does not fix what the writer pays to have listeners on the database at all,
which is the actual O(events × nodes) mechanism, and which bucketing cannot touch because it
does not change how many backends are LISTENing — only which channel each one is on.

**How this was caught.** `tools/bench-throughput` section C, the bench this ADR's own D4
numbers came from, still attached its fan-out listeners to the pre-bucketing global
channel (`NOTIFY_CHANNEL`) after the store had moved to bucketed channels
(`loom_events_<bucket>`). Every listener in that section therefore received nothing, and the
section printed "0 delivered … = 0 per event" next to a writer-throughput number that had, in
the same run, still dropped 2.28×. A self-contradicting measurement passed as a green bench
run for a release, because nothing checked that a listener expected to receive something
actually did (`docs/scaling.md` §3.1 also still read "**[open]** … nothing implements it
yet" under a heading of SHIPPED — the same drift, in prose). The bench now takes the real
channel list off the WRITER's own store instance (`PostgresEventStore#notifyChannels()`,
review round 1 — an earlier draft of this fix exported a free function taking
`notifyBuckets` by hand, which left the bench's own literal free to drift out of sync with
the store's configured default; an instance method cannot drift, because it answers for the
exact store the writer appends through) and fails outright (`VacuousDeliveryError`) if
delivery was expected and any expected channel came up empty — a listener set that receives
nothing, on any of the channels it should have heard from, is a broken measurement, not a
small number.

**What re-running the fixed bench found**, against a throwaway local PG 17 (8-core Apple M2,
a shared host, not a dedicated benchmark machine — ranges below are 3–4 repeat runs, not
single points; see `docs/scaling.md` §3.1 for the full tables):

| listener shape (c=128, 16 listeners) | events/sec vs. no-listener baseline (same run) |
|---|---:|
| 16 listeners on a channel **nobody publishes to** | **1.18× – 1.73×** slower |
| 16 listeners on the **real** bucket channels (full interest) | **1.22× – 1.90×** slower |

Listeners that receive **zero** notifications cost the writer almost as much as listeners
receiving every notification. The cost is per LISTENing backend on the connection, not per
channel and not per delivered event. Real subscriber processes (scenario H, shared
interest) confirm the same shape end to end: **1.68× – 2.63×** writer throughput lost to 4
nodes, matching the pre-bucketing 2.07–2.19× within run-to-run noise — bucketing changed
nothing here, because a fully-shared-interest deployment gives bucketing no filtering to do.
A disjoint-interest variant (`partitionDisjoint`) shows bucketing's real, narrower win —
delivered notifications per node per event drop to exactly `1/nodeCount` — without a clean
writer-throughput win alongside it (see `docs/scaling.md` §3.1's caveat on that variant
possibly being a single-host contention artifact rather than a fan-out result).

**Decided:**

- **D4's writer-cost claim is corrected**, not merely softened: bucketing is a client-side
  delivery fix. State the writer-side cost as unsolved by D4, open, and channel-independent.
- **Recommend `CoalescingEventStore` (D2) for multi-node deployments carrying live
  subscribers.** It already ships, needs no further work, and directly targets the
  mechanism: one notifying commit per BATCH instead of per event amortizes the per-commit
  signalling cost every per-event append pays regardless of channel. Measured recovery,
  coalesced writer vs. the uncoalesced 4-subscriber-node case: **1.21× – 1.54×** (3 valid
  runs).
- **A transport change for the writer-side cost is considered and rejected for now.**
  Options, cost order: (1) a separate batched notifier connection — the same amortization
  `CoalescingEventStore` already gives, for more moving parts; (2) watermark polling instead
  of LISTEN — trades a push model for a pull one, unevaluated latency/load trade; (3) a
  purpose-built bus (Redis, NATS) behind the existing `subscribe` seam, as a **3P plugin**
  via `SubscriberRegistry` — never kernel, never 1P, absent a second unrelated consumer
  (ADR 0083). `CoalescingEventStore`'s measured headroom is enough that none of these earn
  their complexity today. Revisit only if a real multi-node deployment is still writer-bound
  after coalescing is wired in.
- `tools/bench-throughput` section C now LISTENs on the store's real bucket channels and on
  an unrelated channel (pinning the channel-independent reading), and fails the run if
  expected delivery does not arrive. Scenario H gains a disjoint-interest variant and a
  `CoalescingEventStore` variant. `docs/scaling.md` §3.1 is rewritten to match this
  amendment, including the re-captured numbers and the same machine caveats.

No SPI change, no kernel change. `EVENT_STORE_SPI_VERSION` stays 1.4.0.
