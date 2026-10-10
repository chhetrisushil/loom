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
- **Promotion is the one door, and the registry runs the gate itself.** `promote({id, version, report, thresholds?, mode, ...})`
  runs `promotionGate` with the registry's constructor `thresholds` (else the gate defaults) as a FLOOR and, when the call passes
  `thresholds`, with those too - both must pass, so a per-call override can only tighten (round 2: `thresholds: {}` used to replace a
  stricter registry setting) - and the report's `policy` must name exactly that `{id, version}`; a failing gate is `PromotionRefusedError`, and a caller-supplied
  `verdict` is refused outright (fix round 1: a loose `{ ok: true }` is bound to nothing, so a verdict computed elsewhere, or hand
  built, could be paired with any report). The report itself remains caller-supplied evidence - the registry cannot re-run an
  evaluation - so who may call `promote` is an authorization question for the application. The re-derived verdict (`policyManifest`)
  is stored on the version.
- **Modes.** `full` (the version becomes the incumbent, the previous one kept for rollback), `canary` (a stable fraction of
  units acts on the candidate), `shadow` (the candidate is logged beside the incumbent and never acts). `canary` and `shadow`
  need an incumbent (`bootstrap` installs the first one without a verdict: nothing is running to protect).
- **`rollback` is one CAS write, and only returns to something that was live.** A version carries `wasIncumbent` once it has been
  bootstrapped or promoted to `full`; `rollback({ to })` refuses any other version (`PromotionRefusedError`: making a version live
  that no gate judged is `promote`, not a rollback - fix round 1 closed `register(evil)` then `rollback({ to: "evil" })`). The default
  target is `previousIncumbent`, kept on the rollout state (not derived from the 200-entry history ring, which a busy registry
  overflows); a canary or shadow rollback just drops the candidate; a second default rollback after a rollback has no target
  rather than flipping back to the version just rolled away from. The next decision resolves to the old version. No redeploy.
- **Scoped, fail closed.** The scope (tenant/principal id from the AUTHENTICATED caller) is fixed at construction and is part of
  every key; no call carries a scope to spoof. A stored document that names another scope is `PolicyAccessDeniedError`, never
  served or extended. Names are validated, so an id cannot address another key, and version names that every object "has"
  (`constructor`, `__proto__`, `toString`...) are reserved and every version lookup is an own-property lookup (fix round 1: they
  used to answer from the prototype chain and `__proto__` rewrote it).
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
  registry says by then (P9). Registry state is read inside the decider (see the R18 follow-up note below), so a replay of an old execution never reads it and never breaks on a registry that has since gone away.
- **Fail closed toward the incumbent.** A candidate version the process has no code for acts as the incumbent and records why
  (`rollout.shadow.error`, `rollout.fellBack`, and the INCUMBENT arm's `armProbability`, not the candidate slice the bucket fell
  in). A missing incumbent is an error: there is nothing safe left to do. The stamp names the code that RAN: a resolver that
  returns a policy whose `version` is not the one the registry named is refused (incumbent) or treated as unavailable (candidate).
