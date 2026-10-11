# ADR 0097 — Blueprint IR 2.0.0: the IR grows instead of being worked around

- Status: **Accepted — implemented** (2026-09-22)
- Date: 2026-09-22
- Implements: the [Blueprint IR 2.0.0 design](../requirements/2026-09-22-blueprint-ir-2-design.md).
- Builds on: [ADR 0096](0096-blueprint-stable-rendering-ir.md) (the version pin this bump uses),
  [ADR 0088](0088-blueprint-conformance.md) (`validateBlueprint`/`catalogCoverage`, extended here
  with seven new codes), [ADR 0095](0095-binding-semantics-pin.md) (declared, not derived, meaning —
  the same discipline this ADR applies to a binding's delivery state), [ADR 0085](0085-untrusted-content-integrity-axis.md)
  (the classify vocabulary `sensitivity` reuses).
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** `BLUEPRINT_IR_VERSION`
  1.0.0 → 2.0.0.

## Context

[ADR 0096](0096-blueprint-stable-rendering-ir.md) made the Blueprint a declared compile target:
a version constant, a shape manifest `tsc` checks exhaustively, and a digest a test pins per
version, so a consumer in another repository could pin the shape the way a storage backend pins
the MemoryStore SPI. The sibling framework loom-ui took it up as exactly that — its compiler
turns a semantic Experience Model into a Blueprint, and both of loom's renderers, plus loom-ui's
own Lit and terminal adapters, draw the result.

Five slices into that framework, three facts the Blueprint could not carry had each found a way
around it instead of through it:

1. **A grid child's width.** loom-ui's layout has a per-child `span`; loom's `GridLayout` does
   not. It shipped as `props.span`, a reserved key declared into every derived catalogue
   contract — [ADR 0096 D4](0096-blueprint-stable-rendering-ir.md#d4--what-loom-does-not-do-here)
   named this "visible degradation" and deferred the field rather than pre-empt loom-ui's own
   slice 2 decision. Lit read the prop and honoured it; React's grid renderer did not know to
   look, so a nested container's span was silently dropped, and `validateBlueprint` flagged
   `props.span` as `undeclared-prop` against `builtinCatalog` — the workaround and the guard
   disagreed with each other on the same artifact.
2. **Hydration status.** `pending | ready | stale | error` has nowhere to live in a `DataBinding`,
   so loom-ui's Lit and terminal adapters computed `handleFromPath(binding.path)` and read
   `state.status[handle]` out of the hydration projection directly — behind the Blueprint's
   back, coupling every adapter to hydration's internal keying instead of to the artifact each
   adapter is supposed to render from. loom's own React renderer showed no status at all,
   because there was no channel to read one from.
3. **Degrade provenance.** loom-ui's compiler resolves a semantic type to a concrete kind per
   surface — `Trend@1.0.0 → Collection@1.0.0 → DataTable` when a surface has no native trend
   widget — and then discarded the chain, because the Blueprint had no slot for it. No renderer
   could tell a degraded `Trend` from a `DataTable` that was always a `DataTable`, so the
   "two people on a call see the same thing" property held for the *value* and not for what the
   surface was honestly showing.

Each leak was one adapter's workaround, visible only to the adapters loom-ui wrote, invisible to
loom's own renderers and to any third consumer of the Blueprint. A whitepaper evaluated against
loom-ui slices 1–5 in the same review (*The Experience Runtime: Moving UI Frameworks Below the
Semantic Boundary*) predicted precisely this failure mode for a rendering IR that cannot grow:
the meaning migrates to side channels the IR's own guards cannot see, and every side channel is a
fact one surface knows and the rest do not. The paper also draws the line this design keeps: a
mutable experience **model** a planner edits, compiled to one validated **IR** every adapter
consumes. loom-ui already holds that split — the Experience is content-addressed and planner-
facing, the Blueprint is the IR — so closing these leaks is a property of the IR, not a rethink of
the split.

The maintainer's ruling, made in the same review that produced the design this ADR implements: the
IR grows, deliberately, under the version pin ADR 0096 built for exactly this. [ADR 0096
D4](0096-blueprint-stable-rendering-ir.md#d4--what-loom-does-not-do-here) said a loom layout
field for `span` "becomes a loom layout field only if a React consumer of the framework needs it;
that would be a minor bump under D2" — loom-ui's compiler is that consumer, and the shape of the
fix (a wrapped cell, not a bare optional) makes it a major bump instead, for the reason [Decision
D1](#d1--the-grid-child-is-wrapped-not-decorated) gives.

## Decisions

### D1 — The grid child is wrapped, not decorated

`GridLayout.children` becomes `GridCell[]`, where `GridCell { span?: number; node: Widget |
Layout }`. A `span` on `Widget` or `Layout` directly was rejected: it would put the fact on two
shapes (a widget's own props already carry `binding` and now `source`; a nested `Layout` has no
natural home for a column count that belongs to its *parent*, not to it) and it does not answer
what a non-grid container does with a field that means nothing outside a grid. A wrapped cell
puts the fact exactly where it is true — the *edge* from a grid to its child — and nowhere else.

Because `GridCell` replaces the element type of an existing array rather than adding an optional
field, this is [ADR 0096 D2](0096-blueprint-stable-rendering-ir.md#d2--the-shape-is-guarded-twice-because-each-guard-fails-a-different-way)'s
**major** case: `BLUEPRINT_IR_VERSION` moves `1.0.0` → `2.0.0`, `BLUEPRINT_IR_SHAPE` gains a
`GRID_CELL` manifest entry alongside the widened `GridLayout` one, and `irVersion.test.ts` pins a
second digest under `2.0.0` beside the untouched `1.0.0` row.

A version bump that broke every existing `grid({ children: [...] })` call across this repo and
loom-examples would be the workaround problem again, one level up, so compatibility is symmetric:

- **Readers accept 1.0.0.** `asCell(child: GridCell | Widget | Layout): GridCell` is the one
  place a bare legacy child becomes a cell (`{ span: 1, node: child }`); `traverseBlueprint`,
  `validateBlueprint` and both renderers call it and branch on the union nowhere else
  (`blueprintPins` reads `Blueprint.projectionVersions` and never walks the tree, so it has no
  grid child to normalise). `Blueprint.irVersion` names the shape an artifact was written in; its absence
  reads as `"1.0.0"` (`blueprintIrVersion`, `IR_VERSION_LEGACY`).
- **Writers emit 2.0.0.** `blueprint$` stamps `irVersion: BLUEPRINT_IR_VERSION` on every artifact
  it builds. `grid({ columns, children })` accepts `Array<GridCell | Widget | Layout>` and
  normalises every element through `asCell`, so `grid({ children: [MetricCard(...)] })` — every
  existing call in this repo and its examples — keeps compiling and now produces a 2.0.0
  artifact with implicit `span: 1` cells. `cell(span, node)` is the new builder for an explicit
  span.
- **Explicit upgrade.** `upgradeBlueprint(bp)` returns a 2.0.0 artifact — cells wrapped
  recursively through nested layouts, `irVersion` set — and is identity (same reference) on
  already-2.0.0 input. It exists for a migration or a `getExperience`-shaped reader that wants to
  re-address a stored artifact; ordinary readers never need to call it, because they already
  accept 1.0.0 through `asCell`.
- **Content addresses change.** A 1.0.0 artifact re-emitted as 2.0.0 has a different content
  address, precisely because its shape changed. That is a new artifact with the old one as its
  parent, the same rule every other structural change follows; nothing rewrites what is already
  stored.
- **A cell is an IR edge, not a DOM element.** A renderer adds an element for a cell only when
  it has something to say with it: on React, **a grid child gains a wrapper element ONLY when
  its span exceeds 1**; span-1 children — and therefore every 1.0.0 grid, whose cells are all
  implicitly span 1 — render DOM identical to 1.0.0. That is not only a cosmetic property. A
  wrapper interposed on every cell would own the array position React diffs, and keying it by
  index re-identifies every cell after a removed sibling: React then discards the survivors'
  DOM (with their focus, scroll offset and uncontrolled input state) and rebuilds it. Emitting
  the child directly keeps `key={widget.id}` on the element React diffs, so a grid child
  reconciles by widget id exactly as a `stack` child always has; the span > 1 wrapper takes the
  child's own key for the same reason.

### D2 — loom owns the status contract; the matrix is canonical on every surface

`DataBinding.status?: { path }` names where, in the *same* projection state a binding's `value`
already reads from, that binding's delivery state lives. `BindingStatus { state: BindingState;
seq?: number; finding?: { code, message } }` is loom's own type — not an opaque re-export of
loom-ui's hydration shape — because an opaque second path would leak loom-ui's own keying into
every consumer of the Blueprint, which is the leak this ADR closes, not one to open on the way
past. `BindingState` is `"pending" | "ready" | "stale" | "error"`. A binding without `status` has
no channel at all: nothing is inferred, nothing defaults to a state, and the field means "not
declared," not "always ready."

`traverseBlueprint` resolves `status` beside `value` on every call: `resolveWidgetStatus(widget,
stateMap)` reads `binding.status.path` out of `stateMap.get(binding.projectionId)` — the same
map, the same projection, one extra path — and validates the result structurally
(`isBindingStatus`). A value at that path that is not a well-formed `BindingStatus` resolves to
`undefined`; it is never a throw, because a malformed write to a projection must not take down
every widget that happens to read near it. `WidgetRendererProps` gains `status?:
BindingStatus`, and `ContainerContext` gains `cells?: Array<{ span, child }>` so a grid renderer
can read spans without re-deriving them.

**The canonical status matrix**, identical on every renderer, and engaged only when a binding
*declares* a status channel at all:

- `error` → the finding replaces the value entirely; the widget's own renderer never runs.
- `stale` → a marker plus the value when one is present, a marker plus "no value" when it is not.
- `pending` → a marker plus the value when one is present, a loading state when it is not.
- `status` undefined (never written, or malformed) or `state: "ready"`, with `value === undefined`
  → loading. On the terminal that row is `⋯ <title>`, the same line as pending-with-no-value:
  "it has not arrived", not `<title>: —`, which reads as "the answer is nothing."
- Otherwise → ready.

Between `error` and `stale` the matrix leaves one documented slot: an optional `check(widget,
value)` supplied by the caller — `TerminalRenderOptions.check` and the `check` prop on
`BlueprintRenderer` and `WidgetFrame`. loom validates nothing about values itself; a framework's
own kind contract (loom-ui's `checkKindValue`) plugs in here, and a returned `{ code, message }`
renders exactly as the error row does, suppressing the widget's renderer. It runs only for a
widget whose binding DECLARES a status channel, and only when delivery has not already failed —
`status.state === "error"` outranks it, because there is no value to check when the fetch
itself did. Returning `undefined` leaves the rest of the matrix untouched.

The rule that keeps this from being a spinner trap: **a present value renders ready even when its
status has not been written yet.** `status` arriving is not a precondition for showing `value` —
a value is never hidden behind a loading marker solely because its status write has not landed,
which would make every fast, successful read wait on a second write that exists only to describe
it. And **a widget without a declared status channel renders byte-identically to 1.0.0** — no
wrapper, no attribute, no marker. On React this is structural, not a branch to remember:
`WidgetFrame` returns `children` unchanged when `widget.binding?.status === undefined` and
`widget.source === undefined`, so a 1.0.0 artifact adds zero DOM nodes by construction, and the
eight built-in kind renderers receive `status` as a prop and ignore it, because the wrapper — not
the kind renderer — owns the matrix. On the terminal renderer the same rule holds text-only: no
declared channel, no glyph, output unchanged from before this ADR.

### D3 — `Widget.source` names what a widget stands for; it never rides in `props`

`WidgetSource { type: string; version: string; degradedFrom?: Array<{ type, version }> }` is a
new optional field on `Widget`, sibling to `binding`, not a key inside `props`. That placement is
the fix for leak 3: `props` is validated against a catalogue's declared prop set
(`undeclared-prop`), so a degrade chain living there would either have to be declared into every
catalogue that carries a degradable widget or fail validation — the same trap `span` was in
before D1. `source` is structural, like `binding`, so it needs no catalogue entry and no
consumer to opt in before it can be read.

`degradedFrom` is ordered outermost-first: `Trend@1.0.0 → Collection@1.0.0` reads left to right as
"resolved from `Trend`, then from `Collection`, to reach the kind actually rendered." React
renders it as `data-source-type`, `data-source-version`, and — only when `degradedFrom` is
present — `data-degraded` plus a tooltip `title`; the terminal renderer appends
`(degraded from Trend@1.0.0)` to the widget's line. Neither renderer computes a degrade chain;
both only display one a compiler already resolved and attached.

### D4 — `DataBinding.sensitivity` is a field, not an enforcement point

`DataBinding.sensitivity?: DataClass` is a type-only import from `@loom/classify` — a new
dependency of `@loom/blueprint-runtime`, erased at build time, adding no runtime coupling to the
classification package. The field lets a compiler *declare* a binding's confidentiality class on
the artifact a downstream audience check reads; it does not perform that check. `validateBlueprint`
confirms the value is a real `DataClass`, nothing more, and no renderer branches on it — reading
`sensitivity` and deciding what an audience may see is loom-ui's `audience` surface, [roadmap
slice 7](../requirements/2026-09-22-blueprint-ir-2-design.md#7-roadmap--every-capability-with-its-reference-example),
not part of this ADR. Shipping the field ahead of its enforcer is deliberate: the field is what
makes a later audience check able to read a Blueprint that already carries the fact, rather than
retrofitting a fourth structural field onto artifacts that predate it.

### D5 — What loom does not do here

- **No semantic kinds.** `Trend`, `Insight`, `Investigation` and the rest stay a framework
  catalogue's vocabulary, resolved to one of loom's eight `WidgetKind`s per surface at compile
  time. `WidgetKind` is unchanged by this ADR.
- **No span on `flex` or `stack`.** Both take `Array<Widget | Layout>` unchanged; neither has
  columns for a span to occupy, and giving every layout a field only grids use would recreate the
  union-shape problem D1 rejects a different way.
- **No audience on the `Blueprint`.** Audience is a property of the rendered *surface*, resolved
  by a compiler per viewer or channel, not a fact about the artifact's shape; putting it on
  `Blueprint` would make one artifact answer a question ("who may see this") that varies by who
  is asking. That resolution is [roadmap slice 7](../requirements/2026-09-22-blueprint-ir-2-design.md#7-roadmap--every-capability-with-its-reference-example).
- **No status for a widget without a binding.** `status` lives under `binding.status`; a widget
  with no `binding` has no value to be pending, stale or in error about, so it has no status
  channel to declare.

## Consequences

- `BLUEPRINT_IR_VERSION` is `"2.0.0"`. Readers written against 1.0.0 keep working: `asCell`
  normalises every grid child, a missing `binding.status` or `source` resolves to no channel and
  no attribute, and an absent `irVersion` reads as `"1.0.0"`. Writers — `blueprint$`, `grid`,
  `cell` — always emit 2.0.0 artifacts from here on.
- **Content addresses of re-emitted artifacts change.** Calling `upgradeBlueprint` on a stored
  1.0.0 artifact, or simply re-composing it through `blueprint$`, produces a new artifact whose
  address differs from the old one; the old artifact is that new one's parent, exactly as any
  other structural edit is. Nothing already written to a store is rewritten in place.
- **loom-ui's follow-up PR deletes its workarounds.** `SPAN_PROP` and the `props.span` emission,
  `handleFromPath`'s use as a status side channel (a `hydrationStatusPath`/`handleFromStatusPath`
  pair keeps hydration's own internal use, unexported), and the terminal adapter's `withStatus`
  wrapper are all retired once loom-ui's compiler emits `GridCell`, `binding.status` and
  `binding.sensitivity` directly and its adapters read the Blueprint alone. That PR is out of
  this ADR's scope; this ADR is what makes it possible.
- **Seven new `validateBlueprint` codes**, findings rather than throws, matching [ADR
  0088](0088-blueprint-conformance.md)'s "a composer must be able to degrade and record a gap
  rather than lose the surface": `span-out-of-range`, `columns-invalid`, `malformed-node`,
  `status-path-invalid`, `sensitivity-unknown`, `source-invalid`, `ir-version-unknown`.
  `props.span` continues to fire `undeclared-prop` — the field is retired from `props`, not made
  legal there. Two of them keep the report honest about a defect's SIZE and the walk's totality:
  a grid whose `columns` is not a positive integer reports `columns-invalid` once and its cells'
  spans are then not checked (otherwise one bad `columns` invents a `span-out-of-range` per
  child), and a layout child that is neither a `Widget` nor a `Layout` — a stray `null`, a
  string, a `GridCell` stranded outside a grid — is `malformed-node` and the walk continues, so
  a model-composed artifact can never make `validateBlueprint` throw.
- `@loom/plugin-renderer-react` exports `WidgetFrame` (the matrix wrapper) and `useWidgetSlice`
  (a fiber selector over `{ value, status }` together, so a status-only change re-renders a
  widget without forcing a value-only render to pay for it, and vice versa). A grid child gains
  a wrapper element ONLY when its span exceeds 1, where it carries `gridColumn: span N`;
  span-1 children — and therefore every 1.0.0 grid — are DOM-identical to 1.0.0 and still
  reconcile by widget id.
- **Both renderers take an optional `check(widget, value)`** — `TerminalRenderOptions.check`,
  and the `check` prop on `BlueprintRenderer` (both render paths) and `WidgetFrame`. It is the
  value-contract slot between `error` and `stale`; loom supplies no check of its own.
- `@loom/plugin-renderer-terminal`'s `TerminalWidgetRenderer` becomes `(widget, value, status?) =>
  string`, an additive optional third parameter — every existing two-argument renderer in a
  caller's own registry keeps compiling and keeps its old output for widgets with no status
  channel. `renderBlueprintToString` applies the matrix with `⋯` (pending, and the loading row — a
  declared channel whose value has not arrived renders `⋯ <title>` rather than `<title>: —`),
  `~` (stale) and `✗` (error, finding appended) glyphs, and appends the degraded-from suffix
  from `source` to the first line of a widget's render when present.
- `KERNEL_ABI_VERSION` stays 1.1.0, `EVENT_SCHEMA_VERSION` stays 1.18.0: no event, no fold, no
  syscall changed. `@loom/spec`'s capability registry lists this ADR in `NOT_A_CAPABILITY` for
  the same reason ADR 0096 is there — a declared IR version and two renderer options are a
  contract and an adapter surface, not a runtime subsystem the registry grades.


## Amendment 2026-10-11 — `WidgetSource.redacted` (IR 2.5.0): the Blueprint records the RESULT of an audience decision

**Why.** D4 shipped `DataBinding.sensitivity` as a declared, unenforced fact and D5 kept audience
off the Blueprint. loom-ui's roadmap slice 7 (`audience`: `"viewer" | "broadcast"`) is the
enforcer: its `compile` withholds or redacts a widget whose binding `sensitivity` exceeds what the
surface's audience may see. Without a mark on the artifact, a renderer or downstream consumer
cannot tell "withheld for this audience" from an ordinary widget, and the standing rule applies:
grow the IR (no reserved prop, no side channel). loom-ui slice 7 is the producer; this change is
the IR it needs, and nothing in loom produces it.

**The field.** `WidgetSource.redacted?: true` (additive; `BLUEPRINT_IR_VERSION` 2.4.0 to **2.5.0**,
a MINOR; `WIDGET_SOURCE` gains `redacted: "optional"`; 2.4.0 stays in `IR_VERSIONS_READ_AS_IS`, so
`upgradeBlueprint` is identity on it).

**What `redacted: true` asserts.** The compiler withheld this widget's content for the audience of
the surface it rendered. It is a statement about the artifact's content, not about who is asking.
- Renderers **MUST** draw no value and no label derived from the widget: not `title`, `props`,
  `binding`, the resolved value, any status finding, or `kind`. They **SHOULD** draw the redaction
  marker instead. All three first-party renderers do: `⊘ redacted` (React and DOM:
  `data-binding-state="redacted"` plus a `role="status"` `data-binding-marker="redacted"` element;
  terminal: the line `⊘ redacted`). The marker text is a constant, never data from the widget, and
  no `data-source-*`, `data-degraded`, `data-widget-kind` (the `kind` may itself be sensitive) or
  `title` attribute is emitted for it, on first draw or after an in-place update.
- `describeWidgetStatus` gains the `redacted` tag and puts it **first** in the precedence
  (redacted > error > empty > contract > stale > pending/loading > ready). It is decided before the
  value, the status, the `check`, the `binding`, or a malformed `degradedFrom` is read, so none of
  them can reach a renderer's output; `check` is not called.
- Only `true` is legal. Absent means not redacted; `false` (or anything else) is
  `redacted-invalid`, and renderers treat anything but `true` as not redacted.

**Relation to `degradedFrom` and `binding`: mutually exclusive.** A redacted widget has **no
`binding`** and **no `source.degradedFrom`**. A binding leaves the projection id and path (what was
withheld) on the artifact; a degrade chain leaves the original semantic types. `validateBlueprint`
enforces this with the new error `redacted-invalid` (also raised for a non-`true` value; an explicit
`redacted: undefined` is absent). The same rule keeps a redacted widget out of the renderers'
projection subscriptions: the React fiber path skips the subscription and the state read for it even
when an unvalidated widget still carries a binding.

**What a redacted placeholder carries.** `source.type` and `source.version` stay required (the
shape contract is unchanged), but the original type may itself be sensitive (`SalaryTrend` says a
great deal), so the compiler sets the generic constants `{ type: "redacted", version: "1",
redacted: true }`. The rest is exactly today's loom-ui placeholder: an opaque `r_` alias id, the
same grid cell, no binding, no label, no original props. Which `kind` a placeholder uses is the
compiler's (loom-ui uses its `Note`); renderers never draw it, and a catalogue must declare it for
`validateBlueprint` to walk it (an unknown kind is `unknown-kind`, unchanged).

**D5 holds.** The Blueprint has no `audience` field and gains none (the manifests are asserted
free of it). `redacted` records the RESULT of resolving audience for one rendered surface; the
question ("who may see this") still varies by viewer and channel and lives in the compiler. Two
artifacts compiled for different audiences differ in content, hence in content address, as any
two different compositions do.

**Still not enforced by loom.** `sensitivity` remains declared-not-enforced (D4): loom does not
decide what to redact, it carries and draws the decision. A renderer cannot tell a legitimately
redacted widget from a forged one; the guarantee that the withheld content is absent from the
artifact is the compiler's, and `redacted-invalid` checks the leaks a well-formed placeholder
cannot have: a `binding`, a `degradedFrom`, a `title`, any `props`, or a `source.type`/`version`
other than the constants `"redacted"`/`"1"`. The check runs before the unknown-kind return, so a
redacted widget of an unknown kind that still carries data is caught too.
