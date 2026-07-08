# ADR 0018 — The learning seam: closing the decision loop

- Status: Accepted (implemented — `OUTCOME_RECORDED` + `recordOutcome`/`rankFromOutcomes`, event schema 1.2.0)
- Date: 2026-07-09

## Context

The decision seam (P9, [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md))
records **what was chosen** — every route, elevation, and optimizer choice is a durable
`DECISION_RECORDED` fact, so replay stays pure while "outcomes improve run-to-run." M10/M11
(`@loom/analytics`) already *mine* the log: `rankModels` derives a ranking from how often
each model was chosen, and `runtimeIntelligence` produces advisory recommendations.

But the loop was open. There was **no path from how a choice turned out back to the next
choice.** `rankModels` ranks by *frequency chosen*, not by *whether choosing it worked*; and
nothing recorded the outcome of a decision in the first place. `rankedRouter` accepts a
ranking, but the only ranking available was frequency-based and frozen at config time. A
kernel whose whole premise is "the log remembers" should be able to learn from what the log
remembers about *results* — not just *choices*.

## Decision

Add the symmetric half of the decision seam — an **outcome seam** — plus the feedback edge
that turns recorded outcomes into a ranking the existing router consumes.

- **`OUTCOME_RECORDED`** (`@loom/replay-vm`): a durable fact `{ key, success?, score?,
  decisionId? }` recording *how a prior choice turned out* (keyed by the thing scored — a
  model id, capability id, tool id). Governed under K5 with a pinned fold handler that
  appends to a reserved `variables._outcomes` audit list (mirroring `DECISION_RECORDED`).
  `EVENT_SCHEMA_VERSION` bumped `1.1.0 → 1.2.0` (additive = MINOR).
- **`recordOutcome(sink, outcome)`** (`@loom/analytics`): emits the fact through the caller's
  `emit` syscall (analytics still never mutates the fold — it only hands over a payload).
- **`rankFromOutcomes(events)`** (`@loom/analytics`): mines per-key mean success/score into a
  `Record<string, number>` — the outcome-driven counterpart to `rankModels`. Added to
  `runtimeIntelligence`'s recommendations as `outcomeRankings`.
- **Closing the loop**: feed it to the **existing** `rankedRouter(rankFromOutcomes(log))`
  (`@loom/reasoning`). Future work routes toward what actually worked; the route is still
  recorded via `ctx.decide` (P9), so the improved choice is auditable and deterministic on
  replay.

### Why an event, not a new syscall

The outcome is a governed *domain event* emitted via the existing `emit` syscall, not a new
K1 syscall — the eight-call ABI stays fixed (`abi.test.ts` unchanged). Promoting it to a
first-class `ctx.record` accessor is a future MINOR-ABI option if the ergonomics warrant it.

### Why composition, not a bundled router

`rankFromOutcomes` (a read lens, `@loom/analytics`) and `rankedRouter` (`@loom/reasoning`)
compose with a one-liner and stay in their own packages — no new cross-package runtime
dependency, keeping each small (P10).

## Consequences

- Loom now closes P9's promise operationally: recorded outcomes feed back into routing, so
  the system *learns from results* while every choice remains a logged, replay-deterministic
  decision. Non-determinism stays smuggled *only through the log* (P9).
- The same `{ key, success?, score? }` shape generalizes beyond model routing — capability
  selection, tool choice, and planner steps can all be scored and ranked by the same seam.
- Deliberately out of scope: automatic, unattended policy rewriting. Recommendations stay
  advisory (P10); an operator (or an explicit, logged adaptive router) applies them — the
  kernel never silently mutates its own routing behind the log.
- Memory/planner adaptation (feeding outcomes into `TieredMemory` / `PlannerRuntime`) reuses
  the same `OUTCOME_RECORDED` fact and is tracked as follow-on work.
