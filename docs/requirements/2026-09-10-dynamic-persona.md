# Project Dynamic Persona — adaptive operator profiles for generative database observability

- Provenance: **external submission**, recorded verbatim below from `# Abstract` onward.
  Submitted 2026-09-10 as a white paper ("Project Dynamic Persona (PdP)"); the runtime model
  it specifies is called the **Operator Profile**.
- Evaluated in: [the placement evaluation](2026-09-10-dynamic-persona-evaluation.md).
- Verdicts recorded in: [ADR 0092](../adr/0092-adaptive-operator-profiles-placement.md).
- Target workload: the generative database-observability console — the same product surface
  behind [the product portfolio evaluation](2026-09-01-product-portfolio-evaluation.md) §1 (CON)
  and the `db-observability` example.

The text below is the submission as received. Corrections to it are in the evaluation, not
here: this file is the record of what was submitted, and editing it would falsify that record.

---

# Abstract

A database observability console serves operators whose skills, responsibilities, and mental models differ by an order of magnitude, and it serves them all the same default surface. Runtime UI generation makes differentiated defaults tractable for the first time. It also makes them dangerous: an interface that composes itself per user is an interface that cannot be reproduced, audited, or referenced in a runbook.

This paper specifies an adaptation system that resolves that tension. The central claim is that the necessary signal is **discrete, observable, and citable** — not learned — and that adaptation belongs in two tightly bounded places: a coarse cohort input at generation time, and a pure projection over canonical structure at render time. Under this design the system's failure mode is a suboptimal arrangement rather than a missing capability, the control arm is free, the invariants are machine-checkable in presubmit, and the whole apparatus yields automatically when an incident begins.

A note on terminology. The project retains the name PdP, but the runtime model is called the **Operator Profile**. "Persona" is retired as a term of art: it denotes a synthesized character, and everything below is built from recorded fact.

# 1. The Problem

## 1.1 One surface, many operators

The same console is used by an application developer who wants to know why one endpoint got slow, an SRE holding a pager during a saturation event, a DBA planning a migration, and a data engineer checking whether last night's load landed. They arrive with different vocabularies, different permissions, different tolerance for density, and different definitions of what an answer looks like.

The failure is symmetric and both halves are expensive:

- The developer is shown replication lag, buffer cache hit ratios, and lock wait histograms, and cannot tell which of them bears on the question asked.
- The SRE is shown a friendly summary card and must navigate three levels down to reach the raw plan they wanted immediately.

Neither operator is served, and in the second case the cost is denominated in incident minutes.

## 1.2 Multi-engine compounds it

The portfolio spans relational, document, time-series, cache, and warehouse engines. An operator's competence is rarely uniform across them: fluency with Postgres query plans says little about competence reading a Redis keyspace eviction pattern. Adaptation must therefore be **scoped** — a single global skill level is the wrong shape for the problem, because it is wrong for most operators most of the time.

## 1.3 Why static personas do not address it

Conventional personas are a design-time artifact. They inform what gets built; they cannot inform what gets rendered, because they exist in documents rather than at runtime. They also encode role titles, and a title is a poor predictor of operational capability. Two engineers with identical titles differ more from each other than either differs from the median person one title away.

## 1.4 Why the obvious correction is worse

The natural engineering response is to learn a per-user representation: embed the operator, condition generation on the embedding, decay it over time.

It is worth first dismissing the objection that does *not* hold. A durable execution substrate does not require its inputs to be deterministic; it requires them to be **captured at a boundary and journaled**. A model call is non-deterministic and is made replayable by recording its result and reading the journal on re-execution. A profile read behaves identically. Replay determinism survives a learned representation, and content addressing survives it too: two profiles producing different blueprint content produce different addresses, which is content addressing working rather than failing.

The disqualifying properties are narrower and, being narrower, sharper.

