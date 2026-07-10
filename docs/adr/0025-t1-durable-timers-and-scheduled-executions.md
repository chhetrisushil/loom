# ADR 0025 — T1: durable timers & scheduled executions (kernel service)

- Status: Accepted (implemented 2026-07-10 — T1.1 `ctx.sleep`/`ctx.sleepUntil` syscalls
  (kernel ABI 1.0.0 → 1.1.0), `wakeAt` recorded once in the `EXECUTION_SUSPENDED` condition
  (A1), governed `TIMER_FIRED` fact (event schema 1.6.0, folds to `variables._timers`),
  `TimerStore` (in-memory + SQLite + **Postgres**, all beside the event store) +
  `TimerService` poller with at-least-once, idempotent, exactly-once-effective wakes,
  `suspend({ timeout })` unification gated on wiring (A3); T1.2 `schedule$` cron registry
  (minimal dependency-free UTC cron matcher) firing occurrences with **deterministic
  `scheduleId@occurrenceMs` executionIds** (A2 — durable-state dedup + store uniqueness
  backstop; no catch-up of pre-service occurrences, documented), `fenced` mode acquiring
  K9.4 tokens per fire/start for multi-node deployments,
  `defineConfig({ timers: { store, schedules, fenced } })`. Amendments below applied.)
- Date: 2026-07-10
- Requirements: [T1 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#t1--durable-timers--scheduled-executions-kernel-service) — priority **P1**

## Context

`ctx.suspend` supports a timeout, but there is no durable "wake me at T" / cron-style
service. Autonomous operations are substantially timer-driven (retries after cool-downs,
nightly audits, SLA follow-ups); today this is an external bolt-on that owns state the
kernel cannot back up or replay. Unlike K7–K12 this is not an enforcement *ring* but a
kernel *service* — hence the T-series numbering. Small surface, disproportionate value for
ops workloads.

## Decision

Make time a durable, replay-safe kernel service:

- `ctx.sleepUntil(ts)` / `ctx.sleep(ms)` are durable suspensions: the wake is a logged fact
  (**`TIMER_FIRED`**), survives restarts, and replays deterministically — the *scheduled*
  time is in the log, so wall-clock drift never enters the fold (G1) (T1.1).
- A durable schedule registry — `schedule$({ cron, flow, input })`, statically wired per
  P5 — with at-least-once firing and idempotent start semantics: a fired occurrence that
  already started is not double-started, via a **deterministic executionId derived from
  `scheduleId + occurrenceTime`** with the store's uniqueness backstop (T1.2 as amended —
  the requirement's "reuses K9 keys" is the concept, not the machinery: a cron occurrence
  has no `executionId` yet; see [ADR 0021](0021-k9-effect-delivery-contract-idempotency-fencing.md)).
- Timer storage lives in the same store family as events (SQLite/Postgres) so a single
  backup captures the full kernel state; firing across nodes tolerates node loss via lease +
  fencing, per K9.4 (T1.3).

## Acceptance criteria

A flow sleeping 48 h survives process kill and store failover, waking exactly once; a cron
schedule fires across a node crash without duplicate starts; replay of a timer-bearing
execution is bit-identical regardless of when it is replayed.

## Consequences

- Timer-driven autonomy needs no external scheduler; kernel state (events + timers) is one
  backup, one restore.
- New durable fact `TIMER_FIRED` enters the K5-governed schema (additive → MINOR); the fold
  reference must be updated. `ctx.sleep`/`ctx.sleepUntil` are new syscalls → K1 MINOR ABI
  bump with the conformance test extended.
- Depends on K9's keys and fencing for exactly-once *starts* across node loss — sequence T1
  after K9.
- Unwired (no sleeps, no schedules), behavior is byte-identical (G2).

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [T1 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#t1--durable-timers--scheduled-executions--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — `wakeAt` determinism**: the absolute wake time is computed **once** and recorded in
  the `EXECUTION_SUSPENDED` payload — wall clock enters the log exactly once (P9); resume
  replay serves it via the existing suspend-passthrough; it is never recomputed on re-fold
  (recomputation = replay divergence).
- **A2 — cron dedupe mechanism corrected** (applied inline above): deterministic executionId
  from `scheduleId + occurrenceTime` + store uniqueness backstop.
- **A3 — suspend-timeout unification**: today `suspend({ timeout })` records a timeout that
  **never fires** across a restart (dead metadata — a latent gap). T1 makes it fire durably
  through the same timer service, **gated on the service being wired**: unwired = today's
  no-fire behavior, byte-identical (G2).
- **A4 — sequencing**: T1 lands after K9 (deterministic occurrence ids + lease/fencing for
  multi-node firing).
