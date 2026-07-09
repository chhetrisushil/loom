# ADR 0023 — K11: flow-code versioning for in-flight executions

- Status: Proposed (amended 2026-07-10 — see [Amendments](#amendments-code-grounded-evaluation-2026-07-10))
- Date: 2026-07-10
- Requirements: [K11 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#k11--flow-code-versioning-for-in-flight-executions) — priority **P1**

## Context

K5 pins the event schema and `@loom/deploy-sim` ([ADR 0008](0008-evals-and-deploy-simulation.md))
*detects* divergence, but nothing *remediates* it: an execution suspended for three days is
stranded when new flow code deploys — resuming it against changed code silently folds a log
the new code never wrote. Long-lived executions are Loom's raison d'être, so this is a
kernel obligation, not an application concern. Long-lived executions plus continuous deploy
collide immediately in production.

## Decision

Make version skew between a suspended execution and deployed flow code detectable, pinnable,
and — where compatible — migratable, never silent:

- `EXECUTION_STARTED` (the requirement's "`RUN_STARTED`" does not exist) records the flow's
  content hash — which must be *built*: the compiler manifest has only `version` + per-step
  chunk hashes today. Resume **and crash recovery** compare recorded vs. registered hash and
  never silently proceed across a mismatch (K11.1 as amended).
- **Pinned resumption**: the registry may hold multiple versions of a flow
  (`flow$({ id, version })` already exists); an in-flight execution resumes on the version
  it started with (K11.2).
- Where pinning is impossible, an explicit migration verdict API:
  `resumeAs(executionId, newFlowId, { strategy: "replay-check" | "operator-ack" })`, where
  `replay-check` proves the new code folds the existing log identically (reusing the
  `deploy-sim` engine) before resuming; any migration is a durable **`EXECUTION_MIGRATED`**
  fact (K11.3).
- `loom deploy check` ([ADR 0014](0014-deploy-check-and-inspector.md)) enumerates live
  suspended executions whose flow hash would change, making "drain or pin before deploy" a
  CI-enforceable gate (K11.4).

## Acceptance criteria

Deploying changed flow code with a suspended execution in flight: (a) resume without pinning
fails loudly; (b) pinned resume completes on old code; (c) `replay-check` migration succeeds
when the change is fold-compatible and refuses when not.

## Consequences

- The kernel's core promise — executions that outlive processes — extends to outliving
  *deploys*, the case production hits first.
- New durable fact `EXECUTION_MIGRATED` enters the K5-governed schema (additive → MINOR);
  the fold reference must be updated.
- The flow registry becomes version-aware; deploy tooling gains a live-execution census.
  Unwired (no version pinning, no migration API use), resume behavior is byte-identical for
  matching hashes (G2) — the only new behavior is *refusing* a mismatch that today proceeds
  silently, which is the point.

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [K11 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#k11--flow-code-versioning-for-in-flight-executions--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — event + hash corrected** (applied inline above): target is `EXECUTION_STARTED`
  (payload extension under the K5 payload-extension rule; folds treat absence as legacy —
  logs without a hash resume exactly as today, G2). The hash is computed over
  **compiler-normalized manifest content** (step graph + step chunk hashes), never raw
  bundler output — non-reproducible builds would flap the hash every rebuild, refuse every
  resume, teach operators to override, and reduce the check to theater. The mismatch error
  presents the three exits (pin / `resumeAs` / drain).
- **A2 — recovery path, pulled forward**: the check also guards **crash-recovery /
  rehydration**, not just operator `resume()` — today a restart-after-deploy folds an old
  log with new code *silently, with no operator action*. This slice (record hash at start;
  compare on recovery + resume) is the first K11 work and P0-adjacent in risk.
- **A3 — registry semantics**: the registry is today a `Map<flowId, …>` that **silently
  overwrites** on re-registration. It becomes version-aware (`flowId → version → flow`);
  re-registering the *same* id+version+hash stays silent (idempotent — dev watch-mode must
  not spam); same id+version with a *different* hash is an error.
