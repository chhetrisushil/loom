# Loom Platform Requirements — Ambient Personal Execution Companion

- Submitted: 2026-08-12. Derived from Companion PRD v1.0 (KP-1…KP-8).
- Status: **As submitted.** Verdicts, corrections and revised layer assignments are in the
  [evaluation](2026-08-12-companion-platform-evaluation.md); this file is the unmodified
  proposal it judges.
- Source: the Companion PRD ("Ambient Personal Execution Companion", Product, v1.0) is a
  *product* document for a separate product and is not captured here. Its §15 KP-1…KP-8 are
  the loom-facing extract, reproduced in the traceability appendix below.
- Converted from org-mode to Markdown for directory consistency; content is verbatim.

---

## 0. Purpose and scope

### 0.1 Purpose

The Companion PRD v1.0 states product requirements. This document states the *platform*
requirements those imply, classifies each by the layer that must change, and records which
candidate kernel promotions are *rejected* and why.

The governing question throughout is not "can Loom do this?" but "at which layer does this
belong, and what is the smallest change that satisfies it?" A requirement satisfiable at the
application layer that is instead solved in the kernel is a defect, not a convenience.

### 0.2 Scope

In scope: event log semantics, ingest tiering, projection determinism, replay surfaces,
suspension lifetime, effect-class declaration and validation, runtime blueprint synthesis,
policy state, execution host topology.

Out of scope: companion product behaviour (see Companion PRD), UI specification, the
observation collector's macOS implementation.

### 0.3 Conventions

Each requirement carries:

- a stable ID (`EL-3`, `PJ-7`) — never reused, never renumbered;
- a *strength*: MUST / SHOULD / MAY;
- a *layer*: the shallowest layer at which it can be satisfied;
- where testable, an *Accept:* line.

Layer values, shallowest first:

| Layer | Meaning |
|---|---|
| none | Already satisfied by existing primitives; no change |
| app | Application or SDK layer, above the framework |
| stdlib | Loom standard library |
| compiler | Compile-time validation or transformation |
| spi | Engine SPI, affecting all engine implementations |
| kernel | Kernel primitive, log semantics, or replay semantics |

A requirement whose layer is `kernel` requires an explicit promotion argument. Absent one, it
is a design error.

### 0.4 Relationship to prior work

This document reuses rather than re-proposes: the DE series (GenUI kernel, compiler, SPI and
stdlib work), the RC series (`rotate$` and run chaining), the TS series (telemetry substrate
split, result-by-reference logging, content-addressed evidence), and the IX series (read-only
replay inspector). The three previously deferred kernel promotions — declarative rotation
policies, checkpoint replay barriers, external-wait transfer — are revisited in §11 in light of
this workload.

---

## 1. Disposition summary

The headline: this workload requires *no new kernel entry kinds and no new primitive*. Two
kernel changes are proposed, both narrow. Most of the surface lands at the application and
compiler layers.

| Series | Concern | Deepest layer required | Verdict |
|---|---|---|---|
| EL | Event log & entry kinds | app | Domain event types are payload discriminators, not kinds |
| IN | High-volume observation ingest | spi | Second write path and retention tier; shared semantics |
| PJ | Deterministic projections & mining | app | Expressible today; needs discipline, not primitives |
| RP | Replay as a user-facing surface | app + IX | Promotes IX from internal tool to product surface |
| SU | Very-long-lived suspensions | kernel | *Promotion 1* — run-lifetime bounding |
| EF | Effect-class declaration & enforcement | compiler | Extends DE-9 clearance machinery; no new log semantics |
| BP | Runtime blueprint synthesis | app + stdlib | Stress test of the closed vocabulary, not a change to it |
| PO | Policy state & off-policy evaluation | kernel (conditional) | *Promotion 2, conditional* — substitutive replay mode |
| HO | Local execution host topology | spi | Satellite topology, not a new runtime target |

---

## 2. EL — Event log and entry kinds

### 2.1 The layering

Three distinct things are routinely conflated. This series exists to keep them apart.

| Level | Name | Interpreted by | Openness |
|---|---|---|---|
| L1 | Kernel entry kind | Kernel; replay depends on it | *Closed, versioned* |
| L2 | Domain event type | Application projections | Open, string-named, Zod-contracted |
| L3 | Observation record | Ingest tier; projections | Open |