- **The split is public unless you key it.** The bucket is a function of the rollout salt (`<id>:<version>`, readable in the
  registry) and `unitKey`. `unitKey` MUST be assigned by the server (an authenticated principal's id), never taken from request
  text, or a caller picks the arm they land in; `bucketSecret` (an HMAC key held by the server) makes the bucket unpredictable
  from the public salt as a second line of defence.
- **Off-policy validity.** The recorded propensity is the ACTING policy's own, conditional on the arm. Pooling arms into one
  importance-weighted estimate needs the marginal probability of the action, which needs the other policy's probability for it,
  and `Policy.select` only reveals the probability of the action it sampled. So the rule is: evaluate per arm
  (`sliceByVersion(trajectories, "policy")`); `armProbability` is recorded for callers who can reconstruct the marginal. This is
  documented rather than papered over with a number that looks like a propensity and is not one. (Decided, review round 1: keep
  per-arm evaluation; no `Policy.probability`.)

### D3 — Prompt and model versions are content-addressed and recorded in the decision stamp

`promptVersion(id, template)` and `modelVersion(id, config)` return `{id, version: "sha256:<hex>"}` over a canonical (sorted-key)
form of the content; the version IS the content. They are recorded in `policy.refs` by `decideWithPolicy({refs})`,
`decideWithRollout({refs})` and, for the direct `reasoning` path, by `agentLoop$({versions})` on each journaled model-response
decision (`policy: {id: "agent-llm", version: <model version>, refs}`). The fold keeps the `policy` object verbatim, so no kernel
change is needed; it is descriptive and never a replay input, so logs written with or without it replay identically (tested
through the agent loop). `sliceByVersion(trajectories, "prompt" | "model" | "policy")` groups steps for evaluation (keys join id and version with NUL so
no id can forge another's); an unstamped step lands in an honest `"(unversioned)"` bucket. **Readable from the agent loop (fix round 1):**
the model-response decisions that carry `versions` are recorded facts and are filtered out of trajectories, so `trajectories()`
indexes their refs per execution and gives every step of that run `TrajectoryStep.refs` (its own `policy.refs`, else the nearest
preceding response's); `exportJsonl` writes them and an end-to-end test goes agent log -> trajectories -> `sliceByVersion`. **Limit:** the effect-ring model paths (`modelToolId`, `reasoningToolId`) record the
call as an effect frame, not a decision; they carry a version on the effect input instead, and the harness reports it (D7).

### D4 — Evaluation: doubly-robust and seeded bootstrap intervals; SNIPS is untouched

`evaluatePolicy(..., { doublyRobust, bootstrap })`:

- **Doubly robust.** `d_i = q(s_i, pi_i) + 1[pi_i = a_i] * w_i * (r_i - q(s_i, a_i))` averaged over steps with a usable propensity.
  `q` is a leave-one-out per-action mean fitted from the log (a row never predicts itself) or a caller-supplied
  `rewardModel(context, action)`. `report.doublyRobust = {value, lift, steps, rewardModel}`. `estimatedValue` and `estimator`
  keep their SNIPS meaning byte for byte: absent the new options the report is identical to before.
- **Bootstrap.** Percentile intervals for value and for lift, resampling whole UNITS (executions when no `unit` was attributed),
  so correlated steps are not counted as independent. The lift subtracts the logged mean over the SAME rows the estimate averages
  over (those with a usable propensity); an earlier draft subtracted the mean over every evaluated step, mixing two populations. Seeded (`mulberry32`), so the same inputs give the same interval;
  resamples are bounded (100..20,000: the cost is resamples x clusters). Intervals are computed per estimator that exists.
- **The gate.** `promotionGate({ minLiftLowerBound, intervalEstimator? })` requires the lift CI's lower bound to clear a floor
  (typically 0). A report with no interval FAILS it rather than passing vacuously, and a non-finite bound fails. It also needs
  `minClusters` (default 20) resampled clusters: a bootstrap over one execution resamples the same values, its interval collapses
  to a point, and "the lower bound clears zero" would then be true of any positive estimate (fix round 1).
- Tested against synthetic logs with a known value (arms paying 0.3 and 0.7 under uniform logging; the candidate "always B" is
  worth 0.7 and the lift 0.2): both estimators land within tolerance and every interval covers the truth. Measured while
  developing: with an exactly-correct reward model DR was NOT lower-variance than SNIPS on that log, so no variance claim is made; DR's value here is consistency when the propensities are right and the model is approximate.

### D5 — Export: scoped, taint-aware, erasure-respecting, bounded, deterministic

`exportJsonl({ source, tenant, principal?, kinds, taint, ... }, stats)` is an async generator of canonical-JSON lines: a header,
`trajectory` records (one per execution), `preference` pairs (best vs worst chosen action of the same `decisionId` in the same
context across executions, with a reward margin), and a summary.

- **Scoped.** `tenant` is required. The source lists executions with their tenant (and principal); a non-matching or unlabelled
  execution is never LOADED. A loader that returns another execution's events is refused. **The tenancy guarantee rests on the
  application-supplied `list()` labels:** `EventEnvelope` carries no tenant, so the export cannot verify them; attributing child,
  fork and coordinator executions to the right tenant is the source's responsibility.
- **Taint (ADR 0085).** A step whose context, action, alternatives or policy carry tainted content is dropped by default;
  `taint: "mark"` keeps it with `tainted: true` and the origins. The scan is bounded and an overflow fails closed: the step is
  skipped in EVERY mode (`skipped.scanOverflow`): a walk that gave up cannot rule out a shred placeholder, erasure has no "keep" option,
  and a taint mark could not say what it left unmarked. (Round 1 marked overflowed steps in `mark` mode; round 2 skips them.)
- **Erasure.** A step carrying a `{ $shredded }` placeholder and any execution whose log records `PAYLOAD_SHREDDED` are excluded.
  There is no option to include them. Compaction folds that event away into `variables._shredded`, so `evidenceEvents(state, log)`
  synthesizes a `PAYLOAD_SHREDDED` marker whenever the state carries `_shredded` (fix round 1; without it a shredded-then-compacted
  execution exported its folded plaintext).
- **Streaming.** Executions are pulled page by page over a cursor and loaded one at a time; `maxExecutions`, `maxRecords`,
  `maxEventsPerExecution` and `maxLineBytes` bound the work. A bound that stops the run always returns `nextCursor`, an opaque
  position INSIDE the page (`lx1:` + the page's own cursor and how many of its executions are done), so a bound smaller than a page
  progresses instead of re-exporting the same rows forever (fix round 1; zero bounds are refused for the same reason). A source whose
  next cursor repeats or cycles is an error, not a loop. One record that cannot be built (nested past the canonical-JSON bound, a
  stack overflow) is skipped and counted under `skipped.recordError`; it does not abort the export. The preference index is capped
  (`maxPreferenceGroups`), is NOT carried across a resumed cursor (pairs form within one run) and a `maxRecords` cut during the pair
  phase is reported as `preferencesTruncated`.
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
- **Writes racing a hydration are not lost (fix round 1).** Every write is counted; a hydration whose snapshot may have missed one is
  redone, and if the key cannot settle it is left unhydrated so the next search rebuilds. A zero-vector embedding is skipped and
  counted (`skippedZeroVectors`), not a failure of every search on the key; the query is cut to `maxQueryChars` (8192) before the
  provider; `replace` on a hydrated key embeds only entries the index does not hold, or holds under different text (the index keeps a tag of each vector's text, so an id rewritten in place is re-embedded) (eviction rewrites a list through it); hashing of
  id-less entries is memoized per entry object. Each search still re-reads the key from the store - one pass - because that is what
  guarantees a hit is an entry the store still holds even after another writer removed it behind the wrapper.
- A hydration retry keeps the vectors it already computed (per text), so a sustained writer costs the new entries, not another pass over
  the corpus. The write counters also cover a write that begins AND ends inside the hydration's read (a test pins it).
- A real-model embedding client is a later plugin, not part of this ADR.

### D7 — An LLM eval harness in `tools/eval`

`runEvalSuite({ name, cases, subject, graders, passScore, concurrency, versions })` runs cases against a subject (a function; a
`flowSubject` over a runtime; a bare provider call) and returns an `EvalSuiteReport`: per-case status/score/grader outcomes,
summaries by tag and by grader, and the prompt/model versions it ran under. The report is a pure function of its inputs: no clock,
no random, results in case order whatever the concurrency; `reportDigest` is a stable hash and `compareReports` lists regressions
(score drop, flip to failing, vanished case). Errored cases score 0 and stay in the denominator.

- **Graders:** `exactMatch`, `regexMatch`, `jsonSchema` (a documented JSON Schema subset or any zod-style `safeParse` schema; an
  unsupported keyword FAILS rather than passing vacuously) and `llmJudge`. A grader that throws fails closed; a required grader
  failing fails the case whatever the weighted score; a grader weight must be finite and non-negative (a negative one inverts a
  grader); `jsonSchema` checks every array item and fails closed past 100,000.
- **The judge runs through the decide scope.** `judge: { decide, toolId }` calls `decide(key, scope => scope.invokeTransient(toolId,
  {prompt}))`, so the call is authorized as the deciding execution (ADR 0119), recorded in its log and served from it on replay:
  re-grading an old run never calls the model again. A plain `judge(prompt, request)` function is the offline form. The request is
  built with `guardRequest` (ADR 0085): the rubric is the system prompt (with the untrusted-content note) and the subject's output
  is a `tainted()` value in its OWN `user` message, which the guard fences and escapes against closing the fence from inside (a fixed
  `~~~~` delimiter, as in the first draft, let an output close it and plant its own verdict). The verdict must be a JSON object with a
  score in [0,1], else the case fails. Decision keys encode the grader name and case id, so none collide. Report tallies are built
  with `Object.fromEntries`, so a tag named `__proto__` is just a key.
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

### D10 — Review round 1 (Opus review of PR #522): what changed

P1: `rollback({ to })` could make a never-evaluated version live (D1). P2: the verdict was not bound to the report (D1: re-derived);
prototype-chain version names (D1); `taint: "mark"` emitted an overflowed scan unmarked, a shredded-then-compacted execution exported
its plaintext, and a resumed export could livelock (D5); a one-cluster bootstrap passed the CI gate (D4); an append could be lost to a
racing hydration (D6); the LLM judge's fence was forgeable, `__proto__` tags polluted the report and agent-loop versions were
unreadable (D3, D7). P3: canary fallback arm probability, resolver version mismatch, public canary salt, `sliceByVersion` key
collisions, per-record export errors, zero-vector/query-bound/replace costs in the embedding store, `jsonSchema` item bound, grader
weights, judge key collisions, lift row population, cassette replay never calling an inner provider. Round 2 (Sonnet re-review): per-call `thresholds` can only tighten the registry floor; `TrajectoryStep.refs` uses the nearest PRECEDING
response only (none when none precedes; linear); hydration retries do not re-embed; overflowed scans are skipped everywhere; a bare source
cursor that begins with `lx1:` is passed through unless it is exactly our `{c,s}` envelope (a source must not emit cursors that are
themselves valid envelopes). Note: `rollback` keeps the rollout `salt` (it is not reset), so the buckets of a later canary of the same
version are unchanged. Each has a failing-first test and
a revert-checked guard; the details are in D1 to D7 above.

Decisions taken in review: canary arms stay per-arm (no `Policy.probability`); every mode change needs a fresh gate over its report
(re-derived by the registry), with `ramp` exempt because it moves no version; examples recommend `minLiftLowerBound: 0` together with
the `minClusters` floor; a real-model embedding client is a later plugin.

### Follow-up — `select` and the registry read move inside the decider

Originally the registry read, the resolver and every `select` ran BEFORE `ctx.decide` (the kernel takes `DecideOptions` by value and
the stamp needs the acting policy's propensity), so on replay they ran and their answers were thrown away. That was wasted work and
a hazard for model-backed or side-effecting policies, and ADR 0080's "`select` must be cheap" was the only mitigation.

Now `decideWithPolicy` and `decideWithRollout` hand `ctx.decide` an options object whose `policy` stamp is set BY THE DECIDER, after
the registry read, the resolver and every `select` (acting and other arm) have run. This relies on a kernel property that already
held: `decideIn` reads `opts` when it commits `DECISION_RECORDED`, after the decider settled. A served decision returns before the
decider, so a replay reads no registry state, calls no resolver and no `select`; it serves the recorded choice, propensity and
`policy.rollout` (including the version that acted) unchanged. Consequences:

- **Records are byte-identical** for a live run: same choice, same stamp keys in the same order (a golden captured from the old
  code pins it, `recordGolden.test.ts`), so old logs, `trajectories`, `evaluatePolicy` and `sliceByVersion` read both alike. Nothing
  consumed the replay-time `select`: the only observers of a policy's behaviour are the recorded fields.
- **In-flight semantics.** The registry is now read after the kernel's replay lookup, cancellation and park checks, immediately
  before the record is committed, instead of before them; the window between read and record only got shorter. A `promote` or
  `rollback` landing between the read and the commit still loses to the record: the decision names the version that ACTED, which is
  the version read, exactly as before (the registry is read once per decision, never re-read at commit).
- A parked, cancelled or frozen scope that never runs the decider now never reads the registry either.
- `DecideCapable.decide` implementations that copy `opts` before the decider runs (a test double, a wrapper) would lose the stamp;
  copy lazily or pass the object through.

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

All four were decided in review round 1 (see D10): per-arm canary evaluation (no `Policy.probability`); a fresh registry-derived
gate per mode change, `ramp` exempt; examples recommend `minLiftLowerBound: 0` with the `minClusters` floor; a real-model embedding
client is a later plugin. None is open.
