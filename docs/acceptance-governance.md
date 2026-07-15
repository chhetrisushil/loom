# Acceptance-governed proactivity — the self-quieting loop

*DX-3 of the db-copilot infrastructure series (issue #189). Assembles shipped parts —
`OUTCOME_RECORDED` (P9), `@loom/analytics`, `@loom/reasoning` — into the pattern an ambient
assistant needs: **suggestion categories that users ignore demote themselves**, trained by
usage rather than configuration. No new seams; every step below is a logged fact.*

## The loop in one picture

```
suggest (ctx.decide picks a category/channel)
   → user acts or ignores (recordOutcome → OUTCOME_RECORDED, durable)
      → rankFromOutcomes(events) mines acceptance per category
         → rankedRouter(rankings) prefers what users accept
            → the next suggestion's routing is a logged DECISION_RECORDED
```

Acceptance rate is not a dashboard metric bolted on afterwards — it is folded from the same
log the agent runs on, and it *drives* the next decision.

## 1. Record the outcome as exhaust

When the user accepts, dismisses, or ignores a suggestion, log it — one call, one durable
fact (`variables._outcomes` in the fold):

```ts
import { recordOutcome } from "@loom/analytics";

// In the flow (or any effect) handling the user's response:
recordOutcome(ctx, {
  key: "index-suggestion",        // the CATEGORY being scored
  success: response === "accepted", // or a graded score: 0..1
  decisionId,                       // ties back to the routing decision (optional)
});
```

`key` is whatever you want governed: a suggestion category (`"index-suggestion"`,
`"vacuum-tuning"`), a delivery channel (`"interrupt"`, `"digest"`), or a model route.

## 2. Mine acceptance from the log

```ts
import { rankFromOutcomes } from "@loom/analytics";

const events = await eventStore.read(executionId); // or aggregate across runs (below)
const rankings = rankFromOutcomes(events);
// → { "index-suggestion": 0.85, "vacuum-tuning": 0.15, ... }  (mean of score ?? success)
```

For the cross-run, months-of-history version, index `OUTCOME_RECORDED` with
`@loom/plugin-read-model` (ADR 0058) and rank over the queried rows — the same
`rankFromOutcomes` shape, fed from the durable index instead of one log.

## 3. Route the next suggestion through the ranking

```ts
import { rankedRouter } from "@loom/reasoning";

const router = rankedRouter(rankings);
// A "route" here is a suggestion channel; rank decides interrupt vs digest vs silence.
const channel = await ctx.decide(`notify:${findingId}:channel`, () =>
  router.select(
    { messages: [], strategy: "notify" },
    [
      { id: "interrupt", tags: ["urgent"] },
      { id: "digest", tags: ["ambient"] },
      { id: "silent", tags: ["log-only"] },
    ] as never
  ).id
);
```

Two properties make this safe for an always-on agent:

- **The choice is durable** — `ctx.decide` records `DECISION_RECORDED`; replay serves the
  recorded choice and never re-consults the router (P2/P9). The governor can evolve without
  historical runs changing meaning.
- **The floor is policy, not learning** — a genuinely interruptive alert (the proposal's
  high-confidence/high-cost/time-sensitive tier) should bypass the learned router entirely:
  encode the floor as an explicit branch before routing. Learning governs *volume*, never
  *safety*.

## 4. The interruption budget

Combine with `meteringMiddleware`-style admission if you want a hard cap: count interrupts
per window in carry state (`@loom/plugin-durable-state`) and demote to `digest` when the
budget is spent — a recorded, replayable outcome like everything else.

## Where to see it run

`packages/analytics/src/outcomes.test.ts` (rank-from-binary-outcomes),
`packages/reasoning/src/ReasoningRuntime.test.ts` (route + elevation choices through the
`decide` sink), and `examples/db-sentinel` for the finding-emission half the loop scores.