**EL-1** MUST — layer `kernel` — The kernel entry-kind set remains *closed and versioned*. No
workload, including this one, may introduce a new entry kind without a written promotion
argument accepted against §11's criteria.
- *Rationale:* an open kind set means every replayer, inspector and projection must tolerate
  kinds it does not recognise. The IX series' safety argument rests on the kind set being
  enumerable; opening it silently retracts that argument.

**EL-2** MUST — layer `app` — Domain event types (`activity.observed`,
`workflow.context_switch`, `automation.proposed`) are *payload discriminators carried by
existing entry kinds*. The kernel does not read, index on, or branch on them.
- *Accept:* Adding a new domain event type requires no change to any file under the kernel or SPI.

**EL-3** MUST — layer `app` — Every domain event type has a registered Zod contract and a
version. An unregistered type fails validation at write time, not at read time.
- *Accept:* Writing an event whose `type` has no registered contract raises at the write call site.

**EL-4** MUST — layer `app` — Domain event contracts are versioned and evolve under the same
compatibility rules as `$`-boundary state contracts. A projection written against v1 of a type
continues to function when v2 is introduced.

**EL-5** SHOULD — layer `spi` — Provide a discriminator index over the domain `type` field so
projections can filter without deserialising every payload.
- *Rationale:* an indexing concern over one kind, not a reason to create kinds.

### 2.2 The observation/conclusion rule

**EL-6** MUST — layer `app` — Only *observations* and *decisions* are written to the log.
*Conclusions* are projected.

A record is loggable iff it captures something that occurred outside the projection that would
compute it. If re-running a projection would recompute the record, it is not an event.

| Record | Class | Disposition |
|---|---|---|
| User focused app X at time T | Observation | Logged |
| Randomisation draw was *explore* | Decision | Logged |
| User approved automation A | Decision | Logged |
| User manually ran signature S again | Observation | Logged |
| Signature S is a candidate | Conclusion | Projected |
| Automation A was not adopted | Conclusion | Projected |
| Episode #812 spans 09:12–09:34 | Conclusion | Projected |
| Inefficiency detected, cost 27 min | Conclusion | Projected |

- *Rationale:* the Companion PRD requires mining be a pure replayable projection (SG-5). If a
  projection's output is also written back as a durable entry, the log can disagree with what
  re-running the projection yields, and replay diverges *silently*. This is the specific failure
  mode that motivated distinguishing event-log replay from plan memoisation in the AetherOS review.

**EL-7** MUST — layer `compiler` — Reject at compile time any write of a domain event type
registered as `projected` rather than `observed` or `decided`. The observation/conclusion
distinction is a declared property of the type, enforced mechanically.
- *Accept:* An attempt to write a `projected`-classed type fails the build with a message naming
  the type and the rule.

**EL-8** MUST NOT — layer `app` — Derived confidence scores, inferred labels, and model outputs
are never written as observations. Where a model output must persist (e.g. an expensive
classification worth caching), it persists as a *memoised projection artifact* keyed by input
content hash and projection version, in the TS-series content-addressed evidence store — not in
the event log.

---

## 3. IN — High-volume observation ingest

**IN-1** MUST — layer `spi` — Provide a second write path for observation-tier records with the
same envelope shape, ordering guarantees, and content-addressed payload references as run
events, but a distinct storage and retention tier.
- *Rationale:* the observation stream is orders of magnitude higher volume than agentic run
  events. Pushing T0 records through the run-event path degrades the run path's write latency
  and pollutes its retention economics. This is the same physical-isolation argument made for
  telemetry in the AetherOS review, and it applies here for the same reason.

**IN-2** MUST — layer `spi` — Observation-tier records are readable by projections under the
same ordering semantics as run events, so a projection may join across tiers.
- *Accept:* A projection reading both tiers over a window observes a single total order
  consistent with wall-clock arrival.

**IN-3** MUST — layer `spi` — Independent, declaratively configured retention per tier.
Observation tier defaults to a bounded TTL; run tier is unbounded.
- *Note:* this is adjacent to the deferred *declarative rotation policies* promotion. See §11.1.

**IN-4** MUST — layer `app` — Ingest is lossy under back-pressure, and drops are recorded as
explicit *gap records* in-stream. A projection must be able to distinguish "nothing happened"
from "we were not looking."
- *Accept:* Induce back-pressure; the resulting projection reports a gap interval rather than an
  inferred idle interval.

**IN-5** MUST — layer `app` — Sensitive-field classification runs *before* the ingest write, not
after. A dropped field never has a log representation at any tier.
- *Rationale:* redaction after write leaves a window and a backup. Companion PV-1 requires
  drop-at-capture.