1. **It underspecifies the cache key.** Content addressing answers "same content, same address." The derivation cache answers a different question — request to blueprint address — and if the request key omits the profile, the profile is a hidden input and the cache serves blueprints generated under a different one. This is a memoization hazard, not a determinism failure, and it fails silently.
2. **It destroys approval economics.** Approval binds to a hash pair over blueprint and presubmit report, so a different profile means an approval miss. Approval stays sound — nothing is ever inherited accidentally — but the human review cost scales with the cardinality of the profile input. At a per-user vector that is one review per operator, which is not a programme anyone will fund.
3. **It defeats compile-time specialization.** A discrete enum with a known domain can be enumerated and specialized by the compiler. A float vector is a runtime-opaque parameter over which context-splitting cannot reason, which removes the optimization on precisely the path where generation is most expensive.
4. **It cannot be explained.** An operations tool must be able to answer "why am I seeing this." No text log justifies a float, and no reviewer can determine whether a synthesis pass inferred a capability or invented one.

A fifth property is structural rather than mechanical and is developed in Appendix A: a learned profile is **ambient state that determines behaviour without appearing at a boundary**, and ambient behavioural composition is the failure mode the substrate is built to exclude.

The rest of this paper takes these properties as constraints rather than obstacles. They turn out to select a simpler system than the one they rule out.

# 2. Design Constraints

The following are binding. Each is falsifiable and each maps to a mechanism in §3–§7.

- **C1 — Identity preservation.** Anything entering blueprint generation must be discrete, versioned, and small enough to record in the event log alongside the blueprint hash.
- **C2 — Explicability.** Every adaptation must be traceable to a named signal, a timestamped event, and a rule. The operator must be able to read this in the product.
- **C3 — Non-obstruction.** The worst case must be a suboptimal arrangement, never an unreachable capability.
- **C4 — Yield under incident.** Adaptation is a steady-state convenience. During an incident the system must converge to a shared canonical reference frame.
- **C5 — Bounded fragmentation.** Cache key growth must be bounded by a constant chosen in advance, not by a population size.
- **C6 — Consent-bounded ingestion.** Only first-party product telemetry collected under existing product consent may enter the profile.
- **C7 — Correctability.** An operator's explicit statement about themselves outranks every inference the system makes, permanently.

# 3. The Operator Profile

The profile has three components with deliberately different epistemic status: recorded fact, stated preference, and derived summary. They are never blended into a single score.

## 3.1 Capability flags — recorded fact

A capability flag is a named boolean asserting that an operator has demonstrably performed something, scoped to an engine class.

``` text
CapabilityFlag {
  flag_id        : string        // e.g. "reads_query_plans"
  scope          : ScopeRef      // engine class, environment
  value          : boolean
  source         : observed | declared | granted
  evidence       : EventRef[]    // immutable, append-only log references
  first_observed : timestamp
  last_observed  : timestamp
  expires_at     : timestamp
  profile_version: uint64        // monotonic
}
```

Four properties matter.

**Evidence is mandatory.** A flag with `source = observed` and an empty evidence list is invalid and is rejected at write time. This is enforced by the schema, not by convention. It is what makes C2 achievable: the product can render the sentence "this is set because you ran a plan analysis on `orders-prod` on 4 August."

**Expiry replaces weighting.** Rather than a continuous time-decay function over a score, a flag simply has a horizon: it lapses if not re-evidenced. This is strictly more explicable — "this lapses in 12 days unless used again" is a sentence; "your weight decayed to 0.61" is not — and it is cheaper, because expiry is a timestamp comparison rather than a recomputation.

**Declared outranks observed.** An operator may set any flag directly. A declared flag never expires and is never overwritten by inference. This satisfies C7 and also produces the highest-quality signal in the system at no cost.

**Flags are scoped.** `reads_query_plans` on relational engines is independent of the same flag on time-series engines. This follows the existing scope model rather than introducing a parallel hierarchy.

The flag vocabulary is a closed, versioned catalogue — the same discipline applied to widgets, tools, and actions. Flags are added by review, not by synthesis. A system that can invent its own features about people is a system whose behaviour cannot be reviewed.

## 3.2 Preferences — stated choice

Preferences record what the operator explicitly chose, scoped by engine, environment, and resource: which layout they picked, which export action they last used, which panes they keep expanded, which density they selected.

There is no inference here at all. A preference is written when the operator acts and read when the surface is composed. It is a key-value store.

This component is unglamorous and is expected to deliver a large fraction of the total benefit. It should therefore ship first (§9), and its measured effect sets the bar that every later phase must clear.

## 3.3 Cohort — derived summary

A cohort is a small discrete label — on the order of four to eight values — assigned by **rule** over the flag set.

