# `@loom/learning`

**Loom does not ship reinforcement learning. It ships the substrate a learning loop needs and
cannot build for itself.**

The pitch is narrow and, as far as we know, unique:

> Evaluate a new policy against **real production traffic** before it is allowed to choose
> anything — and explain every decision it made afterwards.

That works because loom's log already records what a counterfactual needs, and because
replay determinism means the recorded choice *is* what ran.

- [Why this is possible here](#why-this-is-possible-here)
- [Using it](#using-it)
- [The `Policy` SPI](#the-policy-spi)
- [The learning lifecycle (ADR 0124)](#the-learning-lifecycle-adr-0124)
- [What this package deliberately does not do](#what-this-package-deliberately-does-not-do)

---

## Why this is possible here

A learned policy normally breaks deterministic replay: the policy changes, so a re-run takes a
different path. Loom sidesteps that at the seam — `ctx.decide` records the **outcome of the
decision**, not the policy, so replay serves the recorded choice and the policy is never
re-consulted (P9). Policies can improve freely between runs; no past run ever replays
differently.

On top of that, `DECISION_RECORDED` carries (ADR 0079):

| Field | Why an offline learner needs it |
|---|---|
| `context` | the observation — without it only a global per-arm mean is learnable |
| `policy.propensity` | `P(chosen \| context)` — **cannot be reconstructed later**; without it, off-policy evaluation is biased |
| `alternatives` | the action set, so a counterfactual has something to range over |
| `OUTCOME_RECORDED.decisionId` | ties the reward back to the decision that earned it |

---

## Using it

### 1. Make a decision learnable — one line

```ts
import { decideWithPolicy } from "@loom/learning";

const route = await decideWithPolicy(
  ctx, "route", policy,
  { intent, tokens, tenant },   // the observation
  routes                        // the action set
);
```

This is a normal `ctx.decide` underneath: recorded once, served from the log on replay,
auditable. It just guarantees the fields evaluation will need are actually present — a
hand-rolled `decide` that forgets `propensity` produces a log that looks fine and silently
cannot be evaluated later.

### 2. Score it

```ts
import { recordOutcome } from "@loom/analytics";

recordOutcome(ctx, { key: route, score: quality, decisionId: "route" });
```

`decisionId` is what turns a global average into per-decision credit. Set it.

### 3. Mine the log, offline and out of band

```ts
import { trajectories, evaluatePolicy, promotionGate } from "@loom/learning";

const ts = trajectories(events, { discount: 0.9 });
const report = evaluatePolicy(ts, candidatePolicy);
const verdict = promotionGate(report, { minSteps: 5_000 });
```

Or from the CLI:

```console
$ loom learn report --db ./loom.db          # trajectories, rewards, coverage
$ loom learn eval --db ./loom.db --policy ./my-policy.js
```

**Credit assignment** prefers what was measured: a direct `OUTCOME_RECORDED` wins; otherwise
the execution's terminal result is assigned, discounted backwards from the last decision
(`discount ** stepsFromEnd`); otherwise the step has no reward and is skipped rather than
being silently counted as a zero.

**Evaluation** reports a SNIPS (self-normalized inverse propensity) estimate, an agreement
rate, an effective sample size, and a list of warnings. It uses SNIPS rather than plain IPS
because plain IPS has unbounded variance and will cheerfully claim a 3× improvement on the
strength of one low-propensity step. The report is deliberately full of caveats — an estimate
computed over a deterministic logging policy is not evidence, and it says so instead of
printing a confident number.

---

## Pooling across units

Off-policy evaluation is gated by **exploration volume, not log length**. If a product caps
exploration to protect the user — say two exploratory decisions per person per week — then eight
weeks of history yields ~16 counterfactual steps per person. Non-exploratory steps carry weight
≈ 1 and only inform the estimate where the candidate *agrees* with the incumbent, so a candidate
that meaningfully differs is judged on those ~16. The gate then refuses for thin evidence, which
is correct and reads as "the new policy lost".

The fix is to pool the **evaluation set** across consenting units. Importance weighting handles
this correctly even when each unit ran a *different* policy, because every step carries the
propensity that actually generated it.

```ts
const ts = trajectories(events, { unitOf: (_id, ctx) => ctx?.tenant as string });
const report = evaluatePolicy(ts, candidate);
promotionGate(report, { minSteps: 5_000, minUnits: 20 });
```

Pooling is also how a pooled estimate quietly becomes one heavy unit's estimate, so the report
carries unit-level statistics whenever `unit` is set:

| Field | What it tells you |
|---|---|
| `units` | how broad the evidence is |
| `unitEstimatedValue` | the **cluster-robust** estimate — mean of each unit's own SNIPS value, equally weighted. What the policy is worth for a *typical* unit |
| `unitEffectiveSampleSize` | how many **units** the estimate rests on. `effectiveSampleSize` treats steps within a unit as independent — they are not — so it overstates pooled evidence |
| `maxUnitWeightShare` | the largest single unit's share of the importance weight |

Three warnings fire on the ways pooling misleads: one unit supplying most of the weight; a unit
ESS far below the unit count; and a material gap between the pooled and per-unit estimates, which
means the population is heterogeneous and the pooled number describes nobody.

`minUnits` **fails closed**: a report with no unit attribution does not pass the gate vacuously,
it fails it, with a message telling you to pass `unitOf`.

### A report never names a unit

This is a **deliberate constraint, not an implementation detail.** Pooling is defensible because
it produces statistics *about policies* — never visibility into *people*. So the per-unit map is
local to `evaluatePolicy`, and only aggregates leave: a count, a mean of per-unit estimates, an
effective sample size, and the largest single share. **No unit identifier appears in an
`EvalReport` or in its rendering**, including inside warning strings, which is where a computed
value is most likely to drag an id along with it.

An invariant test enforces it — pooling with distinctively-named units and asserting neither the
serialized report nor `formatEvalReport` output contains any of them. It has been verified to
fail against a deliberately injected `perUnitEstimates` field, because a guard nobody has watched
fail is indistinguishable from a comment.

Two consequences worth knowing before you extend this:

- **Do not add a per-unit-keyed field** to `EvalReport`, however useful it would be for
  debugging. That is the line between an evaluation set and a ranking of people, and it is the
  one change that would make pooling indefensible.
- **Consent is upstream of this package.** `unitOf` is a mechanism; deciding *whose* data may
  enter a pool, enforcing it when the event set is assembled, and handling revocation are
  application concerns. Filtering at assembly rather than at report time is the same discipline
  as classifying sensitive fields at capture rather than redacting after.

## The `Policy` SPI

One method. No training hook, no lifecycle:

```ts
interface Policy<A = string> {
  readonly id: string;
  readonly version: string;
  select(context: PolicyContext, actions: readonly A[]): { action: A; propensity?: number };
}
```

Training happens offline and produces a **new version** — a policy object is immutable
evidence of one snapshot of what was learned. Implementations live outside this repo; see
[`../loom-plugins`](https://github.com/chhetrisushil/loom-plugins) for a LinUCB contextual
bandit built against this interface.

`select` runs INSIDE the decider passed to `ctx.decide` (and so do `decideWithRollout`'s registry
read, resolver and shadow-arm `select`): a replay serves the recorded choice and consults none
of them, so a model-backed or side-effecting policy is not run for an answer that would be
thrown away, and a policy that later starts throwing on an old context will **not** break the
replay of an old execution. On a first run a throwing policy surfaces as the error. `select`
should still be cheap and free of side effects you cannot repeat: it runs once per live decision.

---

## The learning lifecycle (ADR 0124)

Past "evaluate, then redeploy", [ADR 0124](../../docs/adr/0124-learning-lifecycle.md) adds the pieces to
roll a candidate out and judge it on the traffic it actually saw:

- **`PolicyRegistry`** keeps, per scope (a tenant or principal id from the authenticated caller), the
  registered versions of a policy and its rollout (`register`, `bootstrap`, `promote`, `ramp`, `rollback`,
  `resolve`, `history`). A rollout is `full`, `canary` (a fraction of units) or `shadow`. `promote` runs
  `promotionGate` itself against the report you hand it (`thresholds` option) and refuses
  (`PromotionRefusedError`) rather than trust a caller's verdict. State lives behind a small CAS
  `PolicyKvStore`; `InMemoryPolicyKv` is the in-process one.
- **`decideWithRollout`** is `decideWithPolicy` for a policy that has a registry: it reads who is live inside
  the decider (so a replay reads nothing), lets that version act, and stamps the decision with who acted and
  who watched. A shadow candidate never acts (its choice is recorded beside the incumbent's); a canary is a
  deterministic split by `rolloutBucket(salt, unitKey, secret?)`, so pass a server-assigned `unitKey` and a
  `bucketSecret`. A candidate the process has no code for acts as the incumbent and records why.
- **Content-addressed versions.** `promptVersion(id, template)` and `modelVersion(...)` return a
  `{ id, version }` whose version is the `sha256` of the canonical content (`contentHash`, `canonicalJson`),
  so a one-character prompt edit cannot reuse an old version. Pass it as `refs` to `decideWithRollout` and
  slice an evaluation with `sliceByVersion(trajs, "prompt" | "model" | "policy")`.
- **Doubly-robust and bootstrap evaluation.** `evaluatePolicy(ts, candidate, { doublyRobust: true | { rewardModel },
  bootstrap: { resamples, level, seed } })` adds `report.doublyRobust` and seeded percentile-bootstrap
  `report.intervals` that resample whole units. SNIPS and `estimatedValue` are unchanged.
- **Export.** `exportJsonl({ source, tenant, ... })` streams trajectories and (prompt, chosen, rejected)
  preference pairs as canonical JSONL for fine-tuning or reward modelling. It is scoped to one tenant (an
  execution with no tenant is never exported), drops tainted content unless `taint: "mark"`, and never
  includes crypto-shredded steps.

---

## What this package deliberately does not do

| Not here | Why |
|---|---|
| Learning algorithms (UCB, LinUCB, Thompson, PPO) | pure math over a dataset — third-party, behind the SPI |
| Model training, fine-tuning, GPUs | not a framework concern; loom would lose to dedicated tooling |
| Anything that writes to the log | this is a read lens, like `@loom/analytics` |
| Anything that changes behaviour implicitly | a learned policy influences a run **only** through `ctx.decide`, or auditability is gone |
| Reward definition | only you know what "good" means; loom makes reward cheap to attach and hard to attach wrongly |

For simple bandit routing over models you may not need this package at all — `ucb1` and
`epsilonGreedy` in `@loom/reasoning` ([ADR 0078](../../docs/adr/0078-exploration-in-the-routing-seam.md))
cover that case without any offline pipeline.

See [ADR 0080](../../docs/adr/0080-learning-substrate.md) for the placement reasoning, and the
[continuous-learning evaluation](../../docs/requirements/2026-08-12-continuous-learning-rl-evaluation.md)
for why RL itself was scoped out.
