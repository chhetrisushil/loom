# ADR 0078 — Exploration belongs in the routing seam: the learned router must not collapse

- Status: **Accepted** (2026-08-12)
- Date: 2026-08-12
- Amends: [ADR 0018](0018-learning-seam-outcome-recorded.md) (the learning seam —
  `OUTCOME_RECORDED` → `rankFromOutcomes` → `rankedRouter`). The loop it closed was
  real; the policy at the end of it was degenerate.
- Context: [Continuous learning / RL placement evaluation](../requirements/2026-08-12-continuous-learning-rl-evaluation.md)
  §3, which found this while scoping whether loom should ship RL.
- Part of: the kernel/1P/3P triage discipline (P10). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged (1.17.0)** — no new syscall, no new event type, no fold change.
  Two 1P packages, additive API only.

## Context

ADR 0018 closed the decision loop: record how a choice turned out, mine those outcomes
into a ranking, feed the ranking to `rankedRouter`, and future routes favour what
actually worked — with the route itself still a logged `DECISION_RECORDED`, so replay
stays deterministic (P9).

The feedback edge worked. The **policy consuming it did not**, in three compounding ways:

1. **Pure argmax with no exploration.** `rankedRouter` selected the max-ranked arm and
   nothing else. An arm absent from the rankings scored `-Infinity` and could never be
   selected while *any* other arm was ranked.
2. **No sample floor.** `rank = sum / count` (`outcomeAnalytics`) is a bare mean, and
   `rankFromOutcomes` then projects the counts away entirely. `1.0` from **one** sample
   outranks `0.99` from **ten thousand**, permanently.
3. **No recency weighting.** The flat lifetime mean lets a model's reputation from six
   months ago outvote its behaviour today — but rewards here are non-stationary by
   construction (providers ship new checkpoints, tools get fixed, prompts change).

Together these are a textbook bandit collapse, and the feedback edge makes it
self-sealing: the arms the router stops choosing stop producing outcomes, so the next
ranking mined from the log is *even more* confident about an arm that got lucky once.
A learning loop that destroys its own evidence is worse than no learning loop, because
it looks healthy the whole time.

This is a defect in the **policy**, not in the seam. The seam is right: the route is
resolved inside `ctx.decide`, so whatever policy runs, the choice is recorded and replay
serves the recording back.

## Decision

Fix the policy where the policy lives — in `@loom/reasoning` and `@loom/analytics`.
Nothing moves toward the kernel.

### `@loom/reasoning` — routers that can keep learning

- **`ArmStats { key, rank, count }`** — evidence carries its sample count. Structurally
  identical to what `outcomeAnalytics` returns, so it feeds in with no conversion.
  `rankedRouter` now accepts `ArmStats[]` **or** the legacy `Record<string, number>`.
- **`rankedRouter(rankings, { minSamples, fallback })`** — arms below `minSamples` are
  treated as *unranked* rather than as evidence, so thin evidence cannot outvote thick
  evidence. Setting `minSamples` with a count-free record **throws at construction**
  rather than silently no-opping the floor.
- **`ucb1(stats, { exploration, fallback })`** — the recommended default for a live
  loop. Scores `mean + c·sqrt(2·ln N / n)`: an unsampled arm scores `+Infinity` and is
  guaranteed a trial, and a lucky `n=1` arm cannot pin the router because its rivals
  keep their own large bonus until they too are tried. **Deterministic — no RNG.**
- **`epsilonGreedy(inner, { epsilon, rng })`** — the simple escape hatch for any
  exploit-only router. `rng` is injectable for tests and DST runs.

`rankedRouter` stays pure-exploit by default: adding implicit exploration would change
the behaviour of every existing deployment silently, which is the same class of mistake
as the one being fixed. Its docstring now states the collapse property outright and
points at `ucb1`.

### `@loom/analytics` — evidence that ages

- **`outcomeAnalytics(events, { halfLifeMs, now })`** — optional exponential recency
  decay. `now` defaults to the **newest `OUTCOME_RECORDED` timestamp in the log**, not
  the wall clock, so a ranking is a pure function of its input and identical on every
  replay. `count` stays the raw sample count that floors and UCB1 need. Omitting
  `halfLifeMs` preserves the existing flat mean exactly.
- **`rankFromOutcomes`** takes the same options, and now documents that its projection
  drops the counts — callers wanting a floor or UCB1 should pass `outcomeAnalytics`
  output directly.

## Consequences

- **No breaking change.** Every existing call site keeps its behaviour: `rankedRouter`
  with a plain record and no options is byte-identical to before, and
  `outcomeAnalytics(events)` without options is the same flat mean.
- **The default path is still exploit-only.** This ADR makes non-collapse *available and
  documented*, not automatic. Deployments that want a live loop must opt into `ucb1` or
  a wrapper. That is deliberate (see above), and it is the part most likely to be
  revisited once there is field evidence.
- **Thompson sampling was deliberately not shipped.** It needs Bernoulli or bounded
  rewards, and `score` is unbounded by contract; UCB1 covers the same need
  deterministically, which matters more in a replay-first runtime than the marginal
  empirical edge. Revisit if a normalized-reward contract lands.
- **Exploration randomness stays replay-safe** because `ReasoningRuntime` resolves the
  route inside `ctx.decide`: the sampled id is committed as `DECISION_RECORDED` and
  `select` is never called again on replay. Standalone callers (no `decide` sink) get no
  such guarantee and should inject `rng`.
- **Still not RL.** This is a bandit policy over an existing seam. The placement
  evaluation's larger verdicts — contextual features on `DECISION_RECORDED`, trajectory
  extraction, off-policy evaluation, `@loom/learning` — are untouched and remain
  unbuilt.
