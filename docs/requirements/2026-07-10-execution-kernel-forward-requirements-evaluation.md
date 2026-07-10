# Execution-Kernel Forward Requirements — Critical Evaluation & Acceptance Record

> **Status:** Adopted — evaluates the [forward requirements](2026-07-10-execution-kernel-forward-requirements.md)
> as a **strict acceptance record** against shipped `main`, and drives [ADR 0034](../adr/0034-advisory-optimization-pipeline.md)
> for the one net-new item.
> **Date:** 2026-07-10
> **Relationship:** the affirmative counterpart to the
> [Execution-OS evaluation](2026-07-10-execution-operating-system-evaluation.md) (which was
> defensive). This confirms the shipped kernel *satisfies* the forward-looking requirements — with
> honest deltas — and isolates what remains.
> **Stance:** strict acceptance record — a "SHIPPED" verdict names every partial or deferred
> sub-check rather than declaring blanket completion.

## Rubric

The reviewer's four invariants (which match this repo's non-negotiables) and three acceptance
tests are adopted verbatim as the evaluation rubric:

- **Invariants:** minimal kernel · deterministic replay (P2/P9) · zero-cost-when-unused (G2) · mechanism ≠ policy (P10).
- **Tests:** *kernel ownership* (depends on execution semantics only Loom holds) · *determinism* (cannot change replay/fold) · *composability* (additive + optional).

## The finding that dominates everything

This affirmative list is a near-exact **re-derivation of the accepted scope from the defensive
evaluation — and 7 of the 8 requirements are already realized on `main`.** Requirements 1–5 and 7
were implemented, tested, and merged this cycle (ADRs 0028–0033, PRs #75–#79/#81); Requirement 6 is
the deliberately-parked demand-driven issue #72; only **Requirement 8 (Advisory Optimization
Pipeline) is genuinely net-new**, and even it is ~80% present as independent components lacking a
single composed lifecycle.

The framing itself is **correct and materially stronger** than the original: it argues *why* each
capability belongs in Loom from kernel responsibilities, not product ambition, and every one of the
eight passes all three tests. I concur with the rubric and the verdicts. The value of this record
is therefore (a) an **acceptance/conformance record** with honest deltas, and (b) isolating the one
remaining build plus minor delta follow-ups.

## Verdict summary (requirement → shipped reality)