**IN-6** SHOULD — layer `spi` — Observation-tier writes are batched and asynchronous, and never
block a foreground caller.

---

## 4. PJ — Projections and deterministic mining

**PJ-1** MUST — layer `app` — Episode construction and signature mining are expressed as *pure
projections* over a pinned log window. Given the same window and the same projection version,
output is byte-identical.
- *Accept:* Two runs of the miner over an identical window produce identical candidate sets in
  identical rank order, verified by output hash.

**PJ-2** MUST — layer `app` — Every projection declares a *projection descriptor*: projection
identity, version, parameter set, and input window bounds. The descriptor is content-addressed;
its hash identifies the run.
- *Rationale:* Companion EP-3 requires that changing boundary parameters produce a new projection
  version with prior candidates still attributable to the parameters that produced them. The
  descriptor hash is that attribution.

**PJ-3** MUST — layer `app` — A candidate references the descriptor hash that produced it and
the specific record ranges that support it. This is the substrate for Companion PR-5's
replay-backed explanation.

**PJ-4** MUST NOT — layer `app` — A projection may not read wall-clock time, random values,
network state, or any input not derivable from its declared window. Determinism is a property of
the projection, not an aspiration.
- *Accept:* Projections execute under a harness that traps non-declared inputs; violations fail
  the test suite.

**PJ-5** SHOULD — layer `app` — Expensive projection stages memoise on `(descriptor hash, input
content hash)` into the TS-series evidence store. Memoisation is a cache and must never be
load-bearing: purging it changes cost, never output.
- *Accept:* Purge the memo store; re-running produces identical output.

**PJ-6** MUST — layer `app` — Projections are *not* runs. They do not consume run identity, do
not emit run events, and do not participate in suspension. A projection that needs to suspend is
misfactored.

**PJ-7** SHOULD — layer `stdlib` — Provide a projection harness in stdlib covering descriptor
construction, window pinning, determinism trapping, and memoisation, so each projection does not
re-implement these.

---

## 5. RP — Replay as a user-facing surface

**RP-1** MUST — layer `app` — "Why did you suggest this?" resolves to a read-only replay of the
projection that produced the candidate, over the exact pinned window, using the IX-series
inspector.
- *Rationale:* the IX series was scoped as an internal read-only inspector requiring no new
  kernel primitive, vocabulary, or log entry kind. This requirement *promotes it to a shipped
  product surface* without changing that scoping. The constraint that made it safe internally is
  what makes it shippable externally.

**RP-2** MUST — layer `app` — The user-facing replay surface enforces the same sensitive-field
policy as capture. A field dropped at capture cannot appear in replay; a field visible only
under a clearance grant is masked without it.

**RP-3** MUST — layer `app` — Replay is read-only. The surface exposes no mutation path, no
re-execution, and no parameter override.

**RP-4** SHOULD — layer `app` — Replay renders through the GenUI blueprint path so that the
explanation surface and the proposal surface share a vocabulary and a sensitive-field presubmit
report.

**RP-5** MUST NOT — layer `kernel` — Do not introduce a new log entry kind, a new vocabulary
term, or a new primitive to serve replay presentation. If a presentation need appears to require
one, the need is a projection concern.

---

## 6. SU — Suspension lifetime

**SU-1** MUST — layer `kernel` — Support run suspensions whose pending duration is *unbounded in
practice* — weeks to months — without degrading engine performance, without periodic wake-ups,
and without the run being reaped by any lifetime policy.
- *Rationale:* Companion EX-2 makes indefinite suspension a normal state. A judgement-bearing
  automation waiting six weeks for a human decision is correct behaviour, not a stuck run.

**SU-2** MUST — layer `spi` — Suspended runs impose storage cost proportional to suspended-state
size and *zero* ongoing compute cost. Polling a suspended run is prohibited.
- *Accept:* 10,000 runs suspended for 30 simulated days consume no measurable CPU.

**SU-3** MUST — layer `kernel` — Distinguish *pending* from *abandoned* as first-class states. A
pending run awaits an event that may still arrive; an abandoned run has been superseded.
Abandonment is an explicit transition, never a timeout side-effect.

**SU-4** MUST — layer `app` — Long-suspended runs survive automation deactivation, effect-class
change, and application upgrade. On resume, the run re-validates its effect class and
verification predicate against current policy before proceeding.
- *Rationale:* a run suspended before a policy tightened must not resume under the looser policy
  it was created under.

