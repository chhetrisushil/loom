# ADR 0080 — `@loom/learning`: the substrate, not the learner

- Status: **Accepted** (2026-08-12)
- Date: 2026-08-12
- Promotes: **T3/T4** of the
  [continuous-learning placement evaluation](../requirements/2026-08-12-continuous-learning-rl-evaluation.md).
- Builds on: [ADR 0079](0079-decision-context-and-policy.md) (the `(s, a, π)` record this reads),
  [ADR 0018](0018-learning-seam-outcome-recorded.md) (the reward), [ADR 0078](0078-exploration-in-the-routing-seam.md)
  (the non-contextual case, which needs none of this).
- Part of: the kernel/1P/3P triage discipline (P10). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged (1.18.0)** — a new 1P package that only reads, plus one 3P package in
  the sibling repo.

## Context

"Agentic systems must learn continuously" is true, and the usual conclusion — *therefore the
framework should provide RL* — does not follow. The evaluation behind this ADR separated the
parts:

| Layer | Framework-shaped? |
|---|---|
| trajectory capture, credit assignment | **yes** — only the runtime sees the execution tree |
| policy serving, pinning, rollback | **yes** — needs the decision seam |
| off-policy evaluation on real traffic | **yes, and uniquely** — needs deterministic replay |
| the learning algorithm | **no** — pure maths over a dataset |
| model training, GPUs | **no** |

Loom owns the data and the safety. It does not own the maths. Shipping a trainer would make
loom a worse RLlib and buy a research treadmill it cannot win; shipping the substrate makes
every third-party learner usable and keeps loom the thing they plug into.

The differentiator is the third row. Most agent frameworks cannot evaluate a candidate policy
against historical traffic, because without deterministic replay there is no guarantee the
recorded choice is what actually ran. Loom has that guarantee, and after ADR 0079 it has the
observation and the propensity too.

## Decision

### `@loom/learning` (1P, new) — read-only over the log

- **`Policy` SPI** — `{ id, version, select(context, actions) }`. One method. No training hook
  and no lifecycle: training is offline and produces a *new version*, so a policy object is
  immutable evidence of one snapshot of what was learned.
- **`decideWithPolicy(ctx, id, policy, context, actions)`** — the one-line write side. It is a
  `ctx.decide` underneath, and exists so the fields evaluation needs cannot be forgotten: a
  hand-rolled decide that omits `alternatives` or `propensity` yields a log that looks fine and
  silently cannot be evaluated later.
- **`trajectories(events, opts)`** — credit assignment. Measured beats inferred: a direct
  `OUTCOME_RECORDED` wins; otherwise the terminal result is assigned, discounted backwards from
  the last decision; otherwise the step has **no reward** and is skipped rather than being
  silently counted as a zero.
- **`evaluatePolicy(trajectories, candidate)`** — SNIPS off-policy estimate, agreement rate,
  effective sample size, warnings.
- **`promotionGate(report, thresholds)` / `policyManifest(...)`** — a conservative verdict and
  the artifact a deployment pins. Rollback is a re-pin.
- **`loom learn report` / `loom learn eval`** — the same two things from the CLI, out of band.

### 3P (sibling repo `../loom-plugins`)

`loom-plugin-linucb` — disjoint LinUCB with Sherman–Morrison rank-1 updates (O(d²), no matrix
inversion), optional ε-greedy layer with exactly-reported propensities. It is the reference
consumer proving the SPI is sufficient for a real contextual learner.

## The judgment calls

**SNIPS, not IPS.** Plain inverse propensity scoring is unbiased and has unbounded variance; it
will cheerfully report a 3× improvement resting on one low-propensity step. Self-normalizing
trades a little bias for an estimate that does not explode. Weights are additionally clipped
(default 100) and the effective sample size is reported, because a big `evaluated` count hides
an estimate resting on three steps.

**The report is deliberately full of caveats.** An off-policy estimate over a *deterministic*
logging policy is not evidence — the log contains no counterfactuals — and the report says so
rather than printing a confident number. Same for missing contexts, missing propensities,
single-action "choices", and clipped weights. A learning loop that looks healthy while being
wrong is the failure mode this whole area is prone to; see ADR 0078 for the version of it we
already shipped once.

**The gate defaults to refusing.** 1000 evaluated steps, positive lift, an unbiased estimator,
and an effective sample size a tenth of the step floor. Re-running an evaluation is much
cheaper than discovering in production that four lucky steps carried the estimate.

**No storage.** `policyManifest` returns a value; persisting it is the caller's business, and
`promotedAt` is a parameter rather than a clock read, so the same inputs give a byte-identical
manifest.

**`select` runs before `decide`.** The kernel takes `DecideOptions` by value, so the propensity
must exist before the call — which means on replay the policy is consulted and its answer
discarded. The hazard this creates is real and is handled: a policy that has since changed and
now *throws* on an old context must not break the replay of an old execution, so the failure is
deferred into the decider, which replay never calls. Tested directly.

## Consequences

- **The loop closes without the kernel learning anything.** `KERNEL_ABI` and `EVENT_SCHEMA` are
  both untouched by this ADR; every new line is a read lens or a userspace helper.
- **A learned policy still only acts through `ctx.decide`.** Non-negotiable, and the reason
  this is safe: every learned choice stays recorded, auditable, replayable, and override-able.
- **Most users should not need this package.** For bandit routing over models, `ucb1` /
  `epsilonGreedy` in `@loom/reasoning` (ADR 0078) are the whole answer with no offline
  pipeline. `@loom/learning` earns its keep when the choice depends on the *observation*.
- **Reward definition remains the user's problem**, and remains the hardest part. Loom makes
  reward cheap to attach and hard to attach wrongly; it cannot say what "good" means.
- **Still not RL.** No sequential-credit machinery beyond discounted terminal assignment, no
  value iteration, no policy gradients, no training. If a workload genuinely needs those, they
  belong behind the same `Policy` SPI, in a package outside this repo.
