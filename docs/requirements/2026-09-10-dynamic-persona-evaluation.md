# Dynamic Persona — placement evaluation

- Status: **Verdicts recorded. Net kernel change required: zero.** `KERNEL_ABI` unchanged
  (1.1.0); `EVENT_SCHEMA` unchanged (1.18.0). One gated 1P work item (W1), one deferral behind
  an evidence gate (W3), one documentation item (W2). Everything else is app code.
- Evaluates: [Project Dynamic Persona](2026-09-10-dynamic-persona.md) (**PdP**), an adaptive
  Operator Profile for the generative database-observability console.
- Decisions recorded in: [ADR 0092](../adr/0092-adaptive-operator-profiles-placement.md).
- **Follow-through (2026-09-10):** all three work items shipped. W2 with the ADR; W1's gate and W3's
  deferral were then lifted by decision and implemented —
  [ADR 0094](../adr/0094-blueprint-node-identity.md) and
  [ADR 0093](../adr/0093-read-model-row-purge.md). Nothing below is outstanding on loom; the
  remaining work is the app-side one this document places in the app.
- Method: the [ADR 0051](../adr/0051-perpetual-agents-placement-schedule-remodel.md) discipline —
  a placement verdict per requirement, judged against the best userland alternative, bias outward,
  [second-consumer rule](../adr/0083-second-consumer-rule.md) applied before anything becomes 1P
  surface. Every claim about the substrate was checked against the repo before judgment.

