# ADR 0124 — The learning lifecycle: a policy registry with shadow/canary/rollback, content-addressed prompt and model versions, doubly-robust evaluation with bootstrap intervals, scoped JSONL export, an embedding SPI and an LLM eval harness

- Status: **Accepted** (on merge)
- Date: 2026-10-09
- Closes: R18 (agentic-readiness audit §Learning, recommendation 10)
- Builds on: [ADR 0078–0080](0080-learning-substrate.md) (the decision seam, propensity, `@loom/learning`),
  [ADR 0116](0116-late-outcome-attach.md) (late rewards), [ADR 0121](0121-one-canonical-agent-loop.md) (response decisions stamped
  `agent-response`, excluded from trajectories), [ADR 0123](0123-planning-depth-plan-graphs-replanning-and-goals.md) (the CAS-store,
  principal-scoped state pattern), [ADR 0119](0119-decide-scope-streaming-deltas.md) (`DecideScope`), [ADR 0085](0085-untrusted-content-integrity-axis.md)
  (taint), [ADR 0090](0090-knowledge-is-retrieval-over-memory.md) / [0091](0091-corpus-lifecycle-and-the-knowledge-package.md) (the MemoryStore `search` seam),
  [ADR 0083](0083-second-consumer-rule.md) (relaxed for Part R; consumers named below).