**SU-5** SHOULD — layer `kernel` — Interaction with RC-series `rotate$` and run chaining is
specified: a suspension outliving a rotation boundary must be explicitly either carried or
abandoned, never implicitly dropped.

### Promotion argument (SU-1, SU-3)

Existing suspension is first-class but scoped to agentic runs on human or system timescales of
minutes to days. This workload requires months, at a run count proportional to active
automations rather than active sessions. The change is to *lifetime bounding and reaping
policy*, not to the suspension primitive itself — narrow, and confined to a policy the kernel
already owns. Accepted as *Promotion 1*.

---

## 7. EF — Effect classes and validation

**EF-1** MUST — layer `compiler` — Every compiled automation flow declares an *effect class*:
`read-only`, `local-write`, `external-write`, or `irreversible`. The declaration is part of the
flow's compiled identity.

**EF-2** MUST — layer `compiler` — Compilation fails when the union of a flow's reachable
operations exceeds its declared class. Validation is static and whole-flow, not per-call.
- *Accept:* A flow declaring `read-only` that transitively reaches an external write fails to
  compile, naming the offending path.

**EF-3** MUST — layer `compiler` — Effect class composes conservatively: a flow's effective
class is the maximum over its own operations and every flow it calls. No call boundary launders
an effect.

**EF-4** MUST — layer `compiler` — Every automation declares a *verification predicate*. A flow
without one fails compilation.
- *Rationale:* the predicate is what makes VRM computable and what gives the learning policy a
  reward signal. An automation that cannot be verified cannot be measured, and is therefore not
  shippable.

**EF-5** MUST NOT — layer `compiler` — No runtime mechanism, including any learned policy, may
alter a flow's declared effect class, its verification predicate, or its sensitive-field
clearance. These are compile-time constants.
- *Accept:* An audit query over the log shows zero effect-class transitions not accompanied by a
  recompilation and a fresh human approval.

**EF-6** MUST — layer `compiler` — Effect-class validation composes with the DE-9
sensitive-field clearance mechanism and shares its presubmit report. Approval binds to the pair
`(blueprint hash, presubmit report hash)`, as established in the DE series.

**EF-7** MUST — layer `app` — Effect class determines execution friction (confirmation policy).
The mapping from class to friction is application policy; the class itself is a compiled
property.

### Note on layer

EF is *compiler*, not kernel. It extends existing DE-series presubmit validation with a second
declared property. No log semantics change; no new entry kind; no new primitive.

---

## 8. BP — Runtime blueprint synthesis

**BP-1** MUST — layer `app` — Proposal review surfaces are synthesised per candidate as GenUI
blueprints against the *existing closed versioned component vocabulary*.

**BP-2** MUST NOT — layer `stdlib` — Do not open the component vocabulary to accommodate
machine-generated blueprints. If synthesis cannot express a needed surface, that is evidence
about vocabulary coverage, to be handled by a deliberate versioned vocabulary addition — not by
relaxing closure.
- *Rationale:* closure is what makes blueprints validatable, content-addressable and approvable.
  A machine-generated blueprint is exactly the case where closure matters most, because no human
  reviewed the component choice.

**BP-3** MUST — layer `app` — Synthesised blueprints obey the full DE-series regime: stable node
IDs, fractional sibling ordering, content-addressed hashing, semantic mutation operations for
user edits, and rebase-before-promote when a candidate is re-mined while a proposal is open.

**BP-4** MUST — layer `app` — User edits to a proposed automation (Companion PR-3) are semantic
mutations against the blueprint, producing a new content hash. The approval binds to the
*edited* hash.

**BP-5** MUST — layer `app` — Synthesised blueprints run the sensitive-field presubmit check
before display. Machine generation is not a reason to weaken the check; it is a reason to
strengthen it.

**BP-6** SHOULD — layer `app` — Instrument blueprint synthesis validation-failure rate as a
first-class metric. Companion KC-2.2 gates on ≥ 95% first-attempt validation; sustained failure
below that is a vocabulary-coverage signal, not a prompt-tuning signal.

---

## 9. PO — Policy state and off-policy evaluation

**PO-1** MUST — layer `app` — The interruption policy is expressed as a `guard$` whose decision
inputs are drawn only from the log.

**PO-2** MUST — layer `app` — Bandit posteriors are *projections* over recorded decisions and
outcomes, not durable mutable state. Posterior state is recomputable from the log at any time.
- *Rationale:* holding posteriors as mutable run state makes them a second source of truth that
  can diverge from the log. Recomputability is what makes PO-4 possible.