``` text
cohort "relational_deep" :=
    scope.engine_class = relational
  ∧ reads_query_plans
  ∧ (inspects_locks ∨ tunes_indexes)
  ∧ ¬declared_override
```

Rules rather than clustering, for three reasons. A rule is explicable to the operator whose interface it changed. A rule is reviewable before it ships rather than only observable after. And a rule is stable: it changes when the catalogue changes, under version control, rather than whenever a batch job reruns.

Clustering is deferred, not rejected. If rule-defined cohorts prove inadequate against measurement, an offline clustering pass over the flag bit-vector is the next step — but the burden of proof sits with the learned component, and it inherits the obligation to remain explicable.

**Hysteresis.** A cohort transition requires its predicate to hold across two consecutive evaluation windows. Each transition invalidates that operator's cached blueprints, so flapping has a direct and measurable cost. Transitions are logged, and the operator is told when one occurs.

# 4. Two-Tier Adaptation

Adaptation is split by where it can safely live. This is the central architectural decision in the paper.

``` text
Intent + Scope ──┐
                 ├──► COMPILER ──► Blueprint ──┐
Cohort (k≈6) ────┘   (content-addressed)       ├──► PROJECT ──► RenderPlan
                                               │
Flags + Prefs ─────────────────────────────────┘
     (continuous, render-time only)
```

## 4.1 Tier 1 — Cohort at generation time

The cohort identifier and the cohort model version are pinned inputs to blueprint generation and participate in blueprint identity. Both are small, discrete, and versioned, satisfying C1. Cache key growth is bounded by the cohort count, satisfying C5.

Replay is tractable because the artifact recorded alongside the blueprint hash is two integers — a cohort ID and a model version — rather than a snapshot of a mutable vector.

## 4.2 Tier 2 — Projection at render time

Flags and preferences never reach the compiler. They are applied afterwards as a pure function over an already-generated blueprint:

``` text
project : (Blueprint, Profile) → RenderPlan
```

Total, deterministic, side-effect free. Blueprint identity is untouched, which means the projection can be changed, disabled, or A/B tested without invalidating a single cached blueprint or approval artifact.

## 4.3 Why the split, concretely

Tier 1 answers *what could be shown*. Tier 2 answers *what is expanded by default*. The first requires generation and therefore costs tokens and identity surface; the second is free of both.

The rule of thumb: if an adaptation can be expressed as disclosure, ordering, or prominence, it belongs in Tier 2. Only adaptations that change the capability set justify Tier 1, and those are rarer than they first appear.

# 5. The Projection and Its Invariants

## 5.1 What the projection may do

- Set disclosure state — expanded or collapsed — on any container.
- Emit an ordering overlay over sibling nodes. The overlay is a separate artifact; blueprint ranks are not rewritten.
- Select the default tab or pane within a container.
- Promote an affordance from an overflow menu to primary position, or demote it.
- Choose among registered presentations of a polymorphic component.

## 5.2 What the projection may not do

It may not remove a node, and it may not make a node unreachable.

## 5.3 The composed guarantee

Two invariants, one per tier, compose into an end-to-end property.

**Tier 1 — the capability floor.** Every intent declares a floor: a set of capabilities that every cohort's blueprint must contain. Cohorts may *add* above the floor; they may never subtract below it. Floor conformance is asserted in presubmit.

The floor's more important function is **rebase safety**, and it is the reason the floor is a hard requirement rather than a usability convention. Operations are semantic mutations targeting stable node IDs, merged under rebase-before-promote. Node IDs are stable within a blueprint lineage but not across structurally different trees, so a cohort transition can otherwise leave an operator's recorded operations targeting nodes absent from their new base tree. Because floor nodes exist in every cohort's tree by construction, operations against them always rebase cleanly. Only operations targeting above-floor nodes can conflict, and that set is small, bounded, and known at compile time. See Appendix A.4.

**Tier 2 — node-set preservation.** For all blueprints `B` and profiles `P`:

``` text
nodes(project(B, P))    = nodes(B)              // nothing removed
ids(project(B, P))      = ids(B)                // identity stable
depth(project(B, P), n) ≤ 2  ∀ n ∈ nodes(B)     // ≤2 interactions to reach
project(B, ∅)           = canonical(B)          // empty profile ⇒ canonical
```

