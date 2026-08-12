# Companion Platform — Placement Evaluation

- Status: **Verdicts recorded. Both proposed kernel promotions rejected; net kernel change
  is zero.** ADRs [0081](../adr/0081-long-lived-suspensions-no-promotion.md),
  [0082](../adr/0082-substitutive-replay-deferred.md).
- Evaluates: [the platform requirements as submitted](2026-08-12-companion-ambient-execution-platform.md).
- Method: the ADR 0051 discipline — a placement verdict per series, judged against the best
  userland alternative, bias outward (P10). Every claim in the submission was verified against
  the repo record before judgment; corrections are listed first because several verdicts turn
  on them.

---

## 0. Factual corrections to the submission

| # | Submitted claim | Repo record |
|---|---|---|
| C1 | §0.4 reuses "the TS series (telemetry substrate split, result-by-reference logging, content-addressed evidence)" | **No TS series exists.** [ADR 0071](../adr/0071-read-only-replay-inspector.md) Q4 recorded this verbatim: *"The draft specified IX-7 against a 'TS-series telemetry substrate' that does not exist."* The [DE-series evaluation](2026-07-19-dynamic-execution-de-series-evaluation.md) flagged the same citation as its C2. This is the **third** document to cite it. The capabilities are real under other names: [ADR 0046](../adr/0046-content-store-seam-thin-authoritative-log.md) `ContentStore`, [ADR 0054](../adr/0054-claim-check-middleware.md) claim-check, [ADR 0062](../adr/0062-content-get-many-batched-resolution.md) `getMany`, `@loom/plugin-content`. EL-8 and PJ-5 should cite those. |
| C2 | §11.2 "Checkpoint replay barriers … Keep deferred" | **Ruled "not needed"**, not deferred. [ADR 0051](../adr/0051-perpetual-agents-placement-schedule-remodel.md): *"`checkpoint$` — not needed; snapshots (`snapshotEvery`, `loadLatestBefore`) + K10.4 compaction already bound replay depth."* Identical to correction C1 in the DE-series evaluation (2026-07-19). |
| C3 | §11.3 "External-wait transfer — *revisit, favourable*" | **Rejected permanently.** ADR 0051: *"Identity-preserving transfer of live suspensions across executions — rejected permanently; recorded with rationale in ADR 0052."* Identical to correction C4 in the DE-series evaluation. Two of that evaluation's corrections have now been re-submitted unchanged. |
| C4 | §11.1 "Declarative rotation policies — previously deferred" | Not a deferred item. The deferred item is **`rotate$` run chaining** ([ADR 0052](../adr/0052-run-chaining-deferred-evidence-gate.md), *"deferral recorded; nothing scheduled"*). Declarative **retention** already ships: `applyRetention({ terminalTtlMs })`, `loom retention run --ttl`, [ADR 0022](../adr/0022-k10-log-lifecycle-retention-redaction-encryption.md). |
| C5 | SU-5 and LQ-6 specify interaction with `rotate$` | `rotate$` **does not exist**. These are notes about a hypothetical, not requirements, and cannot be accepted or rejected as written. |
| C6 | PO-1 "expressed as a `guard$`" | **No `guard$` in the codebase.** `policy$` (`@loom/core`) exists but is a `PolicyDefinition` of named rules — a different construct. |
| C7 | §0.3 layer ladder includes `stdlib` | **No stdlib tier exists.** Loom's tiers are kernel packages / advisory packages / 1P plugins (`plugins/`) / 3P plugins (sibling repo) / tools. See §4 — the omission causes six misclassifications. |

---

## 1. Verdicts

### SU — Very-long-lived suspensions → **REJECT Promotion 1. Layer `none`.**

Every clause of the promotion argument is already true today:

| Claim | Repo record |
|---|---|
| SU-1 "without the run being reaped by any lifetime policy" | Retention reclaims **terminal executions only** — `tools/cli/src/retention.ts:80`: `if (!TERMINAL.has(state.status)) return "not-terminal"`. A suspended run is never eligible, at any age. |
| SU-2 "zero ongoing compute; polling prohibited" | There is no polling. Suspension is fold state; resume is event-driven; scheduled wakes go through the durable `TimerStore` SPI ([ADR 0025](../adr/0025-t1-durable-timers-and-scheduled-executions.md)), not a scheduler loop. |
| SU-3 "pending vs abandoned; abandonment never a timeout side-effect" | `cancel(id, reason)` → `EXECUTION_CANCELLED` is already an explicit, non-timeout transition. "Abandoned" is a reason string, or an app-level status projection over it. |
| SU-4 "re-validate against current policy on resume" | K11 `flowHash` → `FlowCodeMismatchError`; K11.5 `resumeAs` migration ([ADR 0056](../adr/0056-k11-5-state-migration-on-resume.md)); K12 `ResumeAuthenticator`; typed resume gates ([ADR 0077](../adr/0077-typed-resume-payloads.md)). Layer `app`. |

The promotion argument says the change is "to lifetime bounding and reaping policy, not to the
suspension primitive itself." There is no lifetime bounding on suspended runs to change. **The
submission's only unconditional kernel promotion has nothing to promote.**

What SU actually needs is the submission's own **LQ-2** — a cost measurement at 10⁴–10⁵
suspended runs — which is a benchmark, not a primitive. Recorded as
[ADR 0081](../adr/0081-long-lived-suspensions-no-promotion.md) with an evidence gate. Relevant
prior data: the throughput work measured ~5.7K durable executions/sec with **the log as the
bottleneck**, not the interpreter; suspended runs are storage, not compute, so the number to
establish is bytes-per-suspended-run and snapshot behaviour on Postgres.

### PO — Policy state and off-policy evaluation → **layer `app`. PO-1…PO-4 shipped 2026-08-12.**

The series was written against a platform that changed under it on the same day:

| Requirement | Now satisfied by |
|---|---|
| PO-2 posteriors as projections | `trajectories()` — `@loom/learning`, [ADR 0080](../adr/0080-learning-substrate.md) |
| PO-3 record the decision through the determinism boundary | `context` + `policy` on `DECISION_RECORDED` — [ADR 0079](../adr/0079-decision-context-and-policy.md), EVENT_SCHEMA 1.18.0 |
| PO-4 importance-weighted off-policy scoring | `evaluatePolicy()` — SNIPS with weight clipping and effective sample size; `loom learn eval --db … --policy …` |

PO-4's Accept line ("scored against ≥ 8 weeks of recorded history with nothing deployed") is
satisfiable on the CLI today. **PO's layer is `app` plus one already-shipped kernel field, not
"kernel (conditional)".**

**Defect in PO-3.** It records *"(context vector, randomisation draw, action taken, channel)"*.
Importance weighting requires **`P(action | context)`** — the propensity — which is *not* the
randomisation draw and **cannot be reconstructed afterwards**. As written, PO-3 produces logs
on which PO-4 is not computable. Fix: record the propensity explicitly (`policy.propensity`,
ADR 0079). This is the single most consequential correction in this evaluation, because the
data loss is silent and permanent.

**Where the bandit lives is unanswered.** LP-3 specifies Thompson sampling; the submission never
says at which layer it is implemented. Per ADR 0080 the answer is **3P, behind the one-method
`Policy` SPI** — now a registered plugin seam (`loom plugin new policy <name>`), with
`loom-plugin-linucb` as the reference. Note that `@loom/reasoning` deliberately dropped Thompson
([ADR 0078](../adr/0078-exploration-in-the-routing-seam.md)) because `Outcome.score` is
unbounded; a bounded-reward Thompson implementation is legitimate but belongs 3P.

### PO-5 substitutive replay → **defer, but eliminate the userspace answer first.**

The deferral is correct and the reasoning is sound. One alternative is missing from §9 and
§11.2 entirely: loom already has **branch-from-prefix** (fork / simulate / promote — the
`incident-war-room` and `schema-migration-planner` pattern) plus `@loom/dst`. Forking an
execution at a decision point and re-running with a different recorded choice *is* substitutive
replay, in userspace, on shipped primitives. Recorded as
[ADR 0082](../adr/0082-substitutive-replay-deferred.md): the evidence gate is now "demonstrate
that branch-from-prefix cannot answer the question", not merely "importance weights degenerate."

### EL — Event log and entry kinds → **layer `none` / `app`. Accepted with two refinements.**

EL-6's observation/conclusion rule is the strongest idea in the submission and maps exactly onto
the fold discipline. Two corrections:

- **The boundary case is missing from EL-6's table.** `OUTCOME_RECORDED` is a recorded
  *judgment* of how a choice turned out, and it is correctly logged — because it is a
  **measurement of something that happened**, not a conclusion a projection would recompute. It
  is the sharpest illustration of the rule and belongs in the table.
- **EL-2 is stricter than loom requires, and EL-5 is simpler.** The fold treats unknown event
  types as **inert**: `ctx.emit(type, payload)` writes an arbitrary type that `foldEvents` skips
  while still advancing `sequence`. Domain events are therefore already open at L2 with no
  discriminator-inside-a-kind indirection, and EL-5's "index over the domain `type` field" is
  just the existing `eventType` column — already indexable by a store plugin. EL-1 is already
  enforced and tested: `knownEventTypes()` + the pinned list in `eventSchema.test.ts` +
  `EVENT_SCHEMA_VERSION` (K5).

### EF — Effect classes → **layer `compiler` + runtime. Accepted with a required reconciliation.**

Compiler rather than kernel is the right call, and EF-5's prohibition on learned adjustment
matches ADR 0080's posture exactly.

**K2 is never mentioned, and must be.** Loom already has a runtime authority ring —
`GrantTable`, `CapabilityAuthorizer`, `EFFECT_DENIED` (K2). EF-5 asserts effect class as a
compile-time constant, but at runtime the grant table can deny an effect that a compiled flow
declares. The two must be reconciled explicitly: **static class = declared upper bound; grant
table = runtime floor.** Without this, EF-2 passes statically while K2 denies in production, and
Companion EX-6's "fail closed" fires at a different layer than the submission expects.

**Enforcement hazard, from experience.** `@loom/verify` rules read `FlowSpec` fields that no
producer populates, so a rule can silently never fire — this is live today for the `suspends`
rule. EF-1's declaration needs a **producer in the compiler manifest**, and EF-2's acceptance
must be the negative case (a `read-only` flow that transitively reaches an external write
actually fails the build). The submission's Accept line is right; the plumbing is where this
dies. Existing machinery to build on: the `determinism` and `classification-reachability` rules
(`packages/verify/src/rules.ts`), `tools/compiler/src/nondeterminism.ts`.

EF-6's "DE-9 clearance machinery" is not a real identifier; the mechanism is
[ADR 0076](../adr/0076-wildcard-classification-paths.md) + `@loom/classify` +
`classification-reachability`.

### PJ — Projections → **layer `app`. Accepted; PJ-7 relocated.**

PJ-1…PJ-6 are correct as written. PJ-7's "harness in stdlib" has no tier to land in (C7) and
substantially exists: `@loom/projection-runtime`, `@loom/plugin-read-model`
([ADR 0058](../adr/0058-read-model-plugin.md)) and the `@loom/analytics` read lenses.
The genuinely new part is **descriptor pinning + determinism trapping**, which is small and
belongs in a 1P package. PJ-4's trap should reuse the `determinism` verify rule and the
compiler's non-determinism pass rather than rebuild them.

### RP — Replay as a product surface → **layer `app`. Accepted, with one escalation.**

RP-1…RP-5 hold. One thing the submission understates: ADR 0071 scoped the inspector read-only
**and internal**. User-facing, RP-2's masking stops being a convenience and becomes a **security
boundary** — the inspector reads the raw log, so redaction must happen in its read path and
deserves its own adversarial test, at the standard of Companion KC-2.3.

### BP — Blueprint synthesis → **layer `app`. Accepted in full.**

BP-2's refusal to open the component vocabulary for machine-generated blueprints is exactly
right, and for the stated reason.

### IN / HO — Ingest and host topology → **not `spi`. See §4.**

---

## 2. The structural finding: a missing rung

The submission's ladder is `none → app → stdlib → compiler → spi → kernel`. Loom's placement
taxonomy ([ADR 0043](../adr/0043-plugin-packaging-and-1p-3p-separation.md)) is **kernel /
advisory package / 1P plugin / 3P plugin**. In loom, "SPI" is the *interface*; the thing an
author writes is a **plugin implementing it**. With no plugin rung, "write a plugin against an
existing seam" is recorded as "change the SPI" — which inflates the cost of the entire ingest
and topology story:

| Req | Submitted | Corrected | Existing machinery |
|---|---|---|---|
| IN-1 second write path | spi | **app + existing plugin** | A second `EventStore` instance with its own retention |
| IN-3 retention per tier | spi | **config** | `applyRetention`, ADR 0022 — already declarative |
| IN-6 batched async writes | spi | **exists** | `CoalescingEventStore` ([ADR 0074](../adr/0074-storage-scale-out-decorators.md)); `appendMany` measured at 8.2× |
| EL-5 discriminator index | spi | **store plugin** | The `eventType` column |
| HO-1/HO-2 satellite | spi | **existing plugin** | `@loom/dispatcher` + `@loom/plugin-worker-remote` / `worker-server` |
| HO-5 ordered idempotent transport | spi | **exists** | K9 idempotency + K9.4 fencing ([ADR 0021](../adr/0021-k9-effect-delivery-contract-idempotency-fencing.md)) |

Two consequences follow.

**§11.3 rests on a misdiagnosis.** HO-3's real need — dispatch a local effect to a satellite that
may be offline for hours — is served by the existing dispatcher/worker seam plus
`EFFECT_INDOUBT` and durable timers. It does not require suspension transfer, so the case for
reopening a permanently-rejected promotion (C3) does not arise.

**IN-1 should feed an existing evidence gate, not open a new path.**
[ADR 0065](../adr/0065-group-commit-deferred-evidence-gate.md) already deferred engine-side
group commit behind the gate *"if write volume is measured to be the blocker."* IN-1 is that
evidence — once quantified.

---

## 3. What the submission does not address

1. **Ingest volume is never quantified.** "Orders of magnitude higher than run events" is the
   load-bearing claim for the whole IN series, against a measured ceiling of ~5.7K durable
   appends/sec where the log is the bottleneck. No requirement states a target write rate. This
   is the real scaling risk and it carries no number; LQ-1 asks the wrong question until it does.
2. **Multi-tenancy is absent**, yet Companion PV-6 asks that a future B2B path stay reachable.
   `TenantScopedEventStore` and execution-lifecycle authz
   ([ADR 0039](../adr/0039-execution-lifecycle-authz.md)) are where that lives.
3. **EL-1 has no acceptance test** despite being the load-bearing invariant of the whole
   document. It has one already — `eventSchema.test.ts` — and should cite it.

---

## 4. Revised disposition

| Series | Submitted layer | Verdict | Note |
|---|---|---|---|
| EL | app | **none / app** | Already enforced by K5; EL-2/EL-5 simpler than stated; add `OUTCOME_RECORDED` to the table |
| IN | spi | **app + existing plugin** | Quantify the write rate; feed ADR 0065's gate |
| PJ | app | **app** | PJ-7 → 1P package; reuse the determinism rule |
| RP | app + IX | **app** | Masking becomes a security boundary |
| SU | **kernel** | **none** | Promotion 1 rejected — ADR 0081 |
| EF | compiler | **compiler + runtime** | Must reconcile with the K2 grant table |
| BP | app + stdlib | **app + 1P** | Accepted in full |
| PO | **kernel (conditional)** | **app** | PO-1…PO-4 shipped; PO-3 defect must be fixed |
| PO-5 | kernel (conditional) | **deferred** | Eliminate branch-from-prefix first — ADR 0082 |
| HO | spi | **existing plugin** | Satellite = dispatcher + worker-remote |

**Net kernel change required by this workload: zero.** `KERNEL_ABI` stays 1.1.0 and
`EVENT_SCHEMA` stays 1.18.0. The submission's own governing question — *"at which layer does
this belong, and what is the smallest change?"* — answers itself more favourably than it
concluded.

---

## 5. Recommended actions

1. **Fix PO-3 in the PRD** (Companion LP-4): log the propensity, not just the randomisation
   draw. Everything in LP-6 depends on it and the loss is irreversible.
2. **Quantify IN-1** before designing it — a target observation write rate, compared against the
   measured append ceiling.
3. **Run LQ-2 as a benchmark** (ADR 0081's gate) rather than scoping a promotion.
4. **Re-cite C1's TS-series references** to ADR 0046 / 0054 / 0062 so the fourth document does
   not repeat them.
5. **Add K2 reconciliation to EF** — static class as upper bound, grant table as runtime floor.
