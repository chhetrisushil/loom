# ADR 0005 — Distributed Execution Graph (fan-out / join)

- Status: Accepted (Step 5 of 5 — Cloud Run compute provider)
- Date: 2026-07-07
- Builds on: [ADR 0004](0004-failure-recovery.md)

## Context

An incident fans out into independent sub-analyses (metrics, logs, cost,
queries). The original plan (Epic 8) modeled these as one execution running on
four Cloud Run instances that "synchronize through the Event Store." That
violates the `ExecutionJournal` single-allocator invariant — four instances
allocating sequence numbers for one `executionId` corrupts the fold. There is no
distributed sequencer.

## Decision

New package `@loom/graph-executor` with `executeGraph(dispatcher, nodes, opts)`.
Each graph node becomes its **own execution** (distinct `executionId`) dispatched
concurrently through the `ExecutionDispatcher` (bounded by `limit` via
`parallelLimit`). Placement is free — in-process, or one Cloud Run instance per
node — because each execution has exactly **one writer**. The graph relationship
lives in the `BranchRegistry` as lineage edges (`recordLineage` parent→child),
not in a shared, concurrently-written log. The join is the barrier: results
return only once all branches settle, and `branchRegistry.children(parent)`
enumerates the branches.

This reuses the exact machinery the branching examples already rely on (per-
branch `executionId` + `BranchRegistry`), just fanned out instead of speculated.

## Consequences

- The single-allocator invariant holds unchanged — no distributed sequencer, no
  multi-writer.
- Fan-out is placement-agnostic: the same `executeGraph` runs on
  `LocalWorkerRuntime` or `CloudRunWorkerRuntime` with no code change.
- Lineage (not a merge) is the join model — consistent with Loom's branch-only,
  no-merge stance.
- Sub-executions here are independent flows; when branches are speculative
  *same-flow* variants, `WorkflowRuntime.fork()` (prefix copy) remains the right
  tool and composes with the same registry.

## Verification

- In-process: a 3-node incident graph (metrics/logs/queries) runs to completion,
  each node a distinct `executionId`, each effect once, and lineage `children`
  returns exactly the three branch ids.
- Cloud Run: the same graph dispatched via `CloudRunWorkerRuntime` over a
  platform that boots one fresh instance per branch — three concurrent instances,
  all branches complete, three distinct executions.
- Full repo: build + typecheck clean, 66/66 test tasks green, biome clean.
