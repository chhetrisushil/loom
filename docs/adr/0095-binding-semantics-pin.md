# ADR 0095 — Pinning what a binding *means*, not just what it is called

- Status: **Accepted** (2026-09-10). Implementation follows immediately in
  `feat/binding-semantics-pin`; this record is written first because the decision is the
  reviewable part.
- Date: 2026-09-10
- Resolves: §1 of the
  [Console AI mode re-evaluation](../requirements/2026-09-10-console-ai-mode-evaluation.md)
- Builds on: [ADR 0088](0088-blueprint-conformance.md) (findings-not-throws, and the
  denominator), [ADR 0094](0094-blueprint-node-identity.md) (one question, asked over sets),
  [ADR 0083](0083-second-consumer-rule.md) (the outward gate), K11.1's `flowContentHash` and
  `FlowCodeMismatchError` — the same pin, one tier in.
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** Pure functions over
  JSON-serializable values plus one optional declared field on three existing types. No syscall,
  no event type, no fold change.

## Context

A composed surface is content-addressed: `sha256(bytes)` over the blueprint *is* its semantic
identity, and `docs/composed-surfaces.md` says so under the heading **"The meaning of a view never
changes silently."** That page lists what the address freezes — *"intent, layout, node identity,
bindings, and the catalogue id"* — and the fourth item is where the promise stops being true.

`DataBinding` is `{ projectionId, path }`. `Projection` is `{ id, initialState, handlers }`, with
**no version and no hash**. So the address covers the binding's *name*; the referent is live code
registered under that name, and the query, the filter predicates, the join keys, the aggregation
and the window all live in the referent. Edit the fold and every pinned view bound to it renders a
different number under an unchanged hash. Rolling-versus-fixed time semantics — the distinction a
promoted view most needs to record — are not expressible in a `DataBinding` at all.

**The same hole exists in an unrelated package, and there it is already a live defect.**
`ReadModelDefinition` is `{ id, kinds, indexes, extract }`, also unversioned. Change `extract` and:
rows written by the old one stay; the `(modelId, executionId)` watermark is already past the events
that produced them, so catch-up never revisits them; one `query` answers from two extractors at
once; and `rebuild()` — the fix — is something nothing in the code or the docs tells the author to
run. [ADR 0058](0058-read-model-plugin.md) pins that *"drop-and-rebuild yields identical rows"*,
which is true, and true only of an unchanged extractor.

One question, two consumers: **is the derivation behind this name still the derivation this
artifact was built against?**

## Decisions

### D1 — The pin is declared, not derived

`version?: string` on `ProjectionDefinition`, on the projection runtime's `Projection`, and on
`ReadModelDefinition`. Author-supplied, opaque, compared by equality.

Deriving it is not available. `flowContentHash` deliberately excludes handler code because it is
*"not stably serializable at runtime"*, and a fold closure is the same object; a hash over
`Function.prototype.toString` would flip on a whitespace edit and hold steady across a changed
constant captured in scope — wrong in both directions. So this is the app-supplies-the-vocabulary
pattern of [ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md) and
[ADR 0088](0088-blueprint-conformance.md) D2: loom checks the declaration it is given and does not
invent one.

The limit is stated rather than hidden. **A declaration is a claim, not a proof** — an author who
edits a fold and does not bump the version still lies, and no framework can catch that. What
changes is that the honest case becomes checkable and the dishonest one becomes a review question
instead of an invisible one. That is the same bar `EffectClass` and `CatalogEntry.props` meet.

### D2 — One question, asked over `id → version` maps

```ts
checkVersionPins(recorded: VersionPins | undefined, current: VersionPins | undefined): PinReport
```

Maps, not blueprints — and, as in [ADR 0094](0094-blueprint-node-identity.md) D3, that shape was
forced by the second consumer rather than chosen for elegance: read-model pins come from a
**service's registered definitions**, not from a tree. A blueprint-shaped
`checkBindingPins(before: Blueprint, after: Blueprint)` — the obvious first API — cannot serve
`ReadModelService` at all. `blueprintPins` and `checkBlueprintPins` spell the blueprint case, the
way `blueprintNodeIds` / `preservesBlueprintNodes` spell it for identity.

Two finding codes:

- **`drift`** (error) — recorded and current both declare, and they differ. The artifact was built
  against a derivation that no longer exists under this name.
- **`unpinned`** (warn) — one side declares nothing. It carries which side, because the two cases
  read differently: an artifact predating the pin is `pinOf`'s `unpinned-legacy` case, while a
  *registered* derivation that declines to declare a version is an author decision not to be
  checkable.

### D3 — Unpinned is a finding, and `compared` is the denominator

An absent input that silently means "pass" is the defect ADR 0088 D2 and the a2ui
`unchecked-props` warning both exist to prevent, and it is exactly what would happen here by
default: compare two empty maps, get `ok: true`, and read it as evidence that a view still means
what it meant. So an id declared on one side and not the other is reported, and `PinReport.compared`
counts the ids that were genuinely compared — `ok: true` over `compared: 0` is not a pass, it is an
absence of evidence, and the caller can tell the difference.

### D4 — It reports; it never throws

`FlowCodeMismatchError` throws because the kernel is about to fold a log with the wrong code, which
has no correct outcome. A drifted binding does: the app may legitimately accept it (a deliberate
re-promotion), degrade to a stated-as-stale rendering, or refuse. Only the caller knows which, so
this is a findings list — ADR 0088 D3 and ADR 0094 D2, unchanged.

### D5 — The artifact carries the recorded pin; loom does not store it for you

`Blueprint` gains `projectionVersions?: VersionPins`, so the pin is **part of the value and
therefore part of the content address** — which is what makes the docs' frozen list true rather
than aspirational. A test asserts exactly that: two blueprints differing only in
`projectionVersions` hash differently.

Nothing durable is added on the read-model side, deliberately. A version registry inside the store
would be a second source of truth about semantics, would need a `ReadModelStore` SPI change and
three backend implementations, and would answer a question the caller can already answer: whoever
saved the derived artifact records the pins it was built from and compares later.
`ReadModelService.pins()` returns the declared versions, and `ReadModelService.checkPins(recorded)`
is the wired second consumer — a **query**, exactly like `A2UISurfaceBridge.identityDiff`: it
reports what would be wrong without clearing anything or rebuilding.

### D6 — `validateBlueprint` is not extended

The tempting move is a seventh finding code. It does not fit: every `BlueprintFinding` names a
`nodeId` and a `kind` because the traversal visits widgets, and the pin question is a property of
two maps, not of a node. Keeping one function to one question is why `preservesNodes` was not
folded into the validator either.

## Consequences

- The frozen/floating split in `docs/composed-surfaces.md` becomes accurate: **bindings are frozen
  by name, and their meaning is pinned by declaration.** The page is corrected in the same change,
  because a promise with no mechanism is worse than no promise.
- A read model whose extractor changed can be *detected* rather than discovered by someone noticing
  two rows disagree, and the detection names `rebuild()` as the exit.
- Nothing is enforced automatically, and nothing is rebuilt automatically. Version-in-the-storage-key
  was considered and rejected: it makes drift impossible by making a bumped version a fresh model,
  but the old rows are then unreachable and unenumerable — a leak per bump, in exchange for a
  rebuild the caller never asked for.
- CON §14's open question 3 (migrating content-addressed artifacts) now has the same answer on the
  data axis that K11.1/K11.5 give on the code axis: pin the identity, report the mismatch, migrate
  deliberately.
