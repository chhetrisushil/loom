# ADR 0088 — Blueprint conformance: enforcing a catalogue that was already declared

- Status: **Accepted — implemented** (2026-09-01)
- Date: 2026-09-01
- Resolves: **W1a / W1b** of the
  [product portfolio evaluation](../requirements/2026-09-01-product-portfolio-evaluation.md) §9
- Builds on: the second-consumer rule ([ADR 0083](0083-second-consumer-rule.md)),
  effect classes ([ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md)) for the
  app-supplies-the-vocabulary pattern, the A2UI egress adapter
  ([ADR 0069](0069-a2ui-egress-adapter.md)) whose catalogue this mirrors
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** No syscall, no event type,
  no fold change. Two pure functions and a declaration type in an existing package.

## Context

A blueprint a *person* wrote is checked by the type system: the widget builders are functions and
a typo is a compile error. A blueprint a *model* composed at runtime has no such check — it is
data, assembled from a catalogue, and the only thing between an off-catalogue component and a
viewer is whatever validates it on the way out.

Nothing did, on either path:

- `@loom/blueprint-runtime` widens `Widget.kind` to `string` so custom renderers can register any
  kind. `customWidget$` and `RendererRegistry.register` accept anything. There was no validator.
- `plugins/a2ui` has a real, schema-typed catalogue (`defineCatalog`) and `A2UISurfaceBridge`
  stamps `catalogId` on every `createSurface` **without checking a component against it**.

Neither `@loom/verify` nor the compiler knows the word "blueprint". A declared vocabulary that
enforces nothing reads as coverage while checking nothing — the failure mode
[ADR 0083](0083-second-consumer-rule.md) and the classification-reachability work both exist to
prevent — and it fails per viewer, at render time, once the surface is already open.

The reference GenUI example had to hand-roll the closure: `db-observability`'s `catalogue.ts`
makes the model name a catalogue **entry id** rather than a `kind`, and `catalogueEntry(id)`
throws on an unknown one. That indirection is the right instinct, but as app code it is
re-invented per app, unavailable on the egress path, and cannot express *"degrade to a plainer
component and record the gap"* — a throw is not a finding — nor produce a first-attempt
validation **rate**, which is what a composer is actually measured on.

## Decisions

### D1 — Two checks in two directions, and the second one is the easy one to forget

| | Question | Function |
|---|---|---|
| blueprint → catalogue | Does this composition name only audited components? | `validateBlueprint` |
| catalogue → renderer | Can this surface actually render everything the catalogue defines? | `catalogCoverage` |

The first is worth nothing alone. If a renderer does not implement everything the catalogue
defines, the composition validates and the viewer still gets a placeholder. **The second check
failed on shipped code with no product involved**: `WidgetKind` declared eight built-in widgets,
the React `defaultRegistry` registered five, and `BlueprintRenderer.test.tsx` *asserted* the
string `[No renderer for DataTable]` — pinning the gap as intended behaviour. `ProgressBar`,
`DataTable` and `AlertCard` now have renderers, and the fallback test points at a kind that is
genuinely outside the vocabulary.

### D2 — The catalogue is the app's; both of its fields are required

`CatalogEntry` is `{ kind, props, binding }` and **`props` and `binding` are not optional**. This
is the same reasoning as ADR 0084's app-supplied `effectClasses`: loom checks the vocabulary it is
given and does not define one. `builtinCatalog` ships as a catalogue *of loom's own eight
widgets*, not as the vocabulary every app must use.

Requiring both fields is deliberate. An entry that declined to say which props it accepts would
pass the payload check vacuously, and an absent input that silently means "pass" is precisely the
defect this ADR closes. `props: []` is a perfectly good answer; declining to answer is not one.

### D3 — `validateBlueprint` returns findings and never throws

CON §4.7 requires *"degrade to a typed table with an explicit statement of what was degraded, and
file a gap"*, and TRD **KC-2.2** requires ≥ 95% of synthesised blueprints to validate on first
attempt. Neither is expressible with an exception: a caller cannot degrade on a throw, and a rate
cannot be computed from one. The report therefore carries every finding from a single pass, plus
a **`widgets` count** — because `ok: true` over zero widgets is not evidence that a composer
works, and a rate needs its denominator.

One unknown `kind` produces exactly **one** finding. Without a catalogue entry there is no
allow-list and no binding requirement, so any follow-on finding would be invented, and inflating
the count for one real defect makes the rate lie.

### D4 — Five checks, and two of them are not about the catalogue at all

`unknown-kind` and `undeclared-prop` are the closure and exfiltration properties the evaluation
called for. Reading the code turned up three more that belong in the same pass because the
traversal already visits every node:

- **`missing-binding`** — a data-bearing component with no `DataBinding` renders blank, with no
  error anywhere.
- **`undeclared-projection`** — a binding to a projection the blueprint does not declare.
  Renderers hydrate only `blueprint.projections` (`useBlueprintProjectionValues` iterates exactly
  that list), so such a widget resolves to `undefined` and renders blank. This is silent omission
  in its purest form and nothing else in the system reports it.
- **`duplicate-node-id`** — `stableId` derives a widget's id from kind + props, so two
  structurally identical widgets collide, and the id is also the renderer's React key.

`undeclared-prop` is an **error**, not a style warning. A blueprint declares what to fetch, never
what was fetched; that is what lets one blueprint be shared and hydrated separately against each
viewer's permissions. A composer that inlines a fetched row into `props` turns a shareable
artifact into a copy of one viewer's data. The allow-list is exact rather than heuristic for the
same reason a heuristic would be worse than nothing: a rule that flags `DataTable.columns` as a
payload gets switched off, and a switched-off rule protects nobody.

### D5 — What this does NOT do

- It does not close `Widget.kind`. The type stays `string` and `customWidget$` still works;
  closure is a property of *validating against a catalogue*, not of the type. An app that never
  calls `validateBlueprint` is exactly as unchecked as before (G2).
- It does not touch the a2ui bridge. Validating on egress is **W1c** and lands with
  `recompose()`, because the check and the structural-update seam are the same seam.
- It does not make the two 1P renderers agree. `renderBlueprintToString` ignores `widget.kind`
  entirely and flattens every widget to `title: value`; that is legitimate for a text surface but
  it means *"two people looking at one blueprint see the same thing"* is false across surfaces.
  Its doc comment now says so rather than leaving the claim implied.

## Consequences

- `@loom/blueprint-runtime` gains `validateBlueprint`, `catalogCoverage`, `defineWidgetCatalog`,
  `builtinCatalog`, `BUILTIN_CATALOG_ID` and their types. No existing signature changed.
- `@loom/plugin-renderer-react` gains three renderers and a coverage test that fails the build if
  a kind is added to `builtinCatalog` without one.
- Every check is verified by its **negative** case — each was individually disabled and the suite
  went red for it — because a declared check and an enforced one look identical in a green suite.
- Second-consumer rule: satisfied three times before a line was written (CON P3/§5.1/§9.1,
  TRD KP-4/BP-2/KC-2.2, and AET as the case for why runtime synthesis is refused).
