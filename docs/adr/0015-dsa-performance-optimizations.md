# ADR 0015 — Data-structure & algorithm optimizations on the hot paths

- Status: Accepted (performance)
- Date: 2026-07-07
- Builds on: [ADR 0014](0014-deploy-check-and-inspector.md)

## Context

A three-front algorithmic audit of the framework (event fold, scheduler/stores,
projection/tooling) found the leverage concentrated in **event folding** — done on
every live commit, every resume, every projection update — plus a couple of
quadratic patterns in newer tooling. The SQLite stores were already correctly
indexed (`idx_events_exec`, `idx_snapshots_exec`, `idx_lineage_parent`), and
`parallelLimit`/dispatcher/eval/deploy-sim were already linear, so those were
explicitly left alone. Six changes were worth making.

## Decision

**A1 — copy-on-write fold (`@loom/replay-vm`).** The step handlers deep-cloned the
*entire* frames map (`cloneFrames`, S allocations) to update one frame, and
`foldEvents` spread the whole state again per event. Replaced with a single-frame
copy-on-write (`{ ...frames, [id]: frame }` — untouched frames shared by reference)
and an in-place `state.sequence` set (safe: `foldEvents` only ever mutates state it
just created, never the caller's `initial`). Per step-event drops from `S+1`
allocations to 2. Asymptotically still O(N) (S is bounded by the flow), but the
constant is the point — this is the most-executed operation in the framework.
_Measured: folding a 50-step / ~5000-event flow **33.7 ms → 4.4 ms (~7.7×)**._

**A2 — periodic snapshots (`@loom/workflow-runtime`).** Snapshots were written only
at suspend/fork, so a long non-suspending flow re-folded from sequence 0 on
recovery (unbounded tail, O(N·S)). Added `snapshotEvery?: N`: the journal fires a
post-commit hook and the runtime checkpoints every N events (at most one save in
flight; fire-and-forget — a failed checkpoint only means a longer replay). Bounds
recovery to O(N·S) tail. Default (unset) preserves the exact prior behavior.

**A3 — bulk `copyPrefix` for `fork()` (`@loom/event-runtime`).** Forking appended
the prefix event-by-event, re-`JSON.stringify`-ing each payload already stored as
JSON. Added an optional `EventStore.copyPrefix` — SQLite does it as one
`INSERT … SELECT` with `json_patch` for the metadata merge (zero JS round-trip);
in-memory slices + re-stamps. The per-event `append` loop remains as a fallback for
stores that don't implement it. Live projections still fire from the in-memory
prefix already in hand.

**B1 — `buildTrace` O(N²) → O(N) (`@loom/cli`).** The inspector render model folded
the whole prefix (`foldAt`) once per event. Replaced with a single incremental
`ReplayVM.applyEvent` pass capturing status per sequence.
_Measured: N=2000 **2.96 ms → 0.05 ms (~60×)**; the gap grows quadratically._

**B2 — VCR cassette `Map` (`@loom/testing`).** `entries.find` per call was O(n²)
while recording. Index by a `Map<key, response>` built once — O(1) lookups. The
entries array stays the serialized source of truth.

**B3 — A2UI batch-append structural sharing (`@loom/a2ui`).** `append` did
`[...existing, value]`, so a patch batch with k appends to one list was O(k²).
`applyA2UIPatches` now tracks arrays *created during the current batch* in a
`WeakSet` and pushes to those in place — O(k) per batch. Safe: the input state's
arrays are never in the set, so previous states are never mutated (cross-batch
immutability holds). (The cross-*event* growth of an unbounded streaming-history
surface is inherent to immutable folding and out of scope here.)

## Consequences

- The fold path allocates far less on every commit/resume; recovery of long runs is
  bounded by `snapshotEvery`; fork no longer re-serializes payloads; the inspector
  and VCR no longer degrade quadratically.
- `EventStore` gains an **optional** `copyPrefix` (non-breaking — stores that omit
  it fall back to `append`). `WorkflowRuntimeDeps` gains optional `snapshotEvery`.
  All other signatures unchanged; the public SDK is untouched.
- Rejected as non-issues (documented): SQLite store indexing (already optimal), the
  scheduler priority queue (Infinity-concurrency fast path covers the common case),
  in-memory store scans (dev/test only), and the linear tooling paths.

## Verification

- New tests: copy-on-write frame sharing + no prior-state mutation (replay-vm);
  snapshot cadence writes mid-run checkpoints on cadence and none by default
  (workflow-runtime); `copyPrefix` re-stamps + merges metadata and leaves the parent
  untouched (event-runtime); batch multi-append correctness + cross-batch
  immutability (a2ui). Existing `buildTrace` and VCR suites pin B1/B2 behavior.
- End-to-end: the `incident-war-room` fork/simulate/promote demo passes over the new
  SQLite `copyPrefix` path.
- Full repo: build + typecheck clean, 82/82 test tasks green, biome clean (560).