Composed: **no capability available to any operator is unreachable to any other operator within two interactions.** This closes the capability trap — the failure where a system withholds a tool from a novice, the novice therefore never uses it, and the absence of use is read as confirmation that they did not need it.

These are property tests, not documentation. They run on every projection change.

## 5.4 A consequence worth naming

The fourth identity above states that projecting under an empty profile yields the canonical view. Canonical mode is therefore not a second code path — it is the same function with the profile zeroed. It cannot drift from the adaptive path because it *is* the adaptive path. This makes both §7 and the control arm in §8 essentially free.

## 5.5 A note on token economics

Because cohorts add above a floor rather than subtracting from a ceiling, higher cohorts receive larger blueprints and lower cohorts smaller ones. Adaptation reduces generation cost for the majority of sessions rather than increasing it — the opposite of what a superset-and-hide design would produce.

# 6. Signal, Exploration, and Correction

## 6.1 What is observed

Only first-party product telemetry, under existing product consent: commands invoked, components interacted with, panes expanded, exports taken, resources touched, layouts chosen, escape-hatch usage.

Each observation that sets a flag writes an immutable evidence record. Evidence is append-only and referenced by ID; the profile stores pointers, never copies.

## 6.2 The exploration floor

A system that only observes what it has already surfaced learns nothing it does not already believe. A fixed fraction of steady-state sessions therefore surfaces exactly one capability above the operator's current assessed level, in an expanded state, and records the outcome whether or not it is used.

Three constraints on exploration:

- It is suppressed entirely in canonical mode (§7). An incident is not a place to run experiments.
- Exploration-surfaced usage is tagged distinctly in the evidence log. It is causally cleaner than unprompted usage — it is the only unconfounded signal the system has — but it must be distinguishable for analysis.
- Non-use is recorded as informative. An operator repeatedly declining a surfaced capability is evidence, and treating only positives as signal produces a monotonically inflating profile.

## 6.3 Correction

The profile is a product surface, not an internal structure. The operator can read every flag, read the evidence that set it, set or clear any flag directly, reset the profile, and export it.

Per C7, a declared flag is terminal: inference does not overwrite it. Operators correct their own profiles far more cheaply and accurately than a synthesis pass does, and a system that hides the profile forfeits that entirely.

## 6.4 The escape hatch

A persistent control that reveals the canonical view is available on every surface. Its usage rate is the cheapest and highest-quality corrective signal in the system: it directly measures how often adaptation was wrong.

# 7. Canonical Mode

## 7.1 Rationale

During an incident, several properties of the operational environment become load-bearing and all of them are hostile to personalization.

- **Shared reference frame.** Engineers on a bridge call refer to panels by name and position. Per-operator layouts break that reference.
- **Runbook coupling.** Runbooks name concrete surfaces. A system that decided this operator does not need a panel has broken a runbook step.
- **Handoff.** On-call handoff assumes continuity of view.
- **Novelty.** Adaptation is fitted to the routine. An incident is not routine, and the metric that explains an unusual outage is disproportionately likely to be one this operator does not usually look at.

## 7.2 Entry

Canonical mode engages on any of: an active incident record for the resource, an active page from the alerting integration, an anomaly detector firing on the resource, or multiple concurrent sessions on one resource inside a short window. It is also available manually at all times, from the escape hatch.

## 7.3 Behaviour

The profile is zeroed for the duration, which by §5.4 yields the canonical render plan through the ordinary path. Exploration is suppressed. Cohort remains pinned at its value on entry, so blueprints do not change identity mid-incident.

## 7.4 The transition must be visible

Silently rearranging an operator's console the moment an incident begins is the same failure this section exists to prevent, merely inverted. Entry into canonical mode is announced inline, is attributable to the signal that triggered it, and is reversible for the session by the operator, who may have better information than the detector.

# 8. Privacy and Governance

## 8.1 Ingestion boundary

Included: first-party product telemetry under existing product consent.

Excluded, by policy and enforced at the ingestion boundary rather than by convention:

- CRM records and account notes. These contain one person's characterisation of another. Altering an operator's interface based on a private commercial assessment of them is indefensible, and under C2 the citation would have to be shown to them.
- Research and discovery interview transcripts, which are collected under narrow purpose-limited consent that does not extend to production personalization.
- Support ticket contents.
- All demographic attributes, org-chart position, tenure, and seniority. Profile computation reads functional signals only. This is enforced by the closed flag catalogue: there is no flag such an attribute could set.