- *Accept:* Discarding all posterior state and recomputing from the log yields identical policy
  behaviour.

**PO-3** MUST — layer `app` — Every policy decision writes `(context vector, randomisation draw,
action taken, channel)` as a *decision* record per EL-6. The draw is a nondeterministic value
consumed by orchestration and is recorded through the existing determinism boundary — no new
mechanism.

**PO-4** MUST — layer `app` — *Scoring* off-policy evaluation: a candidate policy is evaluated
against recorded trajectories by importance-weighting recorded outcomes under the recorded
randomisation probabilities. This requires only reading the log.
- *Accept:* A candidate policy is scored against ≥ 8 weeks of recorded history with nothing
  deployed to any user.

**PO-5** MAY — layer `kernel` — *Substitutive* replay: re-executing recorded history with a
different randomisation draw at decision points, to observe how a counterfactual policy would
have proceeded.
- *This is a genuine new replay mode*, distinct from both event-log replay and projection
  re-execution: it deliberately diverges from recorded history while reusing the recorded prefix.
  Its semantics — what is reused, what is re-derived, where divergence is permitted to begin —
  are unspecified today.
- *Rationale for deferral:* PO-4 satisfies the Companion PRD's stated LP-6 requirement without
  it. Substitutive replay is a strictly stronger capability that has not yet been shown necessary.

### Promotion argument (PO-5) — conditional, deferred

Accepted as *Promotion 2, conditional*. Not to be built until a concrete evaluation question is
demonstrated that PO-4's importance weighting cannot answer — most plausibly when trajectories
become long enough that importance weights degenerate. The specification work (divergence
semantics, prefix reuse, interaction with checkpoint replay barriers) should be scoped before M4
so the decision is made deliberately rather than discovered under schedule pressure.

---

## 10. HO — Execution host topology

**HO-1** MUST — layer `spi` — Observation capture and tier-0/tier-1 processing execute
on-device. Raw observation records do not traverse the network.

**HO-2** MUST — layer `spi` — The on-device component is a *satellite* that performs local
ingest and projection and ships derived, minimised records to a Loom instance — not a full Loom
runtime target.
- *Rationale:* a full runtime on-device multiplies the SPI surface that must be maintained across
  engine implementations, for no capability gain. The satellite ships events; the instance owns runs.

**HO-3** MUST — layer `app` — Automation execution may require local effects (filesystem, local
applications). Local execution steps are dispatched to the satellite by the instance and their
results returned as ordinary step results.
- *Note:* this is adjacent to the deferred *external-wait transfer* promotion. See §11.3.

**HO-4** MUST — layer `app` — The system remains functional with the network unavailable, at
reduced capability: capture, projection and local-effect automations continue; cloud-escalated
classification and remote-effect automations queue.

**HO-5** MUST — layer `spi` — Satellite-to-instance transport preserves ordering and is
idempotent under retry. Duplicate delivery must not produce duplicate records.

---

## 11. Rejected and revisited promotions

Scoring the argument, not the conclusion: each entry states the reason for the verdict, so a
future workload can reopen it on the merits.

### 11.1 Declarative rotation policies — *revisit, favourable*

Previously deferred. IN-3 requires independent declarative retention per tier, and the
observation tier makes retention a *user-facing privacy control* rather than an operational
knob. This is the first workload where the deferred promotion has a product-visible
justification. Recommend re-scoping.

### 11.2 Checkpoint replay barriers — *no change*

Not required. PJ-1's determinism requirement is satisfied by window pinning and descriptor
versioning at the application layer. Barriers would become relevant only if PO-5 proceeds, where
they bear directly on where substitutive divergence may begin. Keep deferred; re-evaluate as
part of PO-5 scoping.

### 11.3 External-wait transfer — *revisit, favourable*

HO-3 dispatches local effects to a satellite that may be offline, asleep, or behind a network
change for hours. This is closer to the original motivation for external-wait transfer than any
prior workload. Recommend re-scoping alongside SU.

### 11.4 New entry kinds for domain events — *rejected*

The v0.1 Companion PRD's `activity.observed`, `task.completed` and `inefficiency.detected` read
as candidate kinds. They are not. The first two are payload discriminators (EL-2); the third is
a projected conclusion that must not be logged at all (EL-6). Opening the kind set would retract
the IX series' enumerability argument for no gain.

### 11.5 A "projection" primitive in the kernel — *rejected*

Projections are pure functions over a pinned window. They need a harness (PJ-7, stdlib) and a
discipline (PJ-4), not a primitive. A kernel projection primitive would invite projections that
suspend, at which point they are runs and should be written as runs.