| # | Requirement | Pri | Verdict | Evidence on `main` / delta |
|---|---|---|---|---|
| 1 | Runtime Verification Framework | P0 | **SHIPPED (with deltas)** | `@loom/verify` — `verify()` + `defineConfig({verify})` + `loom verify` ([ADR 0028](../adr/0028-runtime-verification.md), #73). Rules: determinism, replay-safety (folds in event-schema K5 + flowHash K11), suspension, capability, placement, resource. **Deltas:** (a) *ABI compatibility* is **not** a per-execution verify rule — the K1 syscall ABI is guarded by a build-time conformance test (`abi.test.ts`), not pre-dispatch; (b) shipped verify is **static / pre-flight only** — the requirement's *"runtime performs dynamic verification"* is covered today by the runtime enforcement rings (K2/K9/K11), not by the verify framework; (c) the *determinism* rule is **inert when fed from config** until the compiler emits non-determinism analysis (documented gap). → delta issue. |
| 2 | Runtime Observability Framework | P1 | **SHIPPED (with deltas)** | `flameGraph`/`latencyBreakdown`/`profile`/`formatProfile` + `loom profile` ([ADR 0029](../adr/0029-runtime-observability-profiler.md), #68). Read-only, zero-overhead-when-unused. **Deltas:** *replay cost* is derived from suspend/resume/step deltas (approximated, not a direct fold-cost meter); *scheduler metrics* are thin — the scheduler is ephemeral and no dedicated scheduler-metrics lens exists. → delta issue. |
| 3 | Decision Materialization | P1 | **SHIPPED** | D1 richer `DECISION_RECORDED` (alternatives/estimatedCostUsd/estimatedLatencyMs/confidence, schema 1.9→1.10) + `decisionStore` + `decisionGraph` (decision→outcome, decision→next) ([ADR 0030](../adr/0030-decision-materialization.md), #74). `DecisionStore`/`DecisionGraph`/`DecisionHistory` → `decisionStore`/`decisionGraph`/`decisionRecords`. Replayable, disposable, execution history canonical — as required. |
| 4 | Runtime Introspection API | P2 | **SHIPPED** | `introspect()` → execution/task/decision/resource/dependency graphs + `loom introspect` ([ADR 0031](../adr/0031-runtime-introspection-facade.md), #69). Read-only; every graph derives from runtime state; no mutation path. Placement/dependency graphs come from optional app projections (documented). |
| 5 | Resource Dimensions | P2 | **SHIPPED** | `memBytes`/`wallMs`/`netBytes` on `ResourceDelta`/`Budget`/`ResourceSnapshot` (schema 1.10→1.11, byte-identical when unused) + `ctx.negotiateBudget` ([ADR 0032](../adr/0032-resource-dimensions-bounded-negotiation.md), #70). Extensible, optional; existing apps unchanged (execution-time `ms` + `costUsd` predate this). |
| 6 | Placement Adapter Framework | P2 | **PARKED (correct)** | `WorkerRuntime`/`ExecutionDispatcher` SPI already exists (local/remote/CloudRun; WASM via T2). New backends (K8s/Lambda/GPU/Edge) = adapters against the SPI, **no kernel change** — exactly the success criterion. Tracked as **demand-driven #72**. Endorse as-is. |
| 7 | SPI Conformance Framework | P3 | **SHIPPED (with deltas)** | `runEventStoreConformance`/`runSnapshotStoreConformance`/`runBranchRegistryConformance` in `@loom/testing`, self-tested vs in-memory + SQLite; SPI map [12-extension-seams](../loom-2.0/12-extension-seams.md); new `InMemoryBranchRegistry` ([ADR 0033](../adr/0033-spi-conformance-contracts.md), #71). **Deltas:** *"every public SPI"* — dispatcher/worker conformance kits are noted follow-ups (need a mock `WorkerRuntime`); *"versioning policy per SPI"* — K1/K5 carry version constants, the storage SPIs don't yet expose explicit per-SPI version constants. → delta issue. |
| 8 | Advisory Optimization Pipeline | P3 | **NET-NEW → building (ADR 0034)** | Components all exist — `runtimeIntelligence` (one-shot observe+analyze+recommend report), `rankModels`/`rankFromOutcomes`, `recordOutcome`→`OUTCOME_RECORDED`, `rankedRouter` (choice logged via `ctx.decide`). **Missing:** a single *composed* observe→analyze→recommend→evaluate→learn lifecycle. Built as a pure read-model (see below). |

## Concurrence with the three tests

All eight pass the reviewer's three tests, verified against the codebase:

- **Kernel ownership** — each depends on execution semantics only Loom holds (replay/fold, event
  journal, ABI, suspension, resource fold, SPI boundary). None is application logic or policy.
  Correctly excluded from GenUI (experience) and AetherOS (autonomous-cloud policy).
- **Determinism** — every one is read-only over the log **or** additive-and-descriptive (Req 3/5
  schema fields fold conditionally and are never read by `getDecision`; Req 8 stays advisory and
  never feeds the fold). Confirmed against the two schema bumps (1.10, 1.11), which are
  byte-identical when the new fields are absent.
- **Composability** — all opt-in; unwired behaviour is byte-identical (G2), benchmark-proven for
  `@loom/verify` and structurally true for the read-only lenses.

**The one line to hold harder than the text:** Req 8 must remain **advisory-only and never
auto-adopt**. The implementation must make it *impossible* for the pipeline to mutate execution
semantics — it emits recommendations and reads outcomes; adoption is always an explicit `ctx.decide`
in application code.

## Requirement 8 — design (built here)

**Critical refinement:** do **not** add a durable `RECOMMENDATION_RECORDED` event. A recommendation
is *derived*, and outcomes are *already* durable (`OUTCOME_RECORDED`). A **pure read-model** over
the existing log satisfies all three success criteria more cleanly than a new event type — and
avoids K5 churn and the "does a stored recommendation feed the fold?" hazard. See
[ADR 0034](../adr/0034-advisory-optimization-pipeline.md).

`advisoryPipeline(events, opts?)` in `@loom/analytics` composes the existing components into one
lifecycle: **observe** (`costAnalytics`/`latencyBreakdown`) → **analyze** (`runtimeIntelligence`) →
**recommend** (a structured `Recommendation[]`, each with a deterministic content-derived `id`, a
`kind`, rationale, evidence) → **evaluate** (correlate a recommendation's subject to
`DECISION_RECORDED` + `OUTCOME_RECORDED` and compute realized outcome stats) → **learn** (expose
refreshed `rankFromOutcomes` rankings for the next `rankedRouter`). Pure, read-only, deterministic
(same events → same report), never feeds the fold, G2 zero-overhead when uncalled, disable = don't
call it. No schema change.

## Delta follow-ups (tracked, not blocking)

Filed as issues; build on demand:

- **Req 1** — a *dynamic* verification hook (or explicitly document that runtime enforcement rings
  K2/K9/K11 are the "dynamic" half); wire the compiler non-determinism analysis into the
  determinism rule.
- **Req 2** — a scheduler-metrics lens; a direct replay/fold-cost meter.
- **Req 7** — dispatcher/worker conformance kits; explicit per-SPI version constants.

## Bottom line

The forward requirements are **accepted**. Seven are satisfied on `main` (five shipped, one
shipped-with-noted-deltas ×3 counted per item, one correctly parked); the eighth is built here as a
pure advisory read-model. The kernel's four invariants are preserved throughout — nothing in this
roadmap adds a new execution abstraction, changes replay/fold, or moves policy into the kernel.