- Consumers: the **`learning-router`** example (the online -> offline -> gate loop currently ends at a verdict and a redeploy; this
  gives it a registry, a canary and a rollback), **loom-ui U11 learning signals** (being built concurrently: a composed surface's
  planner is a policy that must be canaried and attributable to a prompt/model version) and the **reference planner's propensity**
  (R16's planner decisions stamp a policy; a shadow candidate is how a new planner is judged on live traffic before it acts). The example
  specified for this ADR is `policy-rollout` in `loom-examples` (see the PR; this repo does not edit that one).
- Placement: **1P, kernel untouched.** `@loom/learning` (registry, rollout, versions, estimators, export), `@loom/memory` (the
  embedding SPI and a reference), `@loom/conformance` (two kits), `tools/eval` (the harness) and one additive option on `@loom/agent`.
  `KERNEL_ABI`, `EVENT_SCHEMA` and every existing SPI are unchanged; no syscall, event kind or payload field. The one new SPI
  (`EmbeddingProvider` / `VectorIndex`, 1.0.0) is optional and lives beside `MemoryStore`.

## Context

Re-measured on `main` at `00cfed73` against the audit's §Learning:

| Audit finding | State on `main` | Here |
|---|---|---|
| Policy seam frozen; no update hook | **Intentional (ADR 0080).** Training is out of band and produces a NEW version. | Unchanged. The registry is how a new version becomes live. |
| `promotionGate` returns a verdict only: no registry of promoted versions, no rollout/canary/shadow, rollback = redeploy | **Open.** `policyManifest` builds a record nobody stores. | `PolicyRegistry` + `decideWithRollout` (D1, D2). |
| No prompt/model versioning | **Open.** A decision's `policy` is `{id, version, propensity}`; `version` is a string a human maintains. | Content-addressed `promptVersion` / `modelVersion`, recorded in `policy.refs` (D3). |
| SNIPS only: no doubly-robust, no CIs/bootstrap | **Open.** One estimator, point estimates, plus warnings. | DR with a fitted or supplied reward model; seeded cluster bootstrap; a CI lower-bound gate (D4). |
| No trajectory/preference/fine-tune export (no jsonl/dpo) | **Open.** `trajectories` returns in-memory objects. | `exportJsonl` (D5). |
| `tools/eval` is golden-diff only | **Open.** | `runEvalSuite`, graders, cassette provider (D7). |
| No embedding SPI + reference vector backend (a 3P exists) | **Open.** `MemoryStore.search` is lexical in every 1P backend; semantic meant a 3P store that owned embedding, indexing and storage together. | `EmbeddingProvider`, `VectorIndex`, `EmbeddingMemoryStore` (D6). |
| (adjacent, already fixed) late rewards | **Fixed by R11 (ADR 0116).** | Reused: `recordOutcome` rewards flow into evaluation and export unchanged. |
| (adjacent, already fixed) response decisions polluting trajectories | **Fixed by R10 (ADR 0121).** `agent-response`, `agent-outcome`, `agent-abort` are filtered by `RECORDED_FACT_SOURCES`. | Reused: export goes through `trajectories`, so it inherits the filter. |
| (adjacent, already fixed) propensity on decisions; unit-level pooling; effective sample size | **Fixed by ADR 0079/0080.** | Reused; the bootstrap resamples by unit. |

## Decision

### D1 — A policy registry: immutable versions, promotion through a verdict, instant rollback

`PolicyRegistry({ kv, scope })` keeps, per policy id, the registered versions (`{version, contentHash, registeredAt, evidence?}`),
a `RolloutState` (`mode`, `incumbent`, `candidate`, `canaryFraction`, `salt`, `revision`) and a bounded history. It is a state
machine over a compare-and-set store (`DurableStateStore` satisfies `PolicyKvStore`; `InMemoryPolicyKv` is the reference), exactly
the pattern of ADR 0123's `DurableGoalStore`: load, pure change, `save(expectedRevision)`, retried a bounded number of times.

- **Versions are immutable evidence.** Re-registering a version with different `contentHash` throws
  `PolicyVersionConflictError`; the same content is idempotent. A version that could change meaning would invalidate every
  evaluation that named it.
- **Promotion is the one door.** `promote({id, version, report, verdict, mode, ...})` needs `verdict.ok` AND a report whose
  `policy` names exactly that `{id, version}`; a failing verdict or a verdict for another version is `PromotionRefusedError`,
  and nothing moves. The registry cannot be talked into a promotion the gate refused. The evidence (`policyManifest`) is stored
  on the version.
- **Modes.** `full` (the version becomes the incumbent, the previous one kept for rollback), `canary` (a stable fraction of
  units acts on the candidate), `shadow` (the candidate is logged beside the incumbent and never acts). `canary` and `shadow`
  need an incumbent (`bootstrap` installs the first one without a verdict: nothing is running to protect).
- **`rollback` is one CAS write.** To `to`, or by default to the incumbent before the last promotion to `full`; a canary or
  shadow rollback just drops the candidate. The next decision resolves to the old version. No redeploy.
- **Scoped, fail closed.** The scope (tenant/principal id from the AUTHENTICATED caller) is fixed at construction and is part of
  every key; no call carries a scope to spoof. A stored document that names another scope is `PolicyAccessDeniedError`, never
  served or extended. Names are validated, so an id cannot address another key.
- **Bounded.** History is a ring of 200; versions per id capped at 1000 (refused, not evicted: evicting evidence would be silent).
- `ramp` changes the canary fraction; the salt is stable, so raising 5% to 25% keeps the earlier units on the candidate.

### D2 — Acting through a rollout: shadow never acts, canary is a deterministic split, the decision records who acted

`decideWithRollout(ctx, decisionId, { source, policyId, resolve }, unitKey, context, actions, opts)` is `decideWithPolicy` for a
registry-governed policy. It reads the live state, runs the right version, and records in the decision's `policy` stamp:
the acting `{id, version, propensity}`, plus `rollout: { registry, mode, bucket?, armProbability?, acted, shadow? }`.

- **Shadow never acts.** The incumbent's choice is the decision; the candidate is run on the same context and its action and
  propensity are recorded in `rollout.shadow`. A candidate that throws is recorded as an error and changes nothing.
- **Canary is deterministic.** `bucket = sha256(salt || unitKey)` as a 48-bit fraction in [0,1); `bucket < canaryFraction` means
  the candidate acts. Same unit, same salt, same arm, in every process, with no assignment table. The bucket is recorded.
- **Replay is identical.** The choice and the stamp are recorded once by `ctx.decide` and served on every replay whatever the
  registry says by then (P9). Registry state is read before the call (as `select` is in `decideWithPolicy`) and a read failure
  is deferred into the decider, so a replay of an old execution never breaks on a registry that has since gone away.
- **Fail closed toward the incumbent.** A candidate version the process has no code for acts as the incumbent and records why. A
  missing incumbent is an error: there is nothing safe left to do.
- **Off-policy validity.** The recorded propensity is the ACTING policy's own, conditional on the arm. Pooling arms into one
  importance-weighted estimate needs the marginal probability of the action, which needs the other policy's probability for it,
  and `Policy.select` only reveals the probability of the action it sampled. So the rule is: evaluate per arm
  (`sliceByVersion(trajectories, "policy")`); `armProbability` is recorded for callers who can reconstruct the marginal. This is
  documented rather than papered over with a number that looks like a propensity and is not one.

### D3 — Prompt and model versions are content-addressed and recorded in the decision stamp

`promptVersion(id, template)` and `modelVersion(id, config)` return `{id, version: "sha256:<hex>"}` over a canonical (sorted-key)
form of the content; the version IS the content. They are recorded in `policy.refs` by `decideWithPolicy({refs})`,
`decideWithRollout({refs})` and, for the direct `reasoning` path, by `agentLoop$({versions})` on each journaled model-response
decision (`policy: {id: "agent-llm", version: <model version>, refs}`). The fold keeps the `policy` object verbatim, so no kernel
change is needed; it is descriptive and never a replay input, so logs written with or without it replay identically (tested
through the agent loop). `sliceByVersion(trajectories, "prompt" | "model" | "policy")` groups steps for evaluation; an unstamped step
lands in an honest `"(unversioned)"` bucket. **Limit:** the effect-ring model paths (`modelToolId`, `reasoningToolId`) record the
call as an effect frame, not a decision; they carry a version on the effect input instead, and the harness reports it (D7).

### D4 — Evaluation: doubly-robust and seeded bootstrap intervals; SNIPS is untouched

`evaluatePolicy(..., { doublyRobust, bootstrap })`:

- **Doubly robust.** `d_i = q(s_i, pi_i) + 1[pi_i = a_i] * w_i * (r_i - q(s_i, a_i))` averaged over steps with a usable propensity.
  `q` is a leave-one-out per-action mean fitted from the log (a row never predicts itself) or a caller-supplied
  `rewardModel(context, action)`. `report.doublyRobust = {value, lift, steps, rewardModel}`. `estimatedValue` and `estimator`
  keep their SNIPS meaning byte for byte: absent the new options the report is identical to before.
- **Bootstrap.** Percentile intervals for value and for lift, resampling whole UNITS (executions when no `unit` was attributed),
  so correlated steps are not counted as independent. Seeded (`mulberry32`), so the same inputs give the same interval;
  resamples are bounded (100..20,000: the cost is resamples x clusters). Intervals are computed per estimator that exists.
- **The gate.** `promotionGate({ minLiftLowerBound, intervalEstimator? })` requires the lift CI's lower bound to clear a floor
  (typically 0). A report with no interval FAILS it rather than passing vacuously, and a non-finite bound fails.
- Tested against synthetic logs with a known value (arms paying 0.3 and 0.7 under uniform logging; the candidate "always B" is
  worth 0.7 and the lift 0.2): both estimators land within tolerance and every interval covers the truth. Measured while
  developing: with an exactly-correct reward model DR was NOT lower-variance than SNIPS on that log, so no variance claim is made; DR's value here is consistency when the propensities are right and the model is approximate.

### D5 — Export: scoped, taint-aware, erasure-respecting, bounded, deterministic

`exportJsonl({ source, tenant, principal?, kinds, taint, ... }, stats)` is an async generator of canonical-JSON lines: a header,
`trajectory` records (one per execution), `preference` pairs (best vs worst chosen action of the same `decisionId` in the same
context across executions, with a reward margin), and a summary.

- **Scoped.** `tenant` is required. The source lists executions with their tenant (and principal); a non-matching or unlabelled
  execution is never LOADED. A loader that returns another execution's events is refused.
- **Taint (ADR 0085).** A step whose context, action, alternatives or policy carry tainted content is dropped by default;
  `taint: "mark"` keeps it with `tainted: true` and the origins. The scan is bounded and an overflow fails closed (treated as
  tainted), so a deep value cannot smuggle content past it.
- **Erasure.** A step carrying a `{ $shredded }` placeholder and any execution whose log records `PAYLOAD_SHREDDED` are excluded.
  There is no option to include them.
- **Streaming.** Executions are pulled page by page over a cursor and loaded one at a time; `maxExecutions`, `maxRecords`,
  `maxEventsPerExecution` and `maxLineBytes` bound the work; a bound that stops the run returns `nextCursor` (at-least-once: it
  resumes from the page start). The preference index is capped (`maxPreferenceGroups`) and is NOT carried across a resumed
  cursor: pairs form within one run.
- **Deterministic.** Source order, canonical key order, no clock, ties keep the earlier step: the same log gives the same bytes.
- `EventStore` has no global scan, so the application supplies `list`/`load` (its subject index or a read model); for compacted
  executions `load` returns `evidenceEvents(state, log)`.

### D6 — An embedding SPI, a reference index, and a semantic MemoryStore

In `@loom/memory`: `EmbeddingProvider { modelId, dimensions, maxBatchSize?, embed(texts, {signal}) }`, `VectorIndex`
(add/remove/clear/search/size, per-key), `InMemoryVectorIndex` (exact cosine, bounded top-k heap), `HashingEmbeddingProvider`
(deterministic feature hashing: lexical, not semantic; the offline reference every provider is held to) and
`EmbeddingMemoryStore({ store, provider, minScore })`, a `MemoryStore` decorator whose `search` is cosine ranking. SPI version
`EMBEDDING_PROVIDER_SPI_VERSION = "1.0.0"`; kits `runEmbeddingProviderConformance` and `runVectorIndexConformance` in
`@loom/conformance` (structural, so a 3P provider needs no dependency on loom beyond it). `EmbeddingMemoryStore` itself passes
`runMemoryStoreConformance`, floor included, and `KnowledgeBase` works over it unchanged.

- **The wrapped store stays the system of record.** The index is a derived cache, hydrated lazily on a key's first search (batched,
  bounded by `maxEntriesPerKey`: too large is `MemoryIndexTooLargeError`, never a silent truncation) and kept current by
  `append`/`remove`; `clear`/`replace` drop it. Hits are mapped back through `store.read`, so an entry removed behind the index's
  back is never returned (results are a subset of `read(key)`).