The paper is unusually well-shaped for this substrate and the top-line answer is short: **build it,
almost entirely in the app.** The value in what follows is elsewhere. §0 records that most of the
machinery the paper argues *against* is machinery loom does not ship — so several of its stated
reasons have no referent here — and §2 records four failure modes that are real in loom and that
the paper does not raise. One of them (§2.1) makes the design's central identity, `Profile(operator,
T) := fold(events ≤ T)`, non-replayable as specified.

---

## 0. Corrections — five assumed mechanisms that do not exist

The paper's §1.4 lists four disqualifying properties of a learned per-user profile, and §A.2
restates them as four mechanical failure modes. Three of the four describe machinery loom does not
have, and a fourth rests on a property of blueprint node ids that is false by default.

| # | Submitted | Repo record |
|---|---|---|
| **C1** | §1.4 #1 / §A.2 "cache key underspecification": the **derivation cache** maps request → blueprint address, and omitting the profile from the key silently serves a blueprint derived under a different profile. | **There is no derivation cache.** Nothing in `packages/llm`, `packages/intent` or `packages/planner` memoises a derivation; the only caching machinery in the repo is `plugins/content`'s `CachingContentStore`, over content blobs addressed by digest. The hazard is real *for a cache that is built later*, and the fix is one line in a key — but it cannot bear the weight §1.4 puts on it, and constraint **C5** ("cache key growth bounded by a constant") currently constrains nothing. Loom's actual mechanism for making a run's choices reproducible is `ctx.decide` → `DECISION_RECORDED` ([ADR 0030](../adr/0030-decision-materialization.md)): it does not make a second run cheaper, it makes the same run reproducible. Different property. |
| **C2** | §1.4 #2 / §A.2 "approval amortization": approval binds to a hash pair over blueprint and presubmit report, so profile cardinality scales human review cost — *"this alone disqualifies it independently of every other argument in this paper."* | **There is no artifact-approval binding.** "Approval" in loom is human-in-the-loop **resume** authentication: `usesApproval` in `packages/verify/src/rules.ts` requires a `ResumeAuthenticator` (K12) so a forged resume cannot be replayed as consent, and a verified one records a durable `APPROVAL_GRANTED` fact (`packages/app/src/defineConfig.ts`). `ApprovalCard` is a widget kind. Nothing hashes a generated artifact and binds a review to it. The argument the paper calls independently disqualifying has, in this substrate, nothing to attach to. |
| **C3** | §1.4 #3 / §A.2 "loss of compile-time specialization": a discrete enum can be enumerated and specialized by the compiler; a float vector defeats context-splitting. | **The compiler does no specialization.** `tools/compiler` performs `handler$` extraction, flow-graph analysis and resumability; a sweep for `specializ` / `context split` across `tools/` and `packages/` matches nothing. This argument is inert here. It may be a good reason to keep the input discrete in some *other* system; it is not a reason in this one. |
| **C4** | §5.3 / §A.4: the floor's primary function is **rebase safety** — *"operations are semantic mutations targeting stable node IDs, merged under rebase-before-promote."* | **No such merge policy exists.** Branching is real (`BranchRegistry`, the fork/simulate/promote pattern the `incident-war-room` and `schema-migration-planner` examples demonstrate), but there is no semantic-operation model and no rebase over node ids. The floor's *stated primary* justification has no referent; its secondary one — the capability trap — is the one that currently pays for it. This does not weaken the floor. It relocates the argument for it. |
| **C5** | §5.3: *"Node IDs are stable within a blueprint lineage."* | **False by default, and this is the one item that would silently break.** `packages/blueprint-runtime/src/widgets.ts` derives a widget's `id` from a 32-bit hash of `kind + props` when the caller supplies none, and says so in its own comment: *"it CHANGES when any prop changes… correct for a view that is authored once and wrong for one a composer revises."* Every builder accepts an explicit `id` precisely for this. So Tier 2's `ids(project(B, P)) = ids(B)` holds only if the projection never touches props (it needn't), and floor identity across cohorts holds only if **floor nodes carry explicit ids**. A cohort whose generator varies a floor node's title or density re-identifies the node, and the floor silently stops being a floor. See W1. |

**What survives.** The paper's conclusion — the profile input must be discrete, versioned and
citable — is right, and this evaluation endorses it. But in loom it is carried by **C2
(explicability)** plus the two mechanisms in §2.1 and §2.2, not by cache economics, approval
economics, or compiler specialization. A design defended by reasons that do not apply is a design
that will be re-litigated the first time someone checks.

---

## 1. What the substrate already provides

| PdP | loom today | Verdict |
|---|---|---|
| §A.3 profile as a projection over the log, not a store beside it | The right instinct, wrong mechanism — see §2.3. The mechanism that fits is `plugins/read-model` ([ADR 0058](../adr/0058-read-model-plugin.md)), whose contract is already the paper's: *"a read model is a CACHE of the log with a watermark, never an authority — drop it and rebuild by re-scanning."* | **app**, on 1P |
| §A.1 non-determinism captured at a boundary and journaled | `ctx.decide` — a kernel syscall since ABI 1.0.0; the decider runs once, the choice is committed as `DECISION_RECORDED`, and replay serves the recorded value without re-invoking | **none** |
| §3.1 evidence as immutable append-only references | Events are already addressed by `(executionId, sequence)`; `@loom/compliance`'s `SubjectIndex` answers "which executions touched this subject" | **app** |
| §3.1 closed, versioned flag catalogue | The app-supplies-the-vocabulary pattern, twice precedented: effect classes ([ADR 0084](../adr/0084-effect-classes-static-ceiling-k2-floor.md)) and blueprint conformance ([ADR 0088](../adr/0088-blueprint-conformance.md)) | **app** |
| §5.3 floor conformance as a checkable report | `validateBlueprint`'s shape is exactly right and was designed for this: findings, never a throw, plus a `widgets` denominator so a *rate* is computable and a caller can degrade and file a gap ([ADR 0088](../adr/0088-blueprint-conformance.md) D3) | **app**, reusing 1P |
| §3.3 hysteresis over evaluation windows | `sleep` / `sleepUntil` (ABI 1.1.0); the wake is a logged `TIMER_FIRED` fact | **app** |
| §7.2 canonical-mode entry signals | `@loom/live-query` ([ADR 0068](../adr/0068-projection-selector-subscription.md) for the change-only subscription) + `plugins/sentinel` | **app** |
| §6.2 exploration; §9.3 counter-metrics | `@loom/learning` — exploration in the routing seam ([ADR 0078](../adr/0078-exploration-in-the-routing-seam.md)), `(context, action, propensity)` on the decision record ([ADR 0079](../adr/0079-decision-context-and-policy.md)), SNIPS off-policy evaluation and a promotion gate ([ADR 0080](../adr/0080-learning-substrate.md)). See §2.5 | **app**, on 1P |
| §8.2 per-tenant profiles | `TenantScopedEventStore` | **none** |
| §8.1/§8.3 ingestion boundary, sensitive fields | `@loom/classify` + the `classification-reachability` verify rule | **app** |
| §8.4 deletion | `@loom/compliance` — `eraseSubject` (crypto-shred, liveness-gated: never shred a fold still in flight), `exportSubject` with `onShredded: "tolerate"`. See §2.4 | **app**, with W3 |
| §3.2 scoped preferences | `plugins/durable-state` ([ADR 0053](../adr/0053-durable-state-plugin.md)) — keyed CAS with a versioned contract and migrations. Better fit than `MemoryStore`, whose contract is an ordered list per key ([ADR 0090](../adr/0090-knowledge-is-retrieval-over-memory.md)) | **app** |

Phase 1 of the paper's delivery plan — the phase it expects to deliver most of the benefit —
requires **no loom change of any kind**.

---

## 2. Four failure modes the paper does not raise

### 2.1 Expiry makes the profile fold impure with respect to time

`Profile(operator, T) := fold(events(operator) where offset ≤ T)` is replayable only if the fold is
a function of the events **alone**. §3.1's expiry is not: `expires_at` is evaluated against
wall-clock now, and the paper explicitly prefers it to decay because *"expiry is a timestamp
comparison rather than a recomputation."*

That comparison is the defect. **Pinning a log offset does not pin the profile** — the same offset
yields a different flag set tomorrow, so the run-start pin of §A.3 buys none of the reproducibility
it is introduced to buy, and the failure is silent: nothing in a replay notices that a flag lapsed
between the original run and the replay.

The fix is loom-shaped and cheap: **a lapse is an event.** A scheduled evaluator emits the lapse
into the log (`sleepUntil` → `TIMER_FIRED` is the mechanism), and the fold becomes pure again. It
is also better product under C2: "lapsed on 4 September, because it was not re-evidenced for 90
days" is a citation with a timestamp, which is what §3.1 promises the operator; a read-time
comparison is a computation nobody can point at.

### 2.2 The journaled value cannot be an offset, because the fold is versioned code

§A.3's headline consequence — *"the journaled value is an integer… a single log offset"* — is not
sufficient here. A pinned offset reproduces the **events**; it does not reproduce the **fold**, and
the fold *is* the flag catalogue plus the cohort rules, both of which the paper versions and expects
to change under review.

Loom has already resolved this exact question in the opposite direction. `@loom/replay-inspector`
reconstructs a projection slice at event N, and when the projection's code is a superseded build
artifact it reports `status: "unavailable"` rather than running the current fold over an old log —
on the stated grounds that doing so "reproduces IX-5's forbidden silent fallback"
([ADR 0071](../adr/0071-read-only-replay-inspector.md)). A profile re-derived on replay under a
newer catalogue is that silent fallback, applied to the input that decides what a person sees.

Two acceptable repairs, and the second is better:

1. Journal `(offset, flagCatalogueVersion, cohortRuleVersion)` and refuse — loudly — to re-derive
   under a version the run was not pinned to.
2. **Journal the resolved profile summary itself** through `ctx.decide`: the cohort id, the flag
   set, and the catalogue version. It is small, discrete, versioned and citable — everything C1 asks
   for — it is served from the log on replay without re-deriving anything, and it is immune to fold
   drift by construction. It also collapses §A.2's "suspension drift" to nothing without a special
   rule: a recorded decision is served identically on resume, which is what the decision seam is.

This is a correction to §A.3, not a rejection of it. The profile is still a projection; what gets
journaled at the boundary is its *result*, not a pointer into the history it was derived from.

### 2.3 Profile-as-projection has no anchor, and no per-operator stream

Two structural facts:

- **Projection state is never persisted.** `@loom/replay-inspector` states it plainly: there is no
  snapshot anchor for projections — `Snapshot.state` is `ExecutionState`, projection state lives
  per-`(projectionId, executionId)` in the runtime and never crosses the SPI, so *every* projection
  fold starts from `initialState`. A profile spans an operator's lifetime, so a run-start re-fold is
  O(lifetime) with no anchor to shorten it.
- **There is no per-operator stream.** Loom's log is keyed by `executionId`. "The events of an
  operator" is not addressable; it is a *query across executions*.

Both are answered by the same 1P component: define the profile as a **read model**
([ADR 0058](../adr/0058-read-model-plugin.md)) whose `extract` pulls flag evidence out of ordinary
run logs, watermarked per execution, rebuilt by re-scan. That also makes §A.3's best property —
*"there is no write path from runs into profile state"* — **structurally true rather than a
discipline**: no run appends profile events at all; the read model observes.

### 2.4 Erasure does not reach derived rows

§8.4 promises that deletion returns the operator to the empty profile. In loom that promise has a
gap that is invisible from either side:

- `@loom/compliance` contains no reference to read models or projections. Erasure crypto-shreds the
  **log**.
- `ReadModelStore`'s only removal verb is `clear(modelId)` — the whole model. There is no
  row-granular purge, by design ("a cache, never an authority").

So a shredded subject's *derived* rows survive the shred with their extracted fields intact, and
they are the rows the console actually reads. The mechanism that closes it exists — `clear` +
rebuild, which after the shred yields no rows for that subject — but it is a whole-model rebuild per
erasure, and nothing today triggers it or bounds its cost. Two consequences to accept before Phase
2, not after:

1. The profile extractor **must tolerate shredded payloads** (`{ $shredded }`), or the rebuild
   throws on precisely the operator who exercised their deletion right. `exportSubject`'s
   `onShredded: "tolerate"` is the precedent to follow.
2. Erasure cost is O(log), not O(subject). See W3.

### 2.5 Exploration without a logged propensity is unevaluable

§6.2 records the outcome of an exploration ("whether or not it is used") but never the probability
with which the capability was surfaced. [ADR 0079](../adr/0079-decision-context-and-policy.md) is
categorical: a propensity cannot be reconstructed after the fact, and `evaluatePolicy` refuses a
value estimate without one, reporting `estimator: "agreement-only"`. §9's measurement plan is
therefore computable for the *rendering* comparison (where §9.5's free control arm genuinely works)
and **not** computable for the exploration arm, which is the only unconfounded signal the paper
identifies.

The mechanism is free: `ctx.decide`'s `policy: { id, version, propensity }`, populated by
`decideWithPolicy`. One further warning, from the same substrate: usable effective sample size
scales with **exploration volume**, not log duration. A small fixed fraction of sessions over a
quarter can produce too few counterfactual observations for the promotion gate to clear, and a gate
that fails for thin evidence reads exactly like a gate that failed because adaptation lost.

### 2.6 "Capability" is already taken

In this repo `capability` is an effect capability: a `packages/capability` package, the K2 grant
table, a `capability-compat` verify rule, and a maturity registry of the same name
([ADR 0035](../adr/0035-kernel-governance-layer.md)). PdP's "capability flag" and "capability floor"
are about UI affordances. Two unrelated senses of one word, both load-bearing, in one codebase, is a
collision that will produce a real misreading in a review. Rename the UI sense — *node floor*,
*affordance floor*.

---

## 3. Placement verdicts, by delivery phase

| Phase | Item | Placement |
|---|---|---|
| 0 | Baseline instrumentation | **app** |
| 1 | Scoped preference storage + recall | **app** on `plugins/durable-state`. No loom change |
| 2 | Flag catalogue, cohort rules | **app** (ADR 0084/0088 pattern) |
| 2 | Profile read model + extractor | **app** on `plugins/read-model` |
| 2 | Flag lapse as a scheduled event (§2.1) | **app** on `sleepUntil` |
| 2 | Journaled profile summary at run start (§2.2) | **app** on `ctx.decide` |
| 2 | `project(Blueprint, Profile)` + its invariants | **app**, promotable only under the second-consumer rule — see W1 |
| 2 | Ordering / disclosure overlay in the renderers | **rejected as a loom change** — see §5 |
| 2 | Exploration + propensity | **app** on `@loom/learning` |
| 3 | Cohort as a pinned generation input | **app**. The cache-degradation gate has no referent (C1); if a derivation cache is built, its key is `(intent, scope, cohort, cohortModelVersion, catalogueVersion)` |
| 4 | Learned cohort assignment | **3P** — a `Policy` implementation in `../loom-plugins`, exactly as `loom-plugin-linucb` is. Not a loom change |

---

## 4. Work items

**W1 — Floor-node identity (1P, gated).** Two parts. *(a)* A floor is only a floor if its nodes keep
their identity across cohorts, so floor nodes MUST carry explicit `id`s; the derived id in
`packages/blueprint-runtime/src/widgets.ts` is disqualified for this use (C5). *(b)* The check —
"these two blueprints name the same node ids" — is a pure function of the shape
`validateBlueprint`/`catalogCoverage` already established, and belongs beside them **iff** a second
consumer exists. The candidate is the a2ui revision path: `A2UISurfaceBridge` stamps a `catalogId`,
and a surface that is *revised* across turns needs stable node identity for the same reason a floor
does. **If that path stays unbuilt, W1(b) is app code and stays in the app** — the second-consumer
rule is not satisfied by one consumer plus a plausible one.
**Shipped** ([ADR 0094](../adr/0094-blueprint-node-identity.md)): the a2ui path was wired, so the
gate was met rather than waived — and the second consumer changed the API from blueprints to id sets.

**W2 — Document the identity hazard where a composer meets it (docs).** The comment in `widgets.ts`
is correct and is in the one place a runtime composer's author never looks. The blueprint-conformance
documentation should carry it: a model-composed blueprint that is ever revised must supply ids.
**Shipped**: [`docs/composed-surfaces.md`](../composed-surfaces.md) carries it, in both directions —
along one lineage (a revision re-identifies an edited node) and across compositions (two variants
meant to share a node agree only while their props stay byte-identical) — with `preservesNodes` /
`identityDiff` named as how you find out you got it wrong.

**W3 — Subject erasure must invalidate derived read models (1P, deferred behind evidence).** The
correctness fix is available today (`clear` + rebuild) and should be *documented as required* now.
A row-granular purge on `ReadModelStore` is the efficient fix and is **deferred**: reopen when a
measured rebuild cost at production log size exceeds the erasure SLA. Absent that number, the cheap
mechanism is sufficient and the SPI addition is unjustified.
**Shipped** ([ADR 0093](../adr/0093-read-model-row-purge.md)): the gate was lifted by decision, and
the measurement taken afterwards put the rebuild at 68× the cost of a purge for one subject.

---

## 5. What is *not* required, and why

- **No kernel change.** No syscall, no event type, no `EVENT_SCHEMA` bump. Every mechanism the paper
  needs at a boundary is `ctx.decide`, and every mechanism it needs over history is a projection or
  a read model.
- **No renderer overlay.** §5.1's ordering overlay reads as a renderer feature; it is not one.
  Reordering siblings does not touch props, so node ids survive it (C5), and disclosure state is
  expressible as a container in the app's own catalogue — which is where a runtime-composed
  vocabulary lives anyway ([ADR 0088](../adr/0088-blueprint-conformance.md) D2: loom checks the
  vocabulary it is given and does not define one). An overlay type in `@loom/blueprint-runtime`
  plus overlay support in both 1P renderers would be new 1P surface for a single consumer.
- **No new gap class.** See §6, Q7.
- **No evaluation of learned per-user profiles.** The paper rejects them and this evaluation agrees
  — on C2, and on §2.1–§2.2, not on C1/C5 or approval economics (see §0).

---

## 6. Answers to three of the paper's open questions

**Q4 — exploration budget.** Treat it as `@loom/learning` already does. Log `policy.propensity` at
the draw ([ADR 0079](../adr/0079-decision-context-and-policy.md)); evaluate with SNIPS and read the
reported effective sample size ([ADR 0080](../adr/0080-learning-substrate.md)). The budget is then
not a free parameter tuned against discovery rate alone — it is bounded below by the ESS the
promotion gate requires over the measurement window, which is a number the substrate reports rather
than a judgment call.

**Q7 — absence as a gap class.** No new class. `validateBlueprint` already returns findings with a
denominator ([ADR 0088](../adr/0088-blueprint-conformance.md) D3), which is precisely "make the
non-removal invariant observable through existing machinery": an above-floor capability the cohort
did not receive is a **finding on that report**, countable, rate-able, and renderable as "what you
are not being shown." The paper's own §12 constraint (rearrange, never withhold) then has a metric
instead of an assertion.

**Q8 — pinning granularity.** A mid-run refresh is a **typed resume gate**
([ADR 0077](../adr/0077-typed-resume-payloads.md)): `flow$({ resumeSchemas })` parses the payload
before the append, so the refresh is a first-class boundary with its own journal entry and its own
visible transition — exactly the shape §A.5 demands and refuses to accept as an implicit re-read.
One documented footgun applies: a `z.object` schema **strips unknown keys**, so the schema decides
what is persisted, not just what is accepted.

Under §2.2's recommendation (journal the resolved summary, not the offset) this question also
changes shape: there is no offset to hold stale, and a refresh is a new recorded decision at a named
gate.
