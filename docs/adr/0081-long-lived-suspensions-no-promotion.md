# ADR 0081 — Long-lived suspensions need a benchmark, not a promotion

- Status: **Accepted** (2026-08-12) — promotion rejected; evidence gate recorded, nothing scheduled.
- Date: 2026-08-12
- Rejects: the SU series' "Promotion 1" in the
  [Companion platform requirements](../requirements/2026-08-12-companion-ambient-execution-platform.md) §6,
  evaluated in [the placement evaluation](../requirements/2026-08-12-companion-platform-evaluation.md) §1.
- Archetype: the deferral-behind-evidence discipline of [ADR 0052](0052-run-chaining-deferred-evidence-gate.md)
  and [ADR 0065](0065-group-commit-deferred-evidence-gate.md).
- Part of: P10 minimal kernel. **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).**
  No code changes at all.

## Context

The Companion workload needs runs that stay suspended for weeks to months — an automation
waiting on a human decision — at a count proportional to *active automations* rather than
active sessions. Its platform requirements classified this as a kernel promotion: SU-1 (not
reaped by any lifetime policy) and SU-3 (pending vs abandoned as first-class states), with the
argument that the change is "to lifetime bounding and reaping policy, not to the suspension
primitive itself."

The argument is well-formed. It is also unnecessary, because there is no lifetime bounding on
suspended runs to change.

## Decision

**No promotion.** Every clause of the requirement is satisfied today:

| Requirement | Why it already holds |
|---|---|
| SU-1 — never reaped by a lifetime policy | Retention reclaims **terminal executions only**. `applyRetention` is gated on `TERMINAL.has(state.status)`; a suspended execution is ineligible at any age ([ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md), `tools/cli/src/retention.ts`). |
| SU-2 — zero ongoing compute; no polling | Nothing polls a suspended run. Suspension is fold state; resume is event-driven; scheduled wakes go through the durable `TimerStore` SPI ([ADR 0025](0025-t1-durable-timers-and-scheduled-executions.md)), not a scheduler loop. |
| SU-3 — pending vs abandoned, never a timeout | `cancel(id, reason)` → `EXECUTION_CANCELLED` is already explicit and never fires on a timeout. "Abandoned" is a reason string, or an app-level projection over status — not a kernel state. |
| SU-4 — re-validate policy on resume | K11 `flowHash` → `FlowCodeMismatchError`; K11.5 `resumeAs` ([ADR 0056](0056-k11-5-state-migration-on-resume.md)); K12 `ResumeAuthenticator`; typed resume gates ([ADR 0077](0077-typed-resume-payloads.md)). Userspace composition of shipped machinery. |

SU-5 is not dispositioned because it cannot be: it specifies interaction with `rotate$`, which
does not exist ([ADR 0052](0052-run-chaining-deferred-evidence-gate.md) recorded the deferral;
nothing is scheduled). If `rotate$` is ever promoted, suspension-crossing semantics belong in
*that* ADR.

## The evidence gate

What the workload actually surfaces is a **measurement question**, which the submission itself
raises as LQ-2 and then does not use to decide the promotion:

> What is the concrete storage and compute cost at 10⁴–10⁵ suspended runs per instance, on the
> Postgres reference implementation?

**Gate:** this ADR is reopened only if a benchmark shows that suspended runs impose a cost that
scales with *pending duration* or *run count* in a way the storage layer cannot absorb.
Specifically, one of:

1. steady-state CPU measurably above zero with N runs suspended and no events arriving; or
2. per-run storage that grows after suspension (it should be flat — the log stops); or
3. resume latency at 10⁵ suspended runs materially worse than at 10³.

Any of those is a real finding and would justify reopening. None of them is a suspension
*primitive* problem; (1) would be a scheduler bug, (2) a snapshot/compaction issue, (3) an index
question in the store plugin.

Prior data that shapes the expectation: the throughput work measured ~5.7K durable
executions/sec with **the log as the bottleneck**, not the interpreter. Suspended runs consume
storage, not compute, so the number to establish is bytes-per-suspended-run and snapshot
behaviour under `snapshotEvery`.

## Consequences

- **Nothing is built.** The Companion workload's long-suspension requirement ships on today's
  kernel, unchanged.
- **A benchmark is owed**, not a design. It belongs in `tools/bench-throughput` alongside the
  existing append/QPS work, and it answers LQ-2 directly.
- **SU-2's Accept line becomes a test to write, not a change to make** — "10,000 runs suspended
  for 30 simulated days consume no measurable CPU" is a `@loom/dst` scenario, and asserting it
  guards against a future regression that would otherwise be invisible.
- **The pending/abandoned distinction stays in userspace.** Two applications may reasonably
  disagree about what supersession means; encoding one opinion as a kernel state would make the
  kernel arbitrate a domain question (P10).

## Amendment (2026-09-28) — emits in a long-lived session

A long-lived session re-runs from the top on every resume, and flow-level emits are served from
the log only when the log proves them ([ADR 0102](0102-flow-emits-append-once.md) D2). A session
that catches an untyped failure early re-appends every later emit on every resume. Declare the
failure channel ([ADR 0060](0060-typed-failure-channels.md)) so the failure is served and the
emits after it converge.
