# ADR 0040 — Live Query & Child-Workflow Orchestration (`@loom/live-query`, `@loom/orchestration`)

- Status: Accepted (2026-07-11)
- Date: 2026-07-11
- Builds on: `loadState` (folded reads), `EventStore.subscribe`, and the `execute`/`decide`/`suspend`/
  `resume` syscalls.
- Part of: the three-direction kernel arc, coordination primitives (Direction B), Phase 4.

## Context

Two Temporal-class coordination gaps remained: a **live query** of in-flight state (Loom's
`loadState`/`introspect` were on-demand/post-hoc, not a push subscription) and **cross-execution
await** (A2A / agent-swarm hand-rolled parent→child polling in application code). The strict-gatekeeper
ruling from the plan: neither needs a new syscall — both compose from existing primitives, so they
belong in userspace, not the kernel (P10).

## Decision

**`@loom/live-query`.** `liveQuery({ eventStore, reader })` → `snapshot(id)` (= `loadState`) and
`subscribe(id, onState)` which pushes the current state immediately and re-folds on every subsequent
event via `EventStore.subscribe`. Updates are **coalesced** (one re-fold in flight; a burst triggers
exactly one more, latest-wins) so a subscriber never sees stale-then-newer out of order. No syscall,
no event type — a read-model.

**`@loom/orchestration`.** `awaitChild(ctx, { key, flowId, input })` (parent-side) durably fixes the
child's id + spec with `ctx.decide` (replay-safe — a resume/recovery re-run never starts a second
child) and then `suspend({ on: CHILD_DONE, correlationKey: childId })`. A **supervisor**
(`superviseChildren({ runtime, flows })`, wired into `WorkflowRuntimeDeps.onEvent`) correlates purely
from the events it observes — no store read, so **no read-after-commit race**: it learns the spec from
the parent's `DECISION_RECORDED`, starts the child when it sees the parent's `EXECUTION_SUSPENDED`, and
on the child's `EXECUTION_COMPLETED` resumes the parent with the child's output. The child id embeds
the parent id (`<parentId>::<key>`), so correlation needs no extra state.

**No governed `CHILD_COMPLETED` event.** The plan proposed adding one; building it proved it
unnecessary — `CHILD_DONE` is a resume *signal name* (like `TIMER_FIRED` delivery), and the spec
rides in the `DECISION_RECORDED` the supervisor already sees. So Phase 4 ships with **no ABI and no
event-schema change** — the fullest P10 outcome.

## Consequences

- Push-based live reads and true parent→child await, both as opt-in libraries over the stable syscall
  surface. Nothing in the kernel changes; determinism/replay untouched (P2/G1/G2).
- Because `_resumePayload` is a single slot, orchestration builds on **one suspend/resume cycle per
  parent**: spawn a child, suspend once, resume once with its result. Single-child await is the
  shipped, tested primitive; fan-out over many children in one suspend is a documented follow-up.
- Honest scope: the supervisor correlates in-process (an in-memory spec map from `DECISION_RECORDED`).
  Across a restart it would rebuild that map by scanning suspended executions' logs — a follow-up;
  in-process it is complete. Child start is idempotent within the process (a `started` set) and fails
  safely on a duplicate (a second `EXECUTION_STARTED` at sequence 0 collides and is caught).

## Verification

- `@loom/live-query` (3): `snapshot` folds on demand (null for unknown); `subscribe` pushes the
  current state then again on resume→complete; delivery stops after unsubscribe.
- `@loom/orchestration` (3): parent⇄child id round-trip; end-to-end spawn→suspend→child-run→parent-
  resume yields the child's output on the parent (`{ fromChild: 10 }` from a child that doubled 5);
  replay-safety — a completed run started the child exactly once.
- `@loom/spec` registers `live-query` and `orchestration` at L2. No `abi.test`/`eventSchema.test`
  change (nothing was added to either contract).

## Amendment (2026-09-27) — incremental fold: O(N) rows over an execution's lifetime, not O(N²)

**Confirmed defect (2026-09-27 audit, backlog item 2).** `subscribe`'s re-fold called
`reader.loadState` — a full `loadState`/`foldState` — on **every** wake-up. `foldState`'s own
docstring names the cost: "liveQuery re-folds on every event, making a live subscriber O(N) rows
per event and O(N²) over an execution's lifetime." Measured (probe, one event per tick, no
snapshot): rows folded came out at exactly N²/2 — 500,500 at N=1,000, 8,002,000 at N=4,000
(10.6s on SQLite, on the same process and event loop as the writer). Loom has no production
caller today, but the docs *sold* live-query for exactly the quadratic case: `createLlmEffect`
and `chunkDeltas` named it a "natural"/"purely transient" sink for a streamed generation, where
`ctx.stream` appends one durable event per delta — both docstrings were wrong on a second count
too: **live-query has no delta-push API** (it is `snapshot` + `subscribe` over durable events,
not a channel to receive pushed deltas), so following that advice found nothing to call. Both
docstrings are corrected to name `progressHub` (or the app's own `onDelta` handler) as the
transient sink.

**Fix.** `subscribe` now folds incrementally: `reader.loadState` runs exactly ONCE per
subscription (establishing `state` and the last-folded sequence, `tip`), and every later
wake-up reads only `eventStore.readFrom(id, tip + 1)` — a bounded, indexed read — and folds
that delta onto the kept `state` with `@loom/replay-vm`'s `foldEvents`. This is **no new fold
and no new version**: `foldEvents`/`ReplayVM(tail, state)` is the same fold `foldState` already
uses for its snapshot-plus-tail path, and `fold(snapshot, suffix) === fold(events)` was already
load-bearing there and in `LogLifecycle.compact`. Total I/O drops from O(N²) to O(N).

The delta is read, not folded from the delivered envelope, for two reasons: delivery can be
gapped, duplicated or cross-node (`readFrom` absorbs all three for free), and
`ContentResolvingEventStore.subscribe` deliberately delivers the RAW ref-bearing event when
resolution fails, whereas its read path throws `ContentMissingError` loudly — folding the
delivered envelope would risk a silent `ContentRef` in state instead of a loud failure. An empty
delta emits nothing; a deleted execution (`readFrom` returns `[]` forever) stays silent, as
before. Burst coalescing (one refold in flight, one more if dirty) is unchanged — it now
coalesces a delta *read* rather than a full re-fold, so a burst is one indexed read of the whole
burst's tail, not one full-log read.

**Verification.** `packages/live-query/src/liveQuery.test.ts`: a counting store proves rows read
over N=500 sequential events stays ≤ N + a small constant (the old re-fold-per-wake-up fails
this — 125,250, i.e. N(N+1)/2); a bench line at N=4,000 asserts the same as a row count, not a
time; an equivalence property holds the incremental state to `toEqual` `loadState` after every
event across a `snapshotEvery: 7` boundary, under injected duplicate and deferred/out-of-order
subscribe deliveries; a `ContentResolvingEventStore` case with an unresolvable ref proves the
state never carries a `__loomContent` ref (the failure surfaces via `onError` from the read
path); the pre-existing terminal-state and `onError` tests stay green (the background-failure
ones now inject the failure into the store's `readFrom`, since the background fold no longer
calls the reader). Placement unchanged (1P, `@loom/live-query`, no kernel/syscall/ABI change);
one new dependency, `@loom/replay-vm` (already a transitive kernel package — no new 1P surface).
