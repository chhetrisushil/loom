# ADR 0079 — `context` and `policy` on the decision seam (EVENT_SCHEMA 1.18.0)

- Status: **Accepted** (2026-08-12)
- Date: 2026-08-12
- Promotes: **T2** of the
  [continuous-learning placement evaluation](../requirements/2026-08-12-continuous-learning-rl-evaluation.md)
  — the single kernel touch that evaluation allowed.
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (the decision
  seam), [ADR 0030](0030-decision-materialization.md) (the D1 descriptive fields — this is the
  same contract, extended), [ADR 0018](0018-learning-seam-outcome-recorded.md) (the outcome half).
- Part of: the kernel/1P/3P triage discipline (P10). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA 1.17.0 → 1.18.0** — no new syscall, no new event kind, two optional payload
  fields on an existing one.

## Context

`DECISION_RECORDED` records *what was chosen*. `OUTCOME_RECORDED` (ADR 0018) records *how it
turned out*. Between them the log already holds `(action, reward)` — which is exactly enough
to learn a **global mean per arm**, and not one thing more.

It is not enough to learn a **policy**. A policy is a function of an observation, and the
observation was never written down. So the strongest thing anything downstream could say was
"opus averages 0.8" — never "opus averages 0.9 *on summarization under 4k tokens* and 0.3
elsewhere". Every contextual method, every off-policy estimate, every counterfactual is
foreclosed by one missing field.

Worse, one of the missing quantities is **unreconstructable after the fact**. The probability a
policy assigned to the action it took (`propensity`) exists only at decision time. No amount of
later analysis recovers it, and without it an off-policy estimate is biased by whatever the
logging policy happened to prefer. A team that discovers this a year in has a year of logs that
can be counted but not evaluated.

The evaluation that produced this ADR judged everything else in the learning stack to belong
outside the kernel. This field is the exception, and only because nothing outside the kernel can
write it: the event is emitted by `ctx.decide`, in the kernel, at the only moment the
information exists.

## Decision

Two optional fields on `DecideOptions`, carried verbatim into the `DECISION_RECORDED` payload
and folded into `variables._decisions`:

```ts
interface DecideOptions {
  // …existing D1 fields
  /** The observation the decider saw — the `s` in `(s, a, r)`. */
  context?: Record<string, unknown>;
  /** Which policy chose, and the probability it assigned to choosing that. */
  policy?: { id: string; version: string; propensity?: number };
}
```

**They are descriptive, exactly like the ADR 0030 fields.** Folded verbatim, never read back by
`getDecision`, so `choice` remains the sole replay input. That is the property that keeps this
additive in the strong sense: no amount of metadata attached here can change what replay does.

`EVENT_SCHEMA_VERSION` 1.17.0 → 1.18.0 — additive optional payload fields on an existing kind
are a MINOR under the K5 rule, the same call ADR 0030 made when it added `alternatives` and
friends to this very event.

## Consequences

- **A log becomes a dataset.** `(context, action, propensity)` from the decision plus `reward`
  from the linked outcome is the full tuple an offline learner or an off-policy estimator needs.
  [ADR 0080](0080-learning-substrate.md) is what reads it.
- **Nothing changes for anyone who ignores it.** The fields are opt-in by presence; a decision
  that passes neither produces a byte-identical event and a byte-identical fold. Tested
  explicitly, including that no `context: undefined` key appears.
- **Replay is untouched.** Proved by a test that replays a recorded execution while the
  surrounding policy has moved to a different context and version: the recorded choice is
  served and the decider is never re-consulted.
- **The propensity is a contract, not a hint.** A policy that reports it wrongly biases every
  later evaluation, and nothing downstream can detect that. The SPI in `@loom/learning`
  documents it as exact, and the reference 3P implementation tests its propensities sum to 1
  over the action set.
- **Cost is paid per decision, on the durable path.** `context` is written to the log every
  time. Keep it small; this is the reason it is a deliberate parameter rather than something
  the runtime infers and attaches for you.
- **Not a step toward a kernel learning subsystem.** The evaluation's other verdicts stand:
  trajectories, evaluation, promotion and every learning algorithm stay outside the kernel.
  This ADR spends the one kernel touch that was justified, and closes the question.