## 8.2 Tenant isolation

Cohort rules are global and reviewed. Profiles are per-operator *and* per-tenant: an operator working across two tenants holds two profiles. This prevents one organisation's operational posture from shaping another's defaults through a shared individual.

## 8.3 Sensitive fields

Sensitive-field classification is enforced before this system serves its first request, not retrofitted. Any signal that could carry a classified field into a rendering decision is a channel from confidential data to a visible surface, and the projection layer is the last place such a channel should be discovered.

## 8.4 Retention and deletion

Evidence records carry the retention class of the telemetry they derive from. Profile deletion propagates to evidence references and to cohort assignment. Deletion returns the operator to the empty profile, which by §5.4 is the canonical experience — deletion degrades personalization and never degrades function.

# 9. Measurement

## 9.1 Baseline is a prerequisite

No target is falsifiable without a baseline. A measurement-only phase precedes any adaptive behaviour and produces the observed distribution of every metric below with adaptation off. This phase is not overhead; it is what makes the program evaluable.

## 9.2 Primary metrics

- **Task success rate.** Requires an explicit success event — a mitigation applied, a query saved, a plan exported, an alert acknowledged and resolved. Speed without a success event cannot be distinguished from abandonment.
- **Time to success**, conditioned on success.

## 9.3 Counter-metrics

Every efficiency metric in this class improves when the system shows less. Each is therefore paired.

- **Capability discovery rate.** The fraction of operators invoking a given capability for the first time in a period. If efficiency rises while discovery falls, the system is failing and the primary metrics will not say so.
- **Escape-hatch rate.** Direct measurement of how often adaptation was wrong.
- **Canonical preference rate.** How often operators stay in canonical mode after an incident ends.
- **Cohort transition rate.** Flapping is a cost, not a signal of responsiveness.

## 9.4 Guardrail

**Incident time-to-mitigate**, segmented by adaptive versus canonical. This is a release gate, not a dashboard line. A regression here blocks, irrespective of primary metric movement.

## 9.5 Method

The control arm is free: by §5.4, running with an empty profile is the canonical experience through the identical code path. A holdout requires no separate build, no divergent implementation, and no risk that the control differs from production in some way other than the variable under test.

# 10. Delivery

**Phase 0 — Baseline.** Instrument task success, time-to-success, discovery, escape-hatch usage, and incident time-to-mitigate. No adaptation. Produces the distribution against which all later claims are tested.

**Phase 1 — Preferences.** Scoped preference storage and recall (§3.2). No inference, no cohorts, no projection logic beyond replaying stated choices. Measure against Phase 0. This phase is expected to capture a large share of the available benefit, and its result determines whether later phases are warranted.

**Phase 2 — Flags and projection.** Closed flag catalogue with evidence and expiry. Render-time projection with invariants enforced in presubmit. Exploration floor, escape hatch, canonical mode, and the operator-facing profile surface. Still no cohorts, so blueprint identity is entirely untouched through this phase.

**Phase 3 — Cohorts.** Rule-defined cohorts as a pinned generation input, with capability floors and hysteresis. **Gated on** a cache-degradation analysis at `k ∈ {4, 6, 12}` against the production intent distribution showing acceptable cost, and on Phases 1–2 having produced an effect large enough to justify touching blueprint identity at all.

**Phase 4 — Reassess.** Only here does clustering become a live question, and only if rule-defined cohorts have demonstrably failed against measurement.

Note the sequencing property: Phases 0–2 do not modify the compiler, the blueprint, or the cache. The first three phases are reversible.

# 11. Worked Example

Intent: *"why is my query slow"* against a relational production instance. Two operators, same resource, same minute.

**Operator A** — cohort `relational_shallow`. Flags: `runs_queries`, `reads_error_messages`. Preference: table density compact.

**Operator B** — cohort `relational_deep`. Flags: `runs_queries`, `reads_query_plans`, `tunes_indexes`, `inspects_locks`. Preference: raw plan output, last export action was `copy_as_json`.

