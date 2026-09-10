# Console AI mode (CON, revised) — placement re-evaluation

- Status: **Verdicts recorded. Net kernel change: zero — for the third time.** One new 1P item
  ([ADR 0095](../adr/0095-binding-semantics-pin.md), the binding-semantics pin), one deferral
  whose *shape* changes, one usage trap with no loom change behind it.
- Evaluates: *"AI Mode for the Google Cloud Console — Composition as the Interaction Model for
  Human and Agent Operators"*, a revision of the submission dispositioned as **CON** in the
  [product portfolio evaluation](2026-09-01-product-portfolio-evaluation.md) (§1 and Part II).
  Principles P1–P8 and §§1–15 are structurally unchanged; the expanded material is §4
  (experience and states), §9.3 (gap classes), §11.1 (verification), §12.1–12.3 (adoption and
  ownership) and §13.2 (falsifiable bets).
- Method: the ADR 0051 discipline — a placement verdict per claim, judged against the best
  userland alternative, bias outward (P10), the
  [second-consumer rule](../adr/0083-second-consumer-rule.md) applied before anything becomes 1P
  surface. Every claim below was checked against the repo, not against the prior evaluation.

---

## 0. What shipped since the last pass

The prior evaluation recommended one build (**W1**), one docs pattern (**W2**) and one deferral
(**W3**). Two of the three are closed, so most of this paper is now *built* rather than
"app code with nothing in the way":

| Prior item | Status |
|---|---|
| **W1** — blueprint conformance (P3, P4, §5.1, §9.1) | **Shipped.** [ADR 0088](../adr/0088-blueprint-conformance.md): `validateBlueprint` (six finding codes, including `undeclared-prop` — the §10.2 exfiltration boundary) and `catalogCoverage`, which found a live gap on shipped code; `A2UISurfaceBridge` refuses off-catalogue components and undeclared `callFunction`s instead of deferring the failure to the client |
| **W1d/W1e** — node identity, provenance (§5.2, §8.2) | **Shipped.** Optional explicit `id` on all eight builders; `SURFACE_PATCH.by` + `surfaceProvenanceProjection` / `provenanceOf`. [ADR 0094](../adr/0094-blueprint-node-identity.md) added the cross-tree half: `preservesNodes` / `blueprintNodeIds`, second consumer `A2UISurfaceBridge.identityDiff` |
| **W2** — composition as a logged artifact (§5.4, §5.6) | **Shipped as docs.** [`docs/composed-surfaces.md`](../composed-surfaces.md) is §5.4 written as a recipe: validate → `content.put` → `ctx.emit("BLUEPRINT_COMPOSED", { ref })` → pin against content GC. No new primitive, as predicted |
| **W3** — typed claims (P8, §10.5) | Still deferred. §3 below revises the *shape* of the deferral, not the verdict |

Unchanged and worth restating, because the paper is unchanged on both: **C6** — §10.3's *"content
from resources is data rendered by components, never input to composition"* is still stronger than
loom's mechanism, which *fences* tainted content in a `user` turn and *refuses* it only in
instruction positions ([ADR 0085](../adr/0085-untrusted-content-integrity-axis.md)); and **C7** —
a claim discipline one product observes and a sibling ignores is not a discipline.

---

## 1. The new finding — a binding's *meaning* is not pinned

**This is the one item worth building, and the paper is right that it matters more than it looks.**

`DataBinding` is `{ projectionId, path }`. `Projection` is `{ id, initialState, handlers }` —
**no version, no hash**. A composed surface is content-addressed, so its address covers the
binding's *name*; the referent is live code registered under that name, and the query, the filter
predicates, the join keys, the aggregation and the window all live there, on the unpinned side.

Three places state or assume the opposite:

- **CON §5.4's table** puts *"Query, filter predicates, join keys"* and *"Aggregation and time
  semantics"* in the frozen column, part of the content hash.
- **CON §7.2** makes the drift its headline risk for data workers: *"A saved cost view whose
  number moved because a binding drifted or a source repartitioned is exactly as damaging as a
  reshuffled incident dashboard, and considerably harder to notice."*
- **`docs/composed-surfaces.md`** — loom's own recipe — lists **"bindings"** among the things
  *"Frozen (part of the address)"*, under the heading *"The meaning of a view never changes
  silently."*

The structure freezes. The meaning does not, and the recipe currently promises otherwise. Time
semantics are the sharpest case: rolling-versus-fixed (§4.6, §5.3) is not expressible in a
`DataBinding` at all, so the distinction the paper requires a promoted view to record lives
entirely on the floating side.

### The second consumer is a live defect, unrelated to GenUI

`ReadModelDefinition` is `{ id, kinds, indexes, extract }` — **also unversioned**, and the
consequence is worse than a drifted chart:

- rows extracted by the old `extract` stay in the store;
- the `(modelId, executionId)` watermark is already past the events that produced them, so
  catch-up never revisits them;
- one `query` therefore answers from two extractors at once, with no signal anywhere;
- `rebuild()` is the fix, and nothing in the code or the docs tells an author that changing an
  extractor requires one. [ADR 0058](../adr/0058-read-model-plugin.md) pins that *"drop-and-rebuild
  yields identical rows"* — true, and only true for an unchanged extractor.

Two consumers, in unrelated packages, of one question: *is the derivation behind this name still
the derivation this artifact was built against?* That satisfies
[ADR 0083](../adr/0083-second-consumer-rule.md), and — as with ADR 0094 — the second consumer
changed the API rather than ratifying it: read-model pins come from a **service's registered
definitions**, not from a tree, so the comparison is over `id → version` maps and cannot be
blueprint-shaped.

**Placement: 1P, no kernel.** Recorded as [ADR 0095](../adr/0095-binding-semantics-pin.md).
`KERNEL_ABI` unchanged, `EVENT_SCHEMA` unchanged, no syscall, no event type, no fold change.

### What it cannot be

Derived. `flowContentHash` deliberately excludes handler code because it is *"not stably
serializable at runtime"*, and a fold closure has no stable fingerprint either. The pin is
therefore **declared** — an app-supplied `version`, the same app-supplies-the-vocabulary pattern
as [ADR 0084](../adr/0084-effect-classes-static-ceiling-k2-floor.md)'s effect classes and
[ADR 0088](../adr/0088-blueprint-conformance.md) D2's catalogue. A declaration is a claim, not a
proof: an author who edits a fold and does not bump the version still lies, and no framework can
catch that. What it buys is that the honest case becomes *checkable*, and the dishonest one
becomes a review question rather than an invisible one.

---

## 2. §11.1 verification — a real trap with no loom change behind it

> *"Every action carries a stated expected effect, and the system observes against it."*

`OUTCOME_RECORDED` carries `key`, `success` / `score` and an optional `decisionId`
(`packages/analytics/src/outcomes.ts`). **There is no slot for the expectation, and there should
not be one here.** An expectation recorded at outcome time is not an expectation; it is a
judgment, written by whoever already knows how things turned out. "Verified against expectation"
then degrades into "someone graded it afterwards" — with nothing in the system reporting the
loss.

This is the same failure class as **C1** in the prior evaluation (a propensity cannot be
reconstructed after the fact), and the mechanism is likewise already shipped and free: state the
expected effect **at action time**, as `ctx.decide`'s `context` on `DECISION_RECORDED`
([ADR 0079](../adr/0079-decision-context-and-policy.md)), then link the observation with
`OUTCOME_RECORDED.decisionId`. Both halves are then in the log, in the right order, and the
comparison is a projection over them.

**Verdict: app.** No new field, no new event — but the paper should say *where* the expectation is
written, because §11.1 as drafted is satisfiable by a system that records nothing until after the
fact.

---

## 3. §10.5 typed claims — the deferral holds, and its shape changes

W3 recommended building claim classes as app code and promoting only on a second consumer with the
same *mechanism*. That still stands, and reading the revision alongside the repo sharpens why.

**The ladder has a decidability seam between `correlated` and `estimated`.**

- **Below it, loom already ships the mechanism twice.** `observed` reduces to *"this assertion's
  evidence reference resolves to evidence the system holds"* — which is `undeclared-projection` in
  `validateBlueprint` (a binding to a projection the blueprint never declares), and it is
  `checkCitations` / `assertGrounded` in `@loom/knowledge`, whose own comment draws exactly this
  line: a fabricated citation is decidable with certainty, whether the claim *follows* from the
  passage needs a judge.
- **Above it, nothing is checkable at composition.** `estimated` and `predicted` require a
  validated model with error bounds; `causal` requires intervention evidence. A framework can
  record the label and refuse the top rung — which is what the paper already does with root cause,
  and what §11.1 concedes when it scopes verification to *"what is deterministically checkable."*

So the honest form of P8 is two regimes, not one ladder: a **checked** floor (the class is refused
unless its evidence reference resolves) and a **recorded** ceiling (the class is a durable claim
about provenance that no seam can validate). A design that presents them as one ladder will
silently degrade into a label — the vacuous-check pattern, at the exact place the paper's trust
model is load-bearing.

Consequence for loom: if this ever becomes 1P it is **not** a third `@loom/classify` axis. It is a
label plus evidence-reference resolution, and two implementations of that already exist in the
repo. The gate is unchanged: a second consumer whose *implementation* has that shape, not whose
motive does.

