# ADR 0030 — Decision materialization (`DecisionStore` / `DecisionGraph`)

- Status: Accepted (2026-07-10) — accepted item #3 in the [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md). Implemented: D1 richer `DECISION_RECORDED` payload (EVENT_SCHEMA_VERSION 1.9.0 → 1.10.0), D2 `decisionStore`, D3 `decisionGraph` in `@loom/analytics`. `getDecision` still returns only `choice` (P9 untouched).
- Date: 2026-07-10
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (M2 `ctx.decide` / `DECISION_RECORDED`), [ADR 0018](0018-learning-seam-outcome-recorded.md) (`OUTCOME_RECORDED`), `@loom/analytics`, `@loom/reasoning` (`rankedRouter`)

## Context

Loom already **records** decisions: `ctx.decide` emits `DECISION_RECORDED`, folded to `_decisions`;
outcomes emit `OUTCOME_RECORDED`; `@loom/analytics` mines both and feeds `rankedRouter`. The
requirements' "Decision Runtime" (P0) largely restates this. The genuine gaps are two:

1. **No materialized, queryable read-model.** Decisions live only as folded state + raw events;
   there is no cross-execution `DecisionStore` or `DecisionGraph` linking decision → outcome →
   downstream decisions for explainability.
2. **Thin payload.** `DECISION_RECORDED` carries `{ decisionId, choice, rationale?, source? }` — it
   omits the *alternatives considered*, *estimated cost/latency*, and *confidence* the requirements
   (rightly) want for explainability.

Everything here must stay **advisory** (P9/P10): the read-model is derived from the log and never
feeds the fold.

## Decision

- **D1 — richer payload (K5 extension).** Extend `DECISION_RECORDED` with optional
  `alternatives?`, `estimatedCostUsd?`, `estimatedLatencyMs?`, `confidence?`. Additive under K5
  event-schema governance — old logs (missing the fields) replay byte-identically; the fields are
  *descriptive*, never inputs to the choice on replay (the recorded `choice` still wins, P9).
- **D2 — `DecisionStore` read-model.** A read-only projection over `DECISION_RECORDED` +
  `OUTCOME_RECORDED` supporting query by `decisionId`, execution, source, and outcome. Built with
  the same lens pattern as `@loom/analytics`; pluggable backend (in-memory / Postgres) via the
  existing store SPI.
- **D3 — `DecisionGraph`.** Edges linking a decision to its recorded outcome and to decisions made
  later in the same (or forked) execution — the explainability spine ("why did it choose X, and how
  did that turn out").

`DecisionPolicy`/`DecisionEvaluator`/`DecisionOptimization` from the requirements are **already
covered** by `ctx.decide` deciders + `rankedRouter` + analytics; this ADR does not re-introduce
them, it materializes their *history*.

## Consequences

- Explainability becomes queryable without touching the durable path.
- Determinism untouched (G1): D1 fields are descriptive; D2/D3 are read-only projections.
- Zero-overhead when unwired (G2): no richer payload emitted and no store wired ⇒ byte-identical.

## Verification

- A decision emitted with the new fields folds identically to one without them for the `choice`;
  replay of a pre-extension log is byte-identical.
- `DecisionStore` query returns the expected decisions/outcomes for a fixture log; `DecisionGraph`
  reconstructs the decision→outcome→next-decision edges.

## Amendments (from the Execution-OS evaluation)

- Downgraded **P0 → P1**: recording/replay/optimization already shipped; only materialization +
  payload are new.
- `DecisionReplay` from the requirements is **not** built — decisions already replay via the log;
  a separate replay primitive would be a second source of truth.
