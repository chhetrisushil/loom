# ADR 0052 — Run chaining (`rotate$`) deferred behind an evidence gate; suspension transfer rejected

- Status: Accepted (2026-07-15) — **deferral recorded; nothing scheduled**
- Date: 2026-07-15
- Builds on: [ADR 0051 (perpetual-agents placement)](0051-perpetual-agents-placement-schedule-remodel.md),
  T1 timers/schedules (ADR 0025), K9 idempotency (ADR 0021), K11 code versioning (ADR 0023),
  `@loom/orchestration` child supervision (ADR 0040).
- Part of: keeping speculative kernel primitives out until a workload demonstrably needs them
  (P10). Companion to the T4 draft in
  [the requirements rewrite](../requirements/2026-07-15-perpetual-agents-sentinel-workloads.md) §5.

## Context

The strongest case for a kernel chaining primitive — argued in evaluation, worth recording so
it is not re-litigated from scratch: for a run that never terminates, K10.4 compaction and K11
hash pinning pull in opposite directions (the run pins to its original flow hash forever;
migrating it means `resumeAs` on a live execution, which replay-check may rightly refuse).
Rotation is "the drain exit made continuous" — every rotation is a clean re-versioning point.
This is the same reasoning that made Temporal's `continue-as-new` a primitive.

The counter, which carried: that case presumes perpetual runs are a given. Loom's blessed
model for the motivating workload (ADR 0051 D1) is schedules over bounded runs — every wake
already *is* a clean re-versioning point, and Temporal's premises (signals address a stable
workflow id; no idiomatic durable keyed state outside history) do not hold here. A primitive
justified only by a modeling choice the framework recommends against is speculative surface.

This project has killed speculative primitives before on exactly this test (`CHILD_COMPLETED`,
`ctx.compensate` — both proved expressible with existing machinery). Chaining gets the same
discipline, with the difference that the design work is genuinely good — so it is *recorded*,
not discarded.

## Decision

### D1 — Defer chaining (working name T4) behind two concrete walls

Promote T4 to a scheduled kernel requirement **only** when one of these is hit in operation,
with a written failure report as the promotion evidence:

1. **Stable signal-addressability.** External parties must address "the sentinel" as one
   logical endpoint whose conversation outlives any single run. Today A2A correlates by raw
   `executionId` (the task id *is* the execution id); there is no logical-name routing. Note:
   if this wall is hit, the requirement is really **routing** (logical name → current run) and
   should be specified as an A2A-layer requirement first — rotation would ride on it, not
   vice versa.
2. **A genuinely unrotatable long-lived run** that must hold live suspensions across months
   *and* cross deploys that `resumeAs` + K11.5 (ADR 0051 D6) cannot bridge. Long-lived human
   gates alone do not qualify: model the gate as a child execution
   (`@loom/orchestration` `awaitChild`) — the child survives its parent's completion.

Before promotion, the userland approximation must be attempted and its failure documented:
deterministic successor ids (`chainId@n+1`) + K9 idempotent starts + a supervisor projection
(the `superviseChildren` shape) + a durable inbox keyed by chain id, drained idempotently at
run start.

### D2 — The frozen draft (so promotion cannot dilute the hard parts)

If promoted, T4 is: `rotate$(carryForward)` with terminal-event + successor-start as one
journal transaction; deterministic successor identity; **exactly one live successor after a
crash at any point**; a chain-scoped inbox such that a wake/signal arriving between
terminal-commit and successor-start is delivered to exactly one run — never dropped, never
doubled; pending suspensions **re-established deterministically from carry-forward state** by
the successor; one additive event kind (`EXECUTION_ROTATED`: chainId, predecessor,
carry-forward hash); lineage queries as a projection, not SPI.

**Adversarial acceptance criterion, frozen now:** kill the worker between terminal-commit and
successor-start with a signal in flight; recover; assert exactly one live successor and
exactly one delivery.

### D3 — Identity-preserving suspension transfer is rejected permanently

The original draft's RC-4 option (a) — transferring live timer subscriptions / A2A waits / UI
waits between executions with identity preserved — is rejected regardless of whether T4 is
ever promoted. It breaks single-writer clarity (two executions with claims on one correlation
identity during the handoff window), its entire benefit is serving the perpetual-run model
this series retires, and deterministic re-establishment from carry-forward covers the need.
Do not reintroduce it as a T4 "optimization."

## Consequences

- No kernel work now; no reserved event kinds (schema additions happen only on promotion).
- The design cost already paid is preserved: a future promotion starts from D2's draft and
  must satisfy its frozen acceptance criterion, not a softened one.
- Anyone hitting wall 1 should open a **routing** requirement against the A2A layer, and only
  then revisit chaining.