### 11.6 Runtime DAG synthesis for automations — *rejected*

An automation compiled from a mined signature is a *statically typed flow generated at build
time from a candidate*, then approved and pinned. It is not a plan synthesised at execution
time. Preserving that distinction keeps this workload clear of the tension flagged in the
AetherOS review between runtime DAG synthesis and Loom's statically typed flow topology.
Generation happens before approval; execution runs a fixed, hashed flow.

### 11.7 Learned state inside kernel policy — *rejected*

PO-2 holds posteriors as projections precisely so no learned state becomes load-bearing kernel
state. EF-5 forbids learned adjustment of effect class, verification, or clearance. The learning
loop stays entirely above the determinism boundary.

---

## 12. Open questions

**LQ-1** Does the observation tier belong behind the Engine SPI at all, or is it a separate
store that projections read alongside a Loom instance? IN-2's cross-tier ordering requirement is
the deciding constraint. *Owner: platform. Due: before M0 ingest work.*

**LQ-2** What is the concrete storage and compute cost of SU-1 at 10⁴–10⁵ suspended runs per
instance, on the Postgres reference implementation? *Owner: platform. Due: M3 scoping.*

**LQ-3** Does the closed GenUI vocabulary cover machine-generated workflow review surfaces
(BP-1, BP-6)? Answerable early by synthesising blueprints for hand-mined candidates during M0,
before any synthesis code exists. *Owner: platform. Due: M0.*

**LQ-4** Where do effect-class declarations live syntactically — a flow-level declaration, or
derived from the `tool$` operations reachable within it? Derived is safer but requires every
tool to carry a class. *Owner: platform. Due: M2.*

**LQ-5** Does substitutive replay (PO-5) become necessary, and if so, what are its divergence
semantics? *Owner: platform. Due: specification before M4, build decision deferred.*

**LQ-6** How do very-long suspensions (SU) interact with `rotate$` boundaries (SU-5)? Carried,
abandoned, or explicitly declared per automation? *Owner: platform. Due: M3.*

---

## Appendix A — Traceability

| Companion PRD | Loom requirement | Layer |
|---|---|---|
| OB-3 log shape identity | EL-1..EL-5, IN-1 | app, spi |
| OB-10 gap events | IN-4 | app |
| PV-1 drop at capture | IN-5 | app |
| EP-2, EP-3 projections | PJ-1..PJ-3 | app |
| SG-5 replayable mining | PJ-1, PJ-4 | app |
| PR-5 replay explanation | RP-1..RP-5 | app (IX) |
| PR-2, PR-3 GenUI review | BP-1..BP-5 | app, stdlib |
| PV-2 clearance at build | EF-6 | compiler |
| EX-2 long suspension | SU-1..SU-5 | *kernel* |
| EX-3, EX-3a, EX-3b | EF-1..EF-3, EF-5 | compiler |
| EX-4 verification | EF-4 | compiler |
| EX-6 drift fail-closed | EF-2 (static), app | compiler, app |
| LP-3 bandit | PO-1, PO-2 | app |
| LP-4 randomisation | PO-3 | app |
| LP-6 off-policy eval | PO-4 (PO-5 conditional) | app, *kernel?* |
| LP-7 policy floor | EF-5, PO-2 | compiler, app |
| EC-5 local-only mode | HO-4 | app |
| KP-1..KP-8 | IN, HO, SU, EF, BP, PO | see §1 |

### Companion PRD §15 — the KP extract

- **KP-1** High-volume ingest path — likely a separate write path and retention tier.
- **KP-2** Local execution host — Loom runtime target, or satellite shipping derived events?
- **KP-3** Mining as a deterministic projection — confirm expressible with existing primitives.
- **KP-4** Runtime blueprint synthesis against the closed component vocabulary.
- **KP-5** Very-long-lived suspensions; interacts with run-lifetime bounding and run chaining.
- **KP-6** Policy as `guard$` with learned state; where do bandit posteriors live?
- **KP-7** Effect-class declaration and enforcement, validated at compile time.
- **KP-8** Replay inspector promoted from internal tool to shipped product feature.

## Appendix B — The one-line answer to "do we need custom event names?"

Yes at L2 (open, Zod-contracted, string-named payload discriminators). No at L1 (the kernel
entry-kind set stays closed). And the types that most look like they want to be events —
`inefficiency.detected`, `task.completed` — are conclusions, which get projected, not logged.
