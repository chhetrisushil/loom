# Continuous Learning / RL — Placement Evaluation

- Status: **Verdicts recorded; nothing built.** Scoping document only.
- Evaluates: the proposal that loom provide reinforcement learning as a
  first-class framework capability, so agentic apps built on loom improve
  continuously.
- Method: the ADR 0051 discipline — one placement verdict per component
  (kernel / 1P / 3P / reject), each judged against the best userland
  alternative, bias outward (P10). Every claim below was checked against the
  repo record before judgment.

---

## TL;DR

> **Loom should not ship RL. Loom should ship the closed-loop substrate —
> attribution, policy-as-versioned-artifact, and off-policy evaluation on the
> durable log — and leave the learning algorithm to 3P.**

The framing in the proposal is off by one level. The user-facing benefit is not
*"loom gives you RL"*. It is:

> **Loom is the only agent runtime where you can evaluate a new policy against
> real production traffic before shipping it, and explain every decision it
> made afterward.**

That property falls out of the event log and `@loom/replay-vm` that already
exist. It is defensible against every competitor, and it does not require loom
to enter the model-training business.

---

## 1. Verdict table

| # | Component | Verdict | Rationale |
|---|---|---|---|
| L1 | `context` + `policy` fields on `DECISION_RECORDED` | **Kernel** (additive payload) | Only the kernel writes this event. Without an observation on the decision, no *contextual* policy is learnable from the log — only a global per-key mean. ~10 lines, `EVENT_SCHEMA` minor bump, `KERNEL_ABI` unchanged. |
| L2 | Exploration wrappers, sample floor, recency decay | **1P — `@loom/reasoning`** | Routers already live there. Also repairs a shipped defect (§3). |
| L3 | Trajectory extraction + credit assignment | **1P — new `@loom/learning`** | A read-only lens over the log, identical posture to `@loom/analytics`. Needs the execution tree, which is runtime knowledge. |
| L4 | `Policy` SPI (`select(context, actions)`) | **1P — `@loom/learning`** | One interface is all 3P needs to plug in. |
| L5 | Offline / shadow policy evaluation via replay | **1P — `@loom/learning`** | **The differentiator.** Requires deterministic replay + recorded alternatives. No other framework can offer it. |
| L6 | Policy promotion, pinning, canary, rollback | **1P — `@loom/learning`** + `@loom/verify` rule | Safety envelope; reuses K2 grants and DST scenarios. |
| L7 | Bandit / RL algorithms (Thompson, LinUCB, PPO…) | **3P** (`../loom-plugins`) | Pure math over a dataset. Zero kernel knowledge required. |
| L8 | In-process training, gradient updates, GPU orchestration | **REJECT** | Not a framework concern. Loom would become a bad RLlib and inherit a research treadmill it cannot win. |
| L9 | A learned policy acting *outside* `ctx.decide` | **REJECT** | Breaks P9 auditability, which is the entire reason learning is safe here. Non-negotiable. |

---

## 2. What loom already has

This is the most important finding, and it reframes the question. Loom already
ships a working bandit loop:

| Loop stage | Where it lives |
|---|---|
| **Action** logged | `ctx.decide` → `DECISION_RECORDED` — `packages/workflow-runtime/src/WorkflowContext.ts:300` |
| **Reward** logged | `recordOutcome` → `OUTCOME_RECORDED` — `packages/analytics/src/outcomes.ts:36` |
| **Aggregation** | `outcomeAnalytics` / `rankFromOutcomes` — `packages/analytics/src/outcomes.ts:53,78` |
| **Policy consumption** | `rankedRouter(rankings)` — `packages/reasoning/src/router.ts:30` |
| **Replay safety** | the *choice* is served from the log, so an improving policy never breaks determinism (P9) |

That last row is the hard part, and it is already solved.

Most agent frameworks **cannot** do continuous learning safely, because a
changing policy makes replay non-deterministic. Loom sidesteps this by recording
the *outcome of the decision* rather than the policy that produced it. The
expensive prerequisite for learning is therefore done.

So the question is not *"should loom do RL"*. It is **"what is missing from the
loop loom already has"**.

---

## 3. The shipped loop has a live defect

`rankedRouter` is pure argmax — no exploration, no sample floor, no confidence
interval (`packages/reasoning/src/router.ts:39-47`). Combined with the mean
reward `rank = sum / count` (`packages/analytics/src/outcomes.ts:65`):

