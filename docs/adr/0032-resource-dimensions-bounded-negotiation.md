# ADR 0032 — Resource dimensions + bounded negotiation

- Status: Accepted (2026-07-10) — accepted item #5 in the [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md). Implemented: R1 memBytes/wallMs/netBytes on `ResourceDelta`/`Budget`/`ResourceSnapshot` + fold (EVENT_SCHEMA_VERSION 1.10.0 → 1.11.0, byte-identical when unused) + `nestedBudget`; R2 `ctx.negotiateBudget(dimension, request, opts?)` via the decision seam. "Energy budget" dropped.
- Date: 2026-07-10
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (K3 metering), `@loom/middleware` (`meteringMiddleware`, `nestedBudget`), M2 decision seam

## Context

K3 already meters **tokens / cost / ms** (`RESOURCE_METERED` → `EffectContext.resources`,
per-execution and nested budgets, `QUOTA_EXCEEDED`). The requirements' "Runtime Resource Manager"
(P1) asks for more dimensions and *dynamic negotiation*. Two caveats from the evaluation:

- Extra dimensions are only worth metering **where they can be measured/enforced** — memory (peak
  RSS of an isolated K7 child), wall time, and network bytes are feasible; **"energy budget" is
  not** and is dropped.
- Unbounded "negotiation" invites non-determinism. Negotiation must be **bounded and logged**: a
  request for more budget resolves against a fixed ceiling via `ctx.decide`, so the grant is a
  durable decision, replay-safe (P9).

## Decision

- **R1 — dimensions.** Extend the metering `ResourceDelta`/`ResourceSnapshot` with optional
  `memBytes?`, `wallMs?`, `netBytes?`. Additive under K5; unset dimensions behave exactly as today.
  Memory/network are metered only for effects that can report them (e.g. the K7 isolated executor);
  others leave them undefined (no false zeros).
- **R2 — bounded negotiation.** `ctx.negotiateBudget(dimension, request)` resolves via `ctx.decide`
  against a policy-supplied **ceiling**: grant = `min(request, ceiling - spent)`, recorded as a
  `DECISION_RECORDED`. On replay the recorded grant is served — no live renegotiation. Exceeding a
  granted budget still raises `QUOTA_EXCEEDED` (K3 enforcement unchanged).

## Consequences

- Budgets can reflect memory/wall/network where they matter, without touching flows that don't
  declare them.
- Determinism preserved (G1): negotiation is a logged decision, not a hidden input; enforcement
  stays in metering middleware.
- Zero-overhead when unwired (G2): no new dimensions declared and no negotiation call ⇒ identical.

## Verification

- Metering a K7 child records `memBytes`; a token-only effect leaves it undefined (not `0`).
- `negotiateBudget` grants `min(request, remaining ceiling)`, records a decision, and replays the
  same grant; over-spend past the grant raises `QUOTA_EXCEEDED`.

## Amendments (from the Execution-OS evaluation)

- **"Energy budget" dropped** — unmeasurable in-kernel.
- "Dynamic negotiation" constrained to **bounded + logged** — an unbounded/mutating negotiator was
  rejected as a determinism hazard.