**Tier 1.** Both blueprints contain the intent's capability floor: latency summary, the plan node, the lock view, and the index advisor. B's blueprint additionally contains a plan-node cost breakdown and a lock-wait chain visualiser, which sit above the floor. A's blueprint is smaller and cheaper to generate.

**Tier 2.** A's projection expands the latency summary and collapses the plan node behind one interaction. B's projection expands the plan node in raw form, orders the lock view second, and promotes `copy_as_json` to a primary affordance.

**The guarantee.** A can reach the plan node and the index advisor in one interaction. Nothing in the floor is absent from either surface. If A opens the plan node three times over a fortnight, `reads_query_plans` is set with evidence, and at the next evaluation window A's cohort predicate holds; after a second consecutive window A transitions, is notified, and the blueprint identity for their future sessions changes once, deliberately, and with an audit record.

**Under incident.** A page fires on the instance. Both operators are announced into canonical mode, both see the same layout in the same order, exploration is suppressed, and the runbook step that says to check the lock-wait chain refers to something both of them can see in the same place.

# 12. What This Project Is Not Building

Stated explicitly, because each was considered and rejected on the record.

- **Learned per-user embeddings.** They break identity, collapse the cache, and cannot satisfy C2. Discrete flags do the same work and can be cited.
- **Capability gating.** No adaptation removes a capability. The system may rearrange; it may not withhold.
- **Demographic or role-title inference.** No flag in the catalogue can encode one.
- **Cross-tenant profile synthesis.** Isolation is enforced at the synthesis boundary, not the serving boundary.
- **Synthetic persona validation.** Language models conditioned on persona descriptions do not reproduce the response distributions of the populations they describe; they collapse toward modal answers and are systematically agreeable, which suppresses precisely the objections such an exercise is meant to surface. Synthetic operators may generate candidate objections to test with humans. They validate nothing.
- **Simulated willingness to pay.** A plausible-sounding number generated by a text model, whose principal effect in a review is to be mistaken for evidence.
- **Ingestion of CRM, transcript, or support corpora.** See §8.1.

# 13. Open Questions

1. **Floor granularity.** Capability floors are defined per intent. Whether that is the right granularity — as against per intent-family or per scope — is unresolved and should be settled empirically in Phase 2, when floors first have to be written at volume.
2. **Reachability bound.** The depth bound of two interactions is asserted, not derived. It is testable: if escape-hatch usage concentrates on capabilities sitting exactly at depth two, the bound is wrong.
3. **Expiry horizons.** Flag horizons are currently a per-flag constant in the catalogue. Whether they should vary by engine class or by observed re-acquisition cost is open.
4. **Exploration budget.** The fraction is a free parameter with no principled value yet. Phase 2 should treat it as a tuned quantity with discovery rate as the objective and escape-hatch rate as the constraint.
5. **Cohort count.** `k` is bounded above by cache economics and below by expressiveness. The Phase 3 gate analysis determines the ceiling; the floor is a design question not yet answered.
6. **Multi-operator sessions.** Canonical mode handles the incident case. Whether non-incident shared sessions — pairing, review, demos — warrant the same treatment is unresolved.
7. **Absence as a gap class.** Whether an above-floor capability withheld from a cohort should be modelled as a gap rather than plain absence, making the non-removal invariant observable through existing machinery. See Appendix A.5.
8. **Pinning granularity.** Whether run-scoped pinning of the profile log offset remains correct for long-lived runs, or whether a controlled mid-run refresh at an explicit boundary is preferable. See Appendix A.5.

# Appendix A — Determinism, Journaling, and the Profile as Log Projection

This appendix states precisely how the Operator Profile interacts with the execution substrate. It exists because the informal objection to persona-driven generation — "mutable input, therefore broken replay" — is false, and accepting it uncritically leads to a design that solves the wrong problem.

## A.1 What the substrate actually requires

The engine does not require deterministic inputs. It requires that non-determinism be **captured at a boundary and journaled**. A model call is non-deterministic; wrapping it makes it replayable because re-execution reads the recorded result rather than re-invoking. A profile read is no different in kind.

Two properties therefore survive a mutable profile, contrary to the informal objection:

- **Replay.** A journaled profile read replays from the journal. Reconstruction does not require re-deriving the profile.
- **Content addressing.** The address is a function of blueprint content. Two profiles yielding different content yield different addresses. That is the mechanism behaving correctly.