- **The floor is required.** The MemoryStore contract says a query matching nothing returns `[]`; cosine is defined against every
  entry, so `minScore` is a mandatory option, chosen per model (the SPI note on `search` already says this).
- **Replay: embeddings are RECOMPUTED, never recorded.** They are a cache; the entries are the truth. Embedding is nondeterministic
  across model versions and I/O, so it must not run in workflow code outside a decision: `recallRelevant` already runs `search`
  inside `ctx.decide` and records WHICH entries came back, so a replay serves that record and touches neither provider nor index
  (tested). `modelId` is stamped on the index; an index built for another model or dimension is `EmbeddingModelMismatchError`.
  Recording the vectors themselves was rejected: bulky, tied to a model that will be retired, and it would put derived data on
  the durable log.
- If embedding fails while appending to an already-indexed key, the append is NOT made: the store and its index never diverge silently.

### D7 — An LLM eval harness in `tools/eval`

`runEvalSuite({ name, cases, subject, graders, passScore, concurrency, versions })` runs cases against a subject (a function; a
`flowSubject` over a runtime; a bare provider call) and returns an `EvalSuiteReport`: per-case status/score/grader outcomes,
summaries by tag and by grader, and the prompt/model versions it ran under. The report is a pure function of its inputs: no clock,
no random, results in case order whatever the concurrency; `reportDigest` is a stable hash and `compareReports` lists regressions
(score drop, flip to failing, vanished case). Errored cases score 0 and stay in the denominator.

