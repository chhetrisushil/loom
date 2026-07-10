# ADR 0029 — Runtime Observability / profiler

- Status: Proposed (2026-07-10) — accepted item #2 in the [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md)
- Date: 2026-07-10
- Builds on: `@loom/analytics` (M9 read-only lenses), `@loom/telemetry` (`TelemetryAdapter`), `@loom/cli` (`buildTrace`, `loom inspect`)

## Context

Loom already exposes an event timeline (`loom inspect`/`debug`, `buildTrace`) and OpenTelemetry-
style spans (`TelemetryAdapter`). What is missing is a **diagnostic** surface that answers *where
did the time go*: per-execution flame graph, suspend/resume/replay-cost breakdown, per-capability
and per-decision latency, and — once 0028/0032 land — cache-hit and prediction-accuracy ratios.
The requirements framed this as "Chrome DevTools for Loom." It is a genuine DX gap and, because it
is strictly read-only over the log + telemetry, it carries no determinism risk.

## Decision

Add profiler lenses in `@loom/analytics` (and a `loom profile <executionId>` CLI view) that fold
the existing event stream + telemetry spans into diagnostics. Read-only, off-log, opt-in (G1/G2).

- **P1 — flame graph** — fold `STEP_STARTED`/`STEP_COMPLETED` (+ nested `execute`/`parallel`) into
  a self-time/total-time tree per execution.
- **P2 — latency breakdown** — derive suspend, resume, and replay-fold cost from event timestamps
  and snapshot boundaries; surface per-capability and per-decision (`DECISION_RECORDED`) latency.
- **P3 — ratios** — cache-hit ratio (memoization middleware, if wired) and prediction accuracy
  (advisory warm/placement predictions vs. observed) — populated only when those seams exist.

Rendering reuses the dependency-free single-file `loom inspect` web view; no new runtime deps.

## Consequences

- Turns the log from an audit trail into a **profiler source** with no schema change.
- Determinism untouched (G1); zero-overhead when unused (G2) — lenses run on demand over stored
  events, never on the hot path.
- Some ratios (P3) are inert until 0028/0032 land; that is expected and documented, not a gap.

## Verification

- Flame-graph lens totals reconcile with raw event durations for a known fixture execution.
- Latency-breakdown numbers match hand-computed suspend/resume deltas on a suspend/resume fixture.
- `loom profile` renders offline from a stored DB with no network access.

## Amendments (from the Execution-OS evaluation)

- Absorbs the *advisory* slice of "Predictive Scheduler" (prediction-accuracy lens) and the
  observability half of "Runtime Cache Hierarchy" (hit-ratio lens) — the enforcement/caching parts
  of those items were rejected; only their *measurement* survives here.