Stating this plainly matters, because the remaining failure modes are real and are obscured by an objection that over-claims.

## A.2 The four mechanical failure modes

**Cache key underspecification.** Content addressing and the derivation cache answer different questions. The first: same content, same address. The second: this request maps to which address. If the profile is absent from the request key, it is a hidden input and the cache returns a blueprint derived under a different profile. The defect is at the cache layer, is a correctness defect rather than a performance one, and is silent.

**Approval amortization.** A distinct profile yields a distinct hash pair and therefore an approval miss. Approval remains sound; what degrades is economics, linearly in the cardinality of the profile input. A bounded cohort count keeps review cost bounded. A per-user vector does not, and this alone disqualifies it independently of every other argument in this paper.

**Suspension drift.** A run suspends at a UI boundary and resumes on interaction, possibly much later. If the profile is re-read on resume, every resume point becomes a fresh non-deterministic input requiring its own journal entry, and the console visibly rearranges itself mid-task. Only holding the value from run start is defensible, and §A.3 makes that structural rather than incidental.

**Loss of compile-time specialization.** The compiler can enumerate and specialize over a small discrete domain. It cannot reason about a runtime-opaque float vector, which forfeits context-splitting on the most expensive generation paths. This is an argument for discreteness independent of both cache and approval.

## A.3 The resolution: profile as projection, not store

The profile schema in §3.1 already specifies evidence as references into the append-only log rather than copies. Taking that further than a storage convention yields the design commitment:

``` text
Profile(operator, T) := fold(events(operator) where offset ≤ T)
```

**The Operator Profile is a projection over the event log, not a mutable store beside it.** The consequences are disproportionate to the size of the change.

- **The journaled value is an integer.** Not a vector snapshot, not a profile blob — a single log offset, pinned at run start. This is what makes profile input cheap to record at a boundary and cheap to record alongside a blueprint hash.
- **Retention is already solved.** No profile history is stored. Reconstruction replays the projection to the pinned offset, against a log that is already the source of truth and already retained under an existing policy. The retention obligation that a vector snapshot would create simply does not arise.
- **Provenance becomes structural.** A flag cannot exist without the events that produced it, because it is derived from them. The evidence requirement in §3.1 stops being a schema constraint that a write path might circumvent and becomes a property of the representation.
- **There is no write path from runs into profile state.** Flags are set by the projection observing the log, never by an effect inside a run. Replaying a run therefore cannot mutate a profile, which removes an entire class of replay-safety hazard before it can be introduced.
- **Suspension drift disappears by construction.** The offset is pinned at run start and held for the run's life; profile changes land on the next run.

## A.4 The structural diagnosis

The four mechanical failures share one shape. A learned profile is **ambient state that determines behaviour without appearing at a boundary** — behaviour composed at runtime in a way the log cannot reconstruct.

This is the same structural error as behavioural mixins, which are excluded from the substrate for exactly this reason. Persona-as-ambient-context is that error in a different costume, and it takes the same remedy: make the thing an explicit, typed, journaled value at a boundary. Under §A.3 that value is a log offset, and the cohort identifier of §4.1 is its discrete compile-time companion.

This also supplies the correct justification for the capability floor (§5.3). The floor was introduced as an anti-capability-trap device, which is true but secondary. Its primary function is guaranteeing that operations survive cohort transitions: floor nodes are present in every cohort's tree by construction, so operations targeting them always rebase cleanly, and the conflict surface is confined to the above-floor set — small, bounded, and enumerable at compile time. Without floors, a background cohort reassignment can invalidate an operator's recorded operations through no action of their own, producing a conflict class the merge policy does not currently contemplate.

## A.5 Unresolved

1. **Absence as gap.** An above-floor capability that a cohort does not receive is currently modelled as plain absence. Modelling it instead as a gap would make the non-removal invariant observable through existing machinery rather than merely asserted in presubmit, and would give the render layer a principled affordance for surfacing what an operator is not being shown. Whether this warrants a new gap class is open.
2. **Pinning granularity.** Run-scoped pinning is correct for interactive runs. For long-lived runs it may be worse: holding a months-old offset can be more surprising than a controlled refresh at an explicit boundary. If a mid-run refresh is warranted it must be a first-class boundary with its own journal entry and its own visible transition, never an implicit re-read.
