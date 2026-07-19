# ADR 0065 — Engine-side group-commit batching: deferred behind an evidence gate

- Status: **Deferral recorded; nothing scheduled** (the ADR 0052 pattern)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (DE-2/DE-7 rejections), ADR 0052 (deferral-behind-evidence archetype).
- Part of: the GenUI/DE corrected series.

## Context — and the rejections this bounds

The DE-2/DE-7 proposal (run durability classes: buffer events in memory, flush
on suspension/failure/completion, forfeit happy-path crash recovery) is
**rejected**: it breaks crash recovery of running executions, K9.4 fencing, and
the snapshots-reference-only-durable-events invariant, and it institutes a
second semantic model. The GenUI hot path is answered architecturally instead —
P0 hydration is a transient service over the immutable manifest; only planning
and drift-repair are (durable) loom runs.

What survives of the cost concern is narrow and legitimate: per-event durable
appends have per-row overhead, and a future workload might measurably saturate
the write path with events that all sit in the SAME serial per-execution FIFO
awaiting persistence anyway.

## The deferred design (sketch, frozen)

Inside `ExecutionJournal`'s serial async tail: when N appends are enqueued and
the backend opts in (an optional `appendBatch(envelopes[])` committing one
transaction), drain the queue in batches instead of one-per-write.
**Semantics-free by construction**: every event is still durably persisted
before any `drain()` barrier resolves (completion, suspend, pre-snapshot,
failure); ordering is unchanged (single allocator, single tail); recovery,
fencing, and snapshots see exactly the log they see today. Batching only
shortens the async tail — it never widens the window the sync fold already
tolerates. No flow-visible surface: no durability classes, no contract field,
no new SPI obligation (backends without `appendBatch` are byte-identical).

## The evidence gate (all three, measured, not projected)

1. A real workload on a durable backend where event-write throughput — not
   effect latency, not fold cost — is the measured bottleneck (profile, not
   intuition; the ExecutionJournal already decouples the hot path from write
   latency).
2. The batching win demonstrated on that workload's actual event mix (many
   small events per execution; a 3-events-per-run workload cannot win).
3. The transient-service architecture confirmed insufficient for the workload —
   i.e. the events genuinely must be durable loom-run events.

## Do not reintroduce

Durability classes / ephemeral runs / flush-boundary semantics — rejected on
invariants, not on cost, so no benchmark reopens them. If a future proposal
wants "cheap runs", the answer remains: don't make it a run until something
durable happens.
