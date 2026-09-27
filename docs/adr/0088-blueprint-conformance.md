# ADR 0088 — Blueprint conformance: enforcing a catalogue that was already declared

- Status: **Accepted — implemented** (2026-09-01)
- Date: 2026-09-01
- Resolves: **W1a–W1e** of the
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

### D5 — The same hole existed on the egress path, twice (W1c)

`A2UISurfaceBridge` took a `catalogId: string`, stamped it on every `createSurface`, and checked
nothing against it. And catalogues declare the `functions` an agent may invoke on the client
([ADR 0070](0070-a2ui-callfunction-bidirectional-rpc.md)) — nothing compared a `callFunction` to
them either.

Three decisions:

- **Naming a catalogue without supplying it is refused at construction.** `catalog?: A2UICatalog`
  is the option that matters; `catalogId` alone now throws unless it is the default (which
  `defaultCatalog` backs). Leaving a path where an app can name a catalogue and skip the check
  would rebuild the hole this ADR closes, and construction is the earliest point at which the
  failure can be attributed to the code that caused it.
- **A catalogue that declares no `functions` is a refusal, not a permission.** Treating "no
  declaration" as "unverifiable, therefore allowed" is exactly how a declared vocabulary ends up
  enforcing nothing. This immediately caught three of the plugin's own tests calling
  `callFunction` against `defaultCatalog`, which declares none.
- **`recompose()` throws; `validateComponents()` reports.** A bridge that silently emitted nothing
  for a bad tree would turn an authoring bug into a surface that never updates — the silent
  omission the whole seam exists to prevent. Callers that want to degrade run the validator first.

**`updateComponents` now has a producer.** Its payload type has been declared, exported and in the
server-message union since the adapter shipped, with the comment *"defined for completeness"* and
nothing emitting one — so a session's component tree was fixed for its lifetime and no panel could
be added to a surface already open. `recompose(components)` emits it. Before the session opens it
emits nothing and the new tree becomes what the pending `createSurface` carries; there is no client
to update yet, and sending an update for a surface the client has never seen is the wrong message,
not a missing one. That is also why `requireRoot` is checked at construction and not on recompose:
an `updateComponents` batch may legitimately replace a subtree, and a check that rejects correct
usage gets turned off.

Component **props** are checked as an allow-list of declared keys only when the entry declares
`properties`; an entry that declares none yields an explicit `unchecked-props` **warn** rather than
a silent pass. A2UI property schemas are JSON-Schema `$ref`s into a shared types document, so this
module checks keys and makes no claim about values — a partial check announcing itself as complete
would be worse than none.