- one lucky success gives an arm `rank = 1.0`;
- it wins every subsequent `select`;
- no other arm is ever tried again;
- `rank 1.0 @ n=1` beats `rank 0.99 @ n=10_000`;
- untried arms score `-Infinity` and are unreachable forever.

That is a textbook bandit collapse, in production code, on the path currently
labelled "self-optimization".

**Why it matters for this evaluation:** it is direct evidence for the thesis.
The value loom adds is not *more* learning — it is making the learning it
already enables *not silently wrong*.

---

## 4. Decomposing "RL" — most of it is not framework-shaped

| Layer | Framework-shaped? | Owner |
|---|---|---|
| Trajectory capture `(s, a, r, s′)` | **Yes** — only the runtime sees it | loom |
| Credit assignment across a multi-step flow | **Yes** — needs the execution tree | loom |
| Policy serving, pinning, rollback | **Yes** — needs the decision seam | loom |
| Off-policy / counterfactual evaluation | **Yes, uniquely** — needs deterministic replay | **loom's differentiator** |
| Safety envelope (blast radius, kill switch) | **Yes** — K2 grants/quotas already exist | loom |
| The learning algorithm (UCB, LinUCB, PPO, GRPO) | **No** — pure math over a dataset | 3P |
| Model training, GPUs, fine-tuning | **No** | not loom, ever |

The line is clean: **loom owns the data and the safety, not the math.**

Ship a trainer and loom becomes a worse RLlib. Ship the substrate and every 3P
learner becomes usable, with loom as the thing they plug into.

---

## 5. The critical case against

Read this before building anything.

### 5.1 "Continuous learning needs RL" is mostly false in practice

The overwhelming majority of production agent improvement is: prompt/route
selection, tool choice, retrieval ranking, retry strategy, escalation
thresholds. Those are **contextual bandits** — one step, immediate reward, no
state transition. Sequential-credit RL only matters when early actions change
the reachable state space *and* reward is terminal.

**Implication:** scope to bandits first. "RL" branding invites users to reach
for PPO where an ε-greedy would do.

### 5.2 Reward is the bottleneck, and it is the user's problem

Nearly every failed agent-learning project dies on reward definition, not on
algorithm choice. Loom cannot supply reward. What it *can* do is make reward
cheap to attach and hard to attach wrongly.

Today `Outcome.decisionId` is optional (`packages/analytics/src/outcomes.ts:29`),
so in practice nobody sets it, and rankings aggregate globally across unrelated
contexts. **That silently learns the wrong thing while looking healthy.**

### 5.3 You cannot learn a contextual policy from the current log

`DECISION_RECORDED` carries no observation. The payload
(`packages/workflow-runtime/src/WorkflowContext.ts:311-323`) is `choice`,
`rationale`, `source`, `alternatives`, cost/latency estimates, `confidence` —
no state.

So the only learnable policy is a global per-key mean. This is the one place a
kernel touch is genuinely load-bearing (verdict L1).

### 5.4 Learned behaviour vs. auditability

Real tension, but P9 already resolves it — and that resolution must stay
non-negotiable: **a learned policy may influence behaviour only through
`ctx.decide`.** Never a hidden mutation of routing, retry, or scheduling.

If a user cannot answer *"which policy version chose this, and why"*, the
feature is a liability in any regulated deployment.

### 5.5 Feedback loops poison their own training data

A greedy policy stops sampling alternatives → the log stops containing
counterfactuals → the next policy is trained on a degenerate distribution.

This needs forced exploration **and** propensity logging (record `P(a|s)` at
decision time), or off-policy evaluation is mathematically invalid later.
Nobody adds propensity retroactively — it must be logged from day one, which is
why it belongs in the L1 payload rather than in a later package.

---

## 6. What to build, ranked by value / cost

### T1 — Make the existing loop correct — **DONE** ([ADR 0078](../adr/0078-exploration-in-the-routing-seam.md))

Small, pure win. **Worth doing regardless of the RL decision.**

- Exploration in `@loom/reasoning`: `ucb1(stats)` and `epsilonGreedy(inner, {
  epsilon, rng })`. **Thompson was dropped** — it needs Bernoulli or bounded
  rewards and `score` is unbounded by contract, while UCB1 covers the same need
  *deterministically*, which is worth more in a replay-first runtime than the
  marginal empirical edge.
- `outcomeAnalytics` already returns `count` — `rankedRouter` now takes
  `ArmStats[]` and respects a `minSamples` floor, falling back to `tagRouter`
  below it. Setting the floor without counts throws rather than silently
  no-opping.