- **Graders:** `exactMatch`, `regexMatch`, `jsonSchema` (a documented JSON Schema subset or any zod-style `safeParse` schema; an
  unsupported keyword FAILS rather than passing vacuously) and `llmJudge`. A grader that throws fails closed; a required grader
  failing fails the case whatever the weighted score.
- **The judge runs through the decide scope.** `judge: { decide, toolId }` calls `decide(key, scope => scope.invokeTransient(toolId,
  {prompt}))`, so the call is authorized as the deciding execution (ADR 0119), recorded in its log and served from it on replay:
  re-grading an old run never calls the model again. A plain `judge(prompt)` function is the offline form. The graded output is
  fenced in the judge prompt as DATA and the verdict must be a JSON object with a score in [0,1], else the case fails.
- **Recorded providers:** `CassetteProvider` serves recorded `LlmResponse`s keyed by a hash of the request (`replay` is the
  default and NEVER calls a model: a request with no recording is a loud `CassetteMissError`, so changing a prompt fails the eval
  until re-recorded; `record` forwards and stores). `stubProvider` is a pure-function provider for tests.

### D8 — Compatibility

Nothing existing changes meaning. `evaluatePolicy` without the new options returns the same report (a regression test pins it);
`PolicyStamp` gains optional `refs`/`rollout` (stored verbatim by the fold, ignored by replay); `agentLoop$` gains an optional
`versions`; `@loom/memory` gains exports; `@loom/conformance` gains two kits. A log written before this ADR reads and replays as it
did. `@loom/learning` gains `@loom/classify` (a kernel leaf with no workspace dependencies) as a dependency; `@loom/eval` gains
`@loom/llm` (types).