---

## 4. Everything else in the revision

| CON | Verdict |
|---|---|
| §4.1–4.6 fixed chrome / composed canvas, four intent entry points, promotion | **app** — the composer, the palette and the promotion UX are product |
| §4.7 *composing* (progressive, arrangement first) | **shipped** — `traverseBlueprintAsync` + `IncrementalRenderer` |
| §4.7 *composition failed*, *no component fits* | **shipped** — `validateBlueprint` returns findings, never throws, precisely so a caller can degrade and file a gap ([ADR 0088](../adr/0088-blueprint-conformance.md) D3) |
| §4.7 *permission denied*, *partial or sampled*, *stale binding* | **app.** Per-viewer hydration is app-side, so what a denied or partial value *is* is the app's vocabulary. One wart worth knowing: the built-in renderers stringify their bound value (`String(value)`, `"—"` when absent), so an app's own "withheld" sentinel renders as `[object Object]` through a 1P widget. One named consumer, so it stays app code — but a product that needs denial to be visible at the component level will register its own renderer |
| §4.7 *incident freeze* | **app** — a policy over which recorded `ref` renders; the artifact is already immutable and addressable |
| §4.7 *agent contribution pending*, reversible at node granularity | **app**, with both halves shipped: attribution is `SURFACE_PATCH.by` + `provenanceOf`, and "the pre-agent state is always recoverable" is a re-fold of an ordered log filtered by author. Detection of what a revision would unmount is `preservesNodes` / `identityDiff` ([ADR 0094](../adr/0094-blueprint-node-identity.md)) |
| §5.2 semantic mutation ops (add node, rebind, reorder) | **Not needed, and deliberately absent.** `SURFACE_PATCH` addresses values and has no structural op; recomposition is a second `BLUEPRINT_COMPOSED`, not a mutation of the first. The merge primitive the paper actually needs is *identity*, which shipped. A blueprint **diff** has no second consumer today — A2UI's `updateComponents` may legitimately replace a subtree, so the egress path does not need one |
| §7.3 export / diff / code review of a view | **app** — a blueprint is JSON with stable node ids; diff is a tree comparison, export is a serialization |
| §8.3 agent-to-agent handoff as artifact exchange | **shipped** — P7 was already the best-supported claim in the paper (`agentSurfaceProjection` + the A2UI bridge project one logged artifact two ways) |
| §9.3 gap classes (intent/data/tool/relationship/component/workflow/policy) | **app** — `@loom/analytics` read-only lenses over the composition log. The class taxonomy is the product's |
| §11 reversibility classes 0–4 | **shipped** — [ADR 0084](../adr/0084-effect-classes-static-ceiling-k2-floor.md), app-supplied ascending vocabulary, composed as the max over every reachable effect ([ADR 0086](../adr/0086-runner-body-reach-analysis.md)) |
| §12.2 automatic baseline: draft tool contracts from existing API schemas | **tooling** — `@loom/appgen` / `loom scaffold`, at build time. Deliberately no runtime NL (P11) |
| §12.3 ownership split | organisational; nothing to place |
| §13.1 first-attempt validation rate, gap velocity | **computable today** — `BlueprintValidation.widgets` is the denominator ADR 0088 D3 added for exactly this metric; the rest is analytics |
| §13.2 H1–H8 | The right shape for a proposal this size. H6 ("the catalogue is tractable") is the one loom can instrument directly: degradation rate is a rate over `validateBlueprint` findings, not a survey |
| §14 open question 3 — migrating content-addressed artifacts | Prior evaluation's contribution stands: `flowHash` + `FlowCodeMismatchError`, K11.5 `resumeAs`, and `pinOf`'s `unpinned-legacy` are the same problem solved three ways. [ADR 0095](../adr/0095-binding-semantics-pin.md) extends that precedent to the data axis |

---

## 5. Summary

| | Kernel | 1P | App | Already shipped |
|---|---|---|---|---|
| **CON (revised)** | 0 | ADR 0095 — the binding-semantics pin | §4 experience, §7.2 promotion UX, §9.3 gap taxonomy, §11.1 expectation-at-action-time, §10.5 claim classes | P3/P4 catalogue conformance, P7, node identity + provenance, §5.4/§5.6 recipe, §11 reversibility classes, §10.3 taint, §10.4 audit chain |

`KERNEL_ABI` stays **1.1.0**. `EVENT_SCHEMA` stays **1.18.0**.

The paper's own conclusion — *"the next commitment worth making is the experiment, not the
platform"* — is the right one, and nothing in loom blocks that experiment today. The single item
that does not wait for it is §1's pin, because the defect it names is already in this repo,
serving rows from two extractors under one name, with no whitepaper attached.
