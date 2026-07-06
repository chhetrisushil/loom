# ADR 0013 — Composable orchestrator primitives (prototype-and-check)

- Status: Accepted (DX tooling — Phase 5)
- Date: 2026-07-07
- Builds on: [ADR 0012](0012-flow-graph-validation.md)

## Context

~310/448 lines of each example orchestrator are a shared route→plan→dispatch loop
with a byte-identical approval gate. The evaluation flagged this as *feasible but
leaky-risk* and prescribed **prototype-and-check**: extract only what composes
cleanly, as functions apps call (not a base class), and reject anything that
forces a shape.

## Decision

New `@loom/orchestrator` (dependency-free), with the **policy** extracted and the
app-specific side effects left as callbacks:

- **`decideApproval` / `autoApprovalAllowed`** — the human-in-the-loop *policy*:
  auto-approve a low-risk action when the goal permits it (`/low risk|auto…/`),
  else defer to a human. The regex + risk check are byte-identical across all five
  examples; the surface effects (log, render pending, wire the resolver) are passed
  as handlers.
- **`dispatchPlan`** — the route→plan→dispatch control-flow skeleton with hooks
  (`onRouted`/`onPlanned`/`onResult`/`isTerminal`), for *new* orchestrators.

## Prototype-and-check outcome (the honest part)

- **`decideApproval` — KEEP, proven in-example.** db-command-center's `gate()` was
  migrated to it; the policy regex now lives in one tested place, and all four
  suites (incl. the end-to-end approval-gate UI test) pass unchanged. Clean fit,
  clear value.
- **`dispatchPlan` — KEEP as optional, NOT forced into existing examples.** When
  applied to db-command-center's `run()`, it does **not** fit cleanly: the loop
  threads app state through `model.plan[i]` (a `PlanEntry`, not the raw planner
  step) and a cross-step `assessment`, which the generic skeleton would constrain
  awkwardly. Per the discipline, it is offered (tested) as a starting scaffold for
  new orchestrators, but the examples' bespoke loops are left alone — forcing it
  there would add friction for little gain.

## Consequences

- The high-value, identical piece (approval policy) is de-duplicated and tested
  once; a real example uses it.
- `dispatchPlan` is available but explicitly not mandatory — the app keeps its
  conductor logic. No base class, no inheritance, nothing forced.

## Verification

- `@loom/orchestrator` (6): `autoApprovalAllowed` phrasing; `decideApproval`
  auto-approves low-risk-permitted / defers medium / defers when goal forbids;
  `dispatchPlan` ordered route→plan→dispatch→absorb + early terminate.
- db-command-center migrated `gate()` → `decideApproval`; 4 suites pass unchanged.
- Full repo: build + typecheck clean, 81/81 test tasks green, biome clean (556).