### D9 — What this does not do

- It does not train. The policy seam stays frozen (ADR 0080); a candidate is a new immutable version produced elsewhere.
- It does not run a rollout controller (auto-ramp, auto-rollback on a metric). `ramp` and `rollback` are the primitives a controller
  would call; deciding when is application code today, and the consumers have not asked for more.
- It does not pool canary arms into one estimate (D2). It does not export fine-tune formats other than trajectory/preference JSONL;
  mapping to a trainer's schema is a line of application code over the stream.
- It does not give `EmbeddingMemoryStore` a durable or ANN index: `InMemoryVectorIndex` is exact and in-process (tens of
  thousands of entries per key); a bigger corpus wants a 3P `VectorIndex` (the kit is there). It does not make the hashing embedder
  semantic.
- It does not stamp prompt/model versions on the effect-ring model paths as decisions (D3), and the harness does not run a flow
  against a LIVE provider on its own: record a cassette first.

## Consequences

- A learned policy has a lifecycle: register, evaluate with an interval, promote through the gate, shadow, canary, finalize, roll
  back, with every step attributable from the decision log (who acted, what the other arm would have done, under which prompt and
  model version).
- Evaluation can say "the lift is positive at 95%" instead of printing a point estimate; the gate can require it.
- Trajectories can leave the system as a file without taking tainted, erased or other-tenant data with them.
- Semantic recall is available to `MemoryRuntime`/`TieredMemory`/`KnowledgeBase` without changing any of them and without owning
  the model.
- Costs: one more CAS read per rollout decision unless the caller caches `RolloutSource.resolve` (the registry exposes `revision`
  for that); the export's preference index and the bootstrap are memory/CPU bounded but not free.

## Questions for the user

1. **Canary arms are evaluated per arm, not pooled (D2).** The alternative is to require policies to expose `P(a | context)` for
   any action (a new optional `Policy.probability`), which would let a rollout log the true marginal propensity and be evaluated
   as one population. That extends the frozen policy seam, so it was not done. Wanted?
2. **`promote` needs a fresh passing verdict for every mode change**, including shadow to canary to full. The alternative is one
   verdict authorizing the whole ramp. Fail-closed was chosen; say if it is too strict for a ramp.
3. **Bootstrap defaults are off.** `promotionGate` only uses an interval when asked. Should `policyManifest`/the example make
   `minLiftLowerBound: 0` the recommended default?
4. **The hashing embedder ships in `@loom/memory`** as the offline reference. If a 1P package with a real model client is wanted it
   is a plugin (`@loom/plugin-*`), not part of this ADR.