- Recency decay in `outcomeAnalytics`/`rankFromOutcomes` via `halfLifeMs`, with
  `now` defaulting to the newest outcome in the log rather than the wall clock,
  so a ranking stays a pure function of its input. Non-stationarity is real:
  model quality changes under you when a provider ships a new checkpoint.

`rankedRouter` stays pure-exploit **by default** — implicit exploration would
silently change every existing deployment, which is the same class of mistake
being fixed. Non-collapse is available and documented, not automatic.

### T2 — The kernel touch: make decisions learnable

Additive, alongside the existing D1 descriptive fields on `DecideOptions`:

```ts
context?: Record<string, unknown>;   // the observation the policy saw
policy?: { id: string; version: string; propensity?: number };
```

This turns the log from *"what was chosen"* into a genuine `(s, a, π)` dataset;
`OUTCOME_RECORDED` supplies `r`. `EVENT_SCHEMA` minor bump, `KERNEL_ABI`
unchanged. **Everything else in this proposal can live outside the kernel
precisely because of this field.**

### T3 — `@loom/learning` (1P) — the differentiator

- **`trajectories(events)`** — a read lens like every other analytics lens,
  folding `DECISION_RECORDED` + `OUTCOME_RECORDED` +
  `EXECUTION_COMPLETED/FAILED` into `(context, choice, reward)` tuples, with
  credit assignment down the execution tree (a terminal flow reward attributed
  to the decisions on its causal path — the parent/child links already exist
  from the orchestration work).
- **`Policy` SPI** — `{ id, version, select(context, actions): Action }`. One
  interface; 3P implements it.
- **`evaluate(candidatePolicy, historicalLog)`** — replay historical executions
  with the candidate in *shadow*: it proposes, the recorded choice still wins,
  and you get an agreement/regret report.

  This is the feature no other framework can offer, because it requires
  deterministic replay plus recorded alternatives. It is also the honest answer
  to *"how do I know the new policy is better before I ship it?"*
- **`promote()`** — gated on the eval report, a `@loom/verify` rule, and a DST
  scenario. Policies are versioned artifacts, pinned per deployment; rollback is
  a re-pin.

### T4 — 3P learners

`../loom-plugins` gets a contextual-bandit implementation as the reference.
Vendors (fine-tune services, eval platforms) implement the same SPI.

---

## 7. Developer experience

**The bar:** a developer gets learning by adding *one option to a decision they
were already making*, and gets **nothing** implicit.

```ts
// Before — a static choice
const route = await ctx.decide("route", () => tagRouter.select(req, routes));

// After — a learned choice.
// Same seam, same audit trail, same replay guarantee.
const route = await ctx.decide(
  "route",
  () => policy.select({ intent, tokens, tenant }, routes),
  { context: { intent, tokens, tenant }, policy: policy.stamp }
);

await ctx.run(step, input);
recordOutcome(ctx, { key: route.id, score: quality, decisionId: "route" });
```

Then, out-of-band and never in the request path:

```console
$ loom learn report          # trajectories, per-arm regret, exploration coverage
$ loom learn eval <policy>   # shadow-replay against the last N days of real logs
$ loom learn promote <policy> --canary 5%
```

Two DX rules to hold firm on:

1. **Learning is opt-in per decision.** No global "enable learning" switch. The
   blast radius of a bad policy must equal the blast radius of one `decisionId`.
2. **Training is offline and out-of-band.** Nothing about it touches the
   execution hot path; a flow only ever reads a pinned policy artifact.

---

## 8. Incidental findings

Noted while reading; not part of the verdict, but they affect anything built on
top of this loop.

| # | Finding | Location |
|---|---|---|
| F1 | `appendAudit` is unbounded, so the `_outcomes` list grows without limit inside a single execution's state. Fine for a request-scoped flow; a slow leak for a perpetual sentinel execution. | `packages/replay-vm/src/eventHandlers.ts:62-70`, `:405` |
| F2 | `Outcome.decisionId` being optional is what will quietly make any learning built on top of it wrong. It should be **required** on the learning path. | `packages/analytics/src/outcomes.ts:29` |

---

## 9. Summary

- The idea is sound; the framing is one level too high.
- ~70% of the loop already exists, including the hardest part (replay-safe
  learned decisions).
- One small additive kernel field unlocks contextual learning; everything else
  stays outward.
- Fix the greedy router first — it is a standalone win and a cautionary example.
  **Done** ([ADR 0078](../adr/0078-exploration-in-the-routing-seam.md)); T2–T4
  remain unbuilt.
- Keep the math outside the framework.
