# ADR 0075 — Shard rebalancing: virtual buckets, lazy drain, no coordinator

- Status: **Accepted** (2026-08-09)
- Date: 2026-08-09
- Builds on: [ADR 0074](0074-storage-scale-out-decorators.md) (`ShardedEventStore`, and the
  capability-in-packages placement rule), [ADR 0033](0033-spi-conformance-contracts.md) (the
  `EventStore` SPI and its optional-with-fallback discipline).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged
  (1.1.0); EVENT_SCHEMA unchanged (1.17.0); EVENT_STORE_SPI unchanged (1.3.0)** — no new
  syscall, event type, or SPI method. Entirely inside one package-level decorator.

## Context

ADR 0074 shipped `ShardedEventStore`, routing by `hash(executionId) % shardCount`, and said
plainly that changing the shard count "re-routes existing executions and is a migration, not
a config change". That is the honest description of a store you cannot grow: adding a shard
silently sends reads to a shard that has never seen the data.

A sharded log you cannot resize is barely a sharded log. Splitting the log is the only thing
that lifts the single-primary ceiling (the log is the measured bottleneck, and worker
scale-out cannot raise it), so the ability to add capacity is the point.

## Decision

### D1 — Routing moves from a formula to an explicit, persistable plan

`ShardPlan` maps a virtual bucket (default 4096) to a shard. Executions hash to a bucket;
buckets are assigned to shards by a table that is data, not arithmetic. The plan is
immutable, serializable, and comparable — it is a value multiple nodes must agree on, so it
must be shippable and diffable rather than derived independently on each node.

Supplying a plan is **opt-in**. Without one, routing is byte-identical to ADR 0074, so no
existing deployment changes behaviour — but nor can it rebalance. Start with a plan if you
expect to grow.

### D2 — Reassignment moves the theoretical minimum

The obvious bucket→shard rule, `bucket % shardCount`, is worthless: measured, growing 4→5
shards moves **80%** of buckets and 8→9 moves **89%** — no better than the `hash %
shardCount` routing virtual buckets exist to escape. Virtual buckets only help if the
*reassignment* preserves existing placements.

`rebalanced(n)` therefore keeps every bucket where it is and moves only the **excess** from
over-target shards onto under-target ones. Measured after the fix: 4→5 moves 20.0%, 8→9
moves 11.1%, 2→3 moves 33.3% — each the theoretical minimum `total × (1 − N/M)`. The
resulting load is within one bucket of fair, and the assignment is deterministic so two
nodes computing the same rebalance agree.

### D3 — A migrating bucket names both sides; nothing is copied

`rebalanced` marks each moved bucket `migrating(from → to)`. That is a **routing change
only**. For such a bucket the store resolves, per execution, which side actually holds it —
one indexed point-read against sequence 0 (the bootstrap anchor, which exists for exactly as
long as the execution does), then cached in a bounded LRU.

So during a migration:

- executions already on the source keep being read and written **there** — nothing breaks,
  nothing is blocked;
- executions that do not exist yet start on the **destination**.

A bucket therefore **drains by itself** as executions complete and retention reclaims them.
No copying, no downtime, no coordinator, no distributed transaction. This is the design's
core bet: loom executions are finite, so the source side empties on its own.

`migrateExecution()` exists for when you want convergence sooner or must decommission a
shard, and `isBucketDrained()` tells you when `plan.settled(bucket)` is safe.

### D4 — Two limits, stated rather than papered over

- **`migrateExecution` does not move a live execution safely.** It copies then deletes; an
  append arriving mid-move lands on the source and is dropped. Move terminal or undispatched
  executions. Copy-before-delete is deliberate: a crash between the two leaves the execution
  on both sides, which resolution handles (the destination is checked first) and a re-run
  cleans up. The reverse order would lose the log.
- **Fence state does not travel.** The SPI exposes `acquireFence` but no way to read or
  write a fence, so a migrated execution arrives unfenced and a zombie writer holding an old
  token could write to the destination. Adding fence transfer to the SPI would be a real
  change with real cost; it is not justified by the lazy-drain path, which never moves a
  live execution at all.

Enumeration deduplicates for the same reason: mid-migration an execution can briefly exist
on two shards.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Consistent hashing / rendezvous hashing | Solves minimal movement, but not the transition — you still cannot serve an execution whose data is on the old node. The hard part is the *migrating* state, which an explicit table expresses directly and auditably. |
| Stop-the-world migration | Requires quiescing arbitrary executions. Loom has no such control, and downtime is the thing to avoid. |
| Eager copy of everything on rebalance | Turns adding capacity into a bulk data movement proportional to the whole log. Lazy drain reaches the same end state for free. |
| Fence transfer in the SPI | Real cost, and unnecessary for the path that matters (lazy drain never moves a live execution). Revisit if eager migration of live executions is ever needed. |
| Rebalance while a migration is outstanding | Would leave a bucket's executions spread over three shards, which the two-sided resolution cannot express. `rebalanced` refuses; settle first. |

## Consequences

- Growing a sharded deployment is now a plan swap plus patience, rather than a migration.
- Every node must converge on the same plan; different plans on different nodes split the
  log. The plan is serializable precisely so it can be distributed as configuration.
- Shrinking requires an explicit `{ allowShrink: true }`, since it removes capacity and
  every bucket on a removed shard must move.
- Cost while a bucket migrates: one extra point-read per execution on first touch, then
  cached. Settled buckets pay nothing.
- `ShardedEventStore` continues to pass the full `EventStore` conformance suite, with and
  without a plan.
