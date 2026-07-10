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