**The third instance was in the example that exists to demonstrate the feature.**
`a2ui-callfunction` authors `CHECKOUT_CATALOG` with both its functions declared, exports it, and
never passes it to the bridge. Its own suite passed while `pnpm start` threw, because the suite
drives the flow and the transport and never touches the egress seam. Fixed in
[loom-examples#23](https://github.com/chhetrisushil/loom-examples/pull/23), with the coverage that
would have caught it.

### D6 — Stable node identity, and a place to record who placed a node (W1d, W1e)

**W1d.** All eight widget builders now accept an optional `id` (`StreamingText` always did; the
other seven did not). The derived `stableId` hashes kind + props, so editing any prop
*re-identifies* the node — remounting it and breaking anything keyed on it. That is correct for a
view authored once and wrong for one a composer revises. `id` is destructured out of `props`, so
it never trips `undeclared-prop`. The helper's comment now also states plainly that the derived id
is a 32-bit identity, **not** a content address, and must not be used as an audit anchor.

**W1e.** `SurfacePatchPayload` gains an optional `by: PatchProvenance`. "Why is this panel here" is
answerable only if something recorded the answer when it was placed, and there was nowhere to
record it: `ctx.emit` takes no metadata, so provenance could only go *inside* the patched value,
polluting the data model the client binds to.

It rides the payload instead — `SURFACE_PATCH` is a userspace domain event that the fold skips, so
this is additive by construction and **EVENT_SCHEMA is untouched**. `surfaceProvenanceProjection()`
folds it into path → author, because patches are ordered events and "who last wrote this path" is
therefore a projection, not a second store. `provenanceOf()` falls back to the nearest recorded
ancestor: a composer that places a whole panel in one patch records the panel, so asking who placed
a leaf has to walk up to the placement that actually happened. An unattributed patch records
nothing — synthesising an author would be worse than leaving the question open.

Provenance is **not** forwarded to clients. The bridge reads `patches` only, so an internal agent
id or model version never reaches a viewer; there is a test asserting the wire bytes.

`SurfaceEmitter.as(by)` returns an attributed view rather than adding an argument to six methods
that most callers would leave off.

### D7 — What this does NOT do

- It does not close `Widget.kind`. The type stays `string` and `customWidget$` still works;
  closure is a property of *validating against a catalogue*, not of the type. An app that never
  calls `validateBlueprint` is exactly as unchecked as before (G2).
- It does not make the two 1P renderers agree. `renderBlueprintToString` ignores `widget.kind`
  entirely and flattens every widget to `title: value`; that is legitimate for a text surface but
  it means *"two people looking at one blueprint see the same thing"* is false across surfaces.
  Its doc comment now says so rather than leaving the claim implied.

  > **Update (ADR 0096):** the terminal renderer is kind-aware when given a registry;
  > `defaultTerminalRegistry` covers the catalogue and unregistered kinds are marked `[kind]`.

## Consequences

- `@loom/blueprint-runtime` gains `validateBlueprint`, `catalogCoverage`, `defineWidgetCatalog`,
  `builtinCatalog`, `BUILTIN_CATALOG_ID` and their types. No existing signature changed.
- `@loom/plugin-renderer-react` gains three renderers and a coverage test that fails the build if
  a kind is added to `builtinCatalog` without one.
- `@loom/plugin-a2ui` gains `validateComponents`, `validateFunctionCall`, `describeFindings`,
  `A2UISurfaceBridge.recompose()` and a `catalog` option. **Two breaking changes, both loud:**
  passing `catalogId` for a catalogue you do not supply now throws at construction, and
  `callFunction` throws for a name the catalogue does not declare. Neither can fail silently.
- `@loom/agent-surface` gains `PatchProvenance`, `surfaceProvenanceProjection`, `provenanceOf` and
  `SurfaceEmitter.as`. All additive; a log written without `by` folds identically.
- Every check is verified by its **negative** case — each was individually disabled and the suite
  went red for it — because a declared check and an enforced one look identical in a green suite.
- Second-consumer rule: satisfied three times before a line was written (CON P3/§5.1/§9.1,
  TRD KP-4/BP-2/KC-2.2, and AET as the case for why runtime synthesis is refused).

## Amendment (2026-09-27) — dangling ids, cycles, malformed catalogues; the second transport binding

D5 closed the catalogue hole but only for *props*: `column("root", ["ghost"])` (a child id no
component defines) and `column("root", ["root"])` (a component that is its own ancestor) both
passed `validateComponents` with `ok: true`. Both are exactly the class of defect an automated
composer — the recompose path this ADR added — gets wrong, and both are checkable without JSON
Schema: they are pure adjacency-list properties of the `children` references already being
iterated, not a claim about a prop *value*. A `defineCatalog` entry keyed differently from its own
`component` discriminator const (declared `"Text"`, discriminator `{ const: "Txt" }`) was also
unchecked — routing and rendering would disagree on the same catalogue.

**Four finding codes**, all in `validateComponents`:

- `dangling-child` (error) — a `children: string[]` entry (Column/Row) naming an id no component
  in scope defines.
- `dangling-template` (error) — a `children: { componentId }` entry (a List's template) naming an
  id no component in scope defines.
- `child-cycle` (error) — a component reachable from itself through `children` references.
- `unreachable-component` (warn) — no path from `root` reaches this component. Reported only when
  `requireRoot` **and** a root actually exists: with no root, `missing-root` already says
  everything there is to say, and flagging every other component as unreachable on top of it would
  be noise about the same defect, not a second one.

**Algorithm.** One iterative DFS, white/grey/black colouring, starting at `root` when present and
then continuing over any node the first pass left unvisited (an orphaned subtree can still loop on
itself) — O(V+E), no recursion. Untrusted, composer-generated payloads are exactly where a
thousands-of-nodes accidental cycle would show up; a recursive walk would blow the call stack
before a naive one even finished. A negative test builds a 50,000-node chain to prove this is
iterative rather than merely correct on small inputs.

**The correction that made this checkable at all — `A2UISurfaceBridge.recompose` vs. the client.**
`recompose` REPLACES the bridge's own stored `components` with each batch. An A2UI client, per the
protocol, MERGES an `updateComponents` batch into what it already holds, **by id**. Validating a
batch against only itself (or against the bridge's previous batch) would reject the correct,
intended usage of `recompose` — a subtree update naming an already-delivered sibling it did not
re-send — and a check that rejects correct usage gets turned off (this ADR's own D5 rule, applied
to itself). The bridge now keeps `clientView: Map<id, ComponentInstance>`, seeded in full when the
session opens (a `createSurface` is a full replace, matching what a client does on receiving one)
and merged incrementally on every subsequent `recompose` — in O(batch), not O(tree). `recompose`
validates each batch's `children` references, and walks cycle detection, against `components`
overlaid on `clientView`, so a batch may correctly reference a sibling from *any* earlier batch,
and a batch that closes a cycle back through an already-sent component is still caught.

**Catalogue well-formedness.** `validateCatalog(catalog)` checks that every `components` entry's
key equals its own `component.const`, and every `functions` entry's key equals its own `name`
(codes `catalog-entry-key-mismatch` / `catalog-function-key-mismatch`). Run once, in the
`A2UISurfaceBridge` constructor (`defaultCatalog` included, though it happens to be well-formed) —
every later check indexes `catalog.components` by key, so a mis-keyed entry would silently never
match the instances it exists to validate.

**`@loom/plugin-mcp-app` never validated at all.** `surfacePayload` reused `ComponentInstance` with
no `validateComponents` call, and the template's renderer (`template.ts`) returns `null` for an
unknown component type — a silent hole in the rendered view, one transport binding away from the
defect D5 closed on the A2UI egress path. `SurfacePayloadOptions` gains `catalog?: A2UICatalog`
(default `defaultCatalog` — the same default the A2UI bridge uses, since this is a second transport
binding for one component-tree vocabulary, not a second UI model); `surfacePayload` validates with
`requireRoot: true` (its payload is always a *complete* model, never a delta — see `adopt()` in the
template) and throws exactly as `A2UISurfaceBridge` does.

**What this does NOT do.** Prop *values* remain unchecked — a component's `properties` are still
JSON-Schema documents with `$ref`s into A2UI's `common_types.json`, and closing that needs a
JSON-Schema engine plus `$ref` resolution, deferred until a consumer ships a catalogue with typed
values (loom-ui is the likelier home). `callFunction` argument validation is deferred with it, for
the same reason.

- `@loom/plugin-a2ui` gains `validateCatalog` and the four finding codes above; `ValidateComponentsOptions`
  gains `knownComponents?: ReadonlyMap<string, ComponentInstance>`. Additive — no existing signature
  changed, and every existing conformant tree still validates.
- `@loom/plugin-mcp-app` gains `SurfacePayloadOptions.catalog`. **One breaking change, loud:**
  `surfacePayload` now throws for a tree it previously passed through unexamined.
- No new event type, no syscall, no fold change. **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA
  unchanged (1.18.0).**
