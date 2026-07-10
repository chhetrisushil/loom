# ADR 0034 — Advisory Optimization Pipeline

- Status: Accepted (2026-07-10) — the one net-new item of the [forward-requirements evaluation](../requirements/2026-07-10-execution-kernel-forward-requirements-evaluation.md) (Requirement 8). Implemented: `advisoryPipeline` / `formatAdvisory` in `@loom/analytics` + `loom optimize` CLI.
- Date: 2026-07-10
- Builds on: `@loom/analytics` (`runtimeIntelligence`, `costAnalytics`, `latencyBreakdown`, `decisionRecords`, `outcomeRecords`), `@loom/reasoning` (`rankedRouter`), [ADR 0018](0018-learning-seam-outcome-recorded.md) (`OUTCOME_RECORDED`), [ADR 0030](0030-decision-materialization.md)

## Context

Loom's advisory-plane components already span the whole optimization loop — but as **independent
lenses** a caller wires by hand: `runtimeIntelligence(events)` (observe + analyze + recommend, one
shot), `rankModels`/`rankFromOutcomes` (rankings), `recordOutcome` → `OUTCOME_RECORDED` (evaluate),
`rankedRouter(rankings)` (the choice, logged via `ctx.decide`). What is missing — Requirement 8 — is
a single **composed lifecycle** (observe → analyze → recommend → evaluate → learn) and, per the
requirement, a way to *evaluate a recommendation against the outcome it later produced*.

## Decision

Add an optional pure read-model `advisoryPipeline(events, opts?)` in `@loom/analytics` that composes
the existing components into one lifecycle. Two non-negotiables carry over: **G1** (preserve
P2/P9 — never feed the fold) and **G2** (additive/opt-in — uncalled ⇒ byte-identical).

**Critical design choice — no new event type.** A recommendation is *derived*; outcomes are
*already* durable (`OUTCOME_RECORDED`). A `RECOMMENDATION_RECORDED` event was considered and
**rejected**: it would add K5 schema churn and raise a "does a stored recommendation feed the fold?"
hazard for zero benefit. The pipeline is a **pure projection** over the existing log, which
satisfies all three success criteria (reproducible, never influences replay, disable-able) more
cleanly. No schema change; `EVENT_SCHEMA_VERSION` unchanged.

**The lifecycle** (`advisoryPipeline(events, opts?): AdvisoryReport`):

- **observe** — telemetry summary from `costAnalytics` + `latencyBreakdown`.
- **analyze** — `runtimeIntelligence(events)` (analytics + model/outcome rankings + hot failures + budget).
- **recommend** — a structured `Recommendation[]`. Each carries a **deterministic content-derived
  `id`** (stable across runs for the same content), a `kind` (`model-ranking` | `budget` |
  `hot-failure`), a `subject` (the model / step / dimension it concerns), a rationale, and evidence.
- **evaluate** — for a recommendation whose `subject` appears in `DECISION_RECORDED` +
  `OUTCOME_RECORDED`, compute the realized outcome stats (was choosing the recommended model
  actually higher-success?) as a `RecommendationOutcome`. This closes "record recommendation
  outcomes" as a *correlation over durable facts*, not a new stored fact.
- **learn** — expose refreshed `rankFromOutcomes(events)` rankings for the next `rankedRouter`; the
  "loop" is simply the app re-calling the pipeline as new outcomes accrue.

**Adoption stays explicit.** The pipeline never mutates anything. An app that wants to act on a
recommendation does so through an ordinary `ctx.decide` (logged, replay-deterministic). There is no
code path by which the pipeline can influence an execution.

**DX.** `loom optimize --db <path> [<executionId>]` prints the report (read-only, mirrors
`loom profile`/`loom introspect`). `formatAdvisory(report)` renders it.

## Consequences

- The full observe→analyze→recommend→evaluate→learn loop is available as one call, while remaining
  strictly advisory.
- Determinism untouched (G1): no event type, nothing on the durable path; same events → same report.
- Zero-overhead when uncalled (G2): a pure lens; not invoked ⇒ byte-identical.
- Recommendations are **reproducible** (content-derived ids) and **disposable** (derived, not stored).

## Verification

- `advisoryPipeline` produces stable recommendations for a fixture log; the same events yield an
  identical report (determinism).
- A recommendation whose subject was chosen and later had outcomes gets a populated
  `RecommendationOutcome`; one without outcomes is left un-evaluated (not fabricated).
- `loom optimize` prints the report and is a no-op-safe read over the store.

## Amendments (from the forward-requirements evaluation)

- Requirement 8's "record recommendation outcomes" is realized as a **read-model correlation** over
  the already-durable `OUTCOME_RECORDED` facts — **no `RECOMMENDATION_RECORDED` event** (rejected to
  preserve minimal-kernel + avoid K5 churn).
- Pipeline is **advisory-only**; any auto-adoption variant is rejected (P10).
