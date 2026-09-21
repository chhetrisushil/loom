# ADR 0096 — The Blueprint is loom's stable rendering IR

- Status: **Accepted — implemented** (2026-09-21)
- Date: 2026-09-21
- Implements: slice 1 of the [loom-ui design](../requirements/2026-09-21-loom-ui-design.md) §8;
  resolves the Part II finding G5 (a kind-blind terminal renderer) of the
  [product portfolio evaluation](../requirements/2026-09-01-product-portfolio-evaluation.md).
- Builds on: [ADR 0088](0088-blueprint-conformance.md) (`catalogCoverage`, the second direction),
  [ADR 0083](0083-second-consumer-rule.md) (the outward gate),
  [ADR 0095](0095-binding-semantics-pin.md) (declared, not derived, versions);
  the MemoryStore SPI versioning precedent (`MEMORY_STORE_SPI_VERSION`, ADR 0091).
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** One constant, one manifest
  and one optional parameter, in two existing packages.

## Context

`@loom/blueprint-runtime`'s `Blueprint` was a value one application authored and one renderer
drew. The [loom-ui design](../requirements/2026-09-21-loom-ui-design.md) changes what it is: a
semantic Experience Model in a sibling repository **compiles to it**, and loom's renderers draw
the result. From that moment the shape of `Widget`, `Layout` and `Blueprint` is an interface that
code in another repository depends on — code nothing in this workspace builds or tests. A field
added, renamed or removed here would reach that consumer as a silent break, the hazard the
MemoryStore SPI version (ADR 0091) exists to prevent for storage backends.

Two facts made the decision concrete rather than speculative:

- The one GenUI product on loom past the demo stage (`genUI`) declared `@loom/blueprint-runtime`
  and imported nothing from it, building a private Blueprint instead. The
  [2026-09-21 evaluation](../requirements/2026-09-21-experience-rendering-runtime-evaluation.md)
  traced that to the vocabularies never meeting. Making loom's Blueprint the compile target is the
  fix, and a compile target needs a declared version.
- `plugins/renderer-terminal` was **kind-blind by design** — it never read `widget.kind`, so it
  could not fail on a kind it did not know and instead flattened every widget to `title: value`.
  Part II recorded this (G5): loom's two first-party renderers degraded in opposite directions,
  one visibly and one silently, so the "two people on a call see the same thing" property held
  for the data and not for the presentation. ADR 0088 D1 shipped the catalogue → renderer check
  for React; the terminal surface had nothing to check against.

## Decisions

### D1 — `BLUEPRINT_IR_VERSION`, declared beside the type

`@loom/blueprint-runtime` exports `BLUEPRINT_IR_VERSION` (semver, starting at `1.0.0`). A consumer
that compiles to the Blueprint pins it the way a storage backend pins the MemoryStore SPI. The
version is declared, not derived: a maintainer states that the shape changed and how much, and
D2 makes an undeclared change fail.

The version is deliberately *not* wired into `@loom/spec`'s `checkCompatibility` / compatibility
matrix: those grade runtime subsystems a deployment composes, and the Blueprint IR is consumed at
build time by a compiler in another repository, which pins the constant directly.

### D2 — The shape is guarded twice, because each guard fails a different way

`irVersion.ts` spells the shape a second time as **manifests** — one object literal per type
(`Widget`, `DataBinding`, the three layouts, `Blueprint`), plus the `WidgetKind` and layout `type`
literals — each checked with `satisfies` against a mapped type that makes every key required.
`tsc` rejects a missing key (required) and an excess key (excess-property check), so **a type
change without a manifest change fails the build.** `irVersion.test.ts` then pins
`fnv1a64(canonicalJson(BLUEPRINT_IR_SHAPE))` to each version, so **a manifest change without a
version bump fails the suite.** A `WidgetKind` added, a layout type added, a field added or
removed: each trips the first guard, and satisfying it trips the second until the version moves.

The guard covers field presence, field optionality (a required↔optional flip fails the build),
the `WidgetKind` literals and the layout `type` literals. It does not detect a field's *type*
being narrowed or widened, nor a `readonly` change; a consumer's own typecheck against the built
declarations catches those, which is why loom-ui's CI typechecks against loom's `dist`. Stated
here so nobody reads the green test as covering more than it does.

What counts as which bump: **major** — a key removed or renamed, a layout type removed, a
`WidgetKind` removed, a required field added; **minor** — an optional field added, a `WidgetKind`
or layout type added; **patch** — no shape change (the manifest digest is unchanged, so no new
pin is needed).

### D3 — The terminal renderer looks at the kind, when given something to look with

`renderBlueprintToString` and `TerminalRenderer` accept an optional `registry` of
`(widget, value) => string` renderers. Three states, kept distinct on purpose:

| State | Output |
|---|---|
| no registry | the kind-blind `title: value` — **byte-identical to before**, so no existing caller changes |
| registry has the kind | the renderer's block |
| registry lacks the kind | `[kind] title: value` — the gap is on the surface, not swallowed |

`defaultTerminalRegistry` covers loom's eight built-in kinds, and its test asserts
`catalogCoverage(builtinCatalog, defaultTerminalRegistry).ok` — the same question ADR 0088 D1
asked of the React registry, now asked of this surface too. Adding a kind to `WidgetKind` without
a terminal renderer fails that test. That check is kind-level: it proves every kind has a
renderer, not that every declared prop is honoured (`MetricCard.format` is ignored by both
first-party renderers today). The kind-blind default stays because a text surface that
flattens is legitimate; what was not legitimate was having no way to do otherwise.

### D4 — What loom does *not* do here

- **No semantic kinds.** `Trend`, `Insight`, `Investigation` and the rest belong to the framework's
  catalogue, which resolves them to loom kinds per surface. `WidgetKind` stays visual and stays
  eight.
- **No per-child grid `span`.** The framework's layout has one; loom's grid takes a column count.
  It ships as a prop the Lit renderer honours and the React grid ignores — visible degradation.
  It becomes a loom layout field only if a React consumer of the framework needs it; that would
  be a minor bump under D2. One collision is already known and deferred to loom-ui slice 2:
  `validateBlueprint` reports `props.span` as `undeclared-prop` (error) against `builtinCatalog`,
  so the compiler must either validate against the framework's own catalogue or `span` must
  become a reserved prop beside `binding`; slice 2 decides, and nothing in this ADR pre-empts it.
- **No move-out.** The 2026-09-21 evaluation listed `@loom/blueprint-runtime` and the two renderer
  plugins as candidates to leave loom. Its addendum withdraws that: a compile target has to stay
  where its consumers can pin it.

## Consequences

- `KERNEL_ABI_VERSION` stays 1.1.0; `EVENT_SCHEMA_VERSION` stays 1.18.0. No new event type, no
  fold change, no `@loom/spec` capability entry.
- `@loom/blueprint-runtime` exports `BLUEPRINT_IR_VERSION` and `BLUEPRINT_IR_SHAPE`. A shape change
  is now a two-file edit (type + manifest) plus a version bump plus a new pinned digest, and each
  omission is a red test.
- `@loom/plugin-renderer-terminal` exports `defaultTerminalRegistry`, `TerminalWidgetRenderer` and
  `TerminalRenderOptions`. Existing callers see identical output.
- loom-ui slice 2 onward pins `BLUEPRINT_IR_VERSION ^1.0.0` and builds its own
  `RendererRegistry<TerminalWidgetRenderer>` and merges it over `defaultTerminalRegistry` (never
  registers into the shared export).
