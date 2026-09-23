# ADR 0101 — Blueprint IR 2.4.0: layout ids

- Status: **Accepted — implemented** (2026-09-23)
- Date: 2026-09-23
- Implements: the loom half of loom-ui gap G6 (a container keeps its identity across a
  recompose) — genUI migrating onto loom-ui, phase 2.
- Builds on: [ADR 0094](0094-blueprint-node-identity.md) (node identity across a structural
  change, whose walk this ADR extends to containers), [ADR 0096](0096-blueprint-stable-rendering-ir.md)
  (the version pin, and D2's major/minor rule this bump follows),
  [ADR 0099](0099-blueprint-ir-layout-roles.md) (layout roles; this ADR amends its D3 sentence
  "a Layout still has no id", and copies its D4 reasoning for a `warn`),
  [ADR 0100](0100-blueprint-ir-empty-binding-state.md) (the previous minor bump).
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** `BLUEPRINT_IR_VERSION`
  2.3.0 → 2.4.0.

## Context

A renderer that reconciles a recomposed Blueprint against what it has mounted can keep a WIDGET
by its id — `Widget.id` is required — but it has nothing to keep a CONTAINER by. loom-ui's DOM
adapter keys containers by ordinal + `type` + `role` among their container siblings (ADR 0099
D3). So inserting a container mid-list, or reordering containers, shifts every later ordinal:
each shifted container is swept out and mounted fresh, and every widget inside it with it —
typed input and focus are lost. The loss is reported (`remounted`), but it happens. Appending
remounts nothing, which is why the defect hid.

loom's own React renderer has the same defect. A nested container reaches its parent as an
unkeyed element, `Children.toArray` gives it an INDEX key, and inserting a container before a
sibling matches the sibling's old subtree to the new container: React re-creates the sibling's
widgets.

loom-ui's core already has a stable container id (`ContainerNode.id`); its `compile` has no
`Layout` field to carry it into the Blueprint. ADR 0099's context rejected a layout id because
it would be "a second identity axis that `preservesBlueprintNodes` (ADR 0094) does not cover".
This ADR answers that objection by making it the SAME axis: the identity walk covers layout ids.

## Decisions

### D1 — Every `Layout` gains an optional `id`, with `Widget.id`'s rule

`GridLayout`, `FlexLayout` and `StackLayout` gain `id?: string`. The `grid()`/`flex()`/`stack()`
builders take it and omit the key when it is absent.

The rule is **the same as `Widget.id`: a non-empty string. No charset, no length cap.** loom-ui's
`NodeId` is `z.string().min(1)`; a stricter loom rule would force its `compile` to drop ids its
own schema accepts, splitting one rule in two. Unlike a role (ADR 0099 D2), an id is never a
registry-object key, a CSS selector or a DOM attribute — a renderer uses it only as a `Map` key
or a React key — so `__proto__` or a 10 000-character id is harmless.

`isLayoutId(value: unknown): value is string` is the one spelling of the rule, exported from
`@loom/blueprint-runtime` beside `isLayoutRole`, so a compiler's schema (loom-ui core), a
renderer's keying (loom-ui's DOM adapter, loom's React renderer) and `validateBlueprint` apply
the same predicate and cannot drift apart.

### D2 — One node-id namespace: `duplicate-node-id` spans widgets and layouts

Layout ids and widget ids are one namespace. `validateBlueprint`'s `duplicate-node-id` (error)
now fires for widget↔widget (as before), widget↔layout and layout↔layout collisions, on the
second occurrence in pre-order; its `kind` is `"<layout>"` when that node is a layout. loom-ui
already guarantees this upstream (its `insertNode` refuses a duplicate across all nodes), so its
`compile` gains no new finding.

### D3 — A malformed id is a `layout-id-invalid` warning, and is otherwise ABSENT

An id that is present (not `undefined`) but not a non-empty string — `""`, a number, `null`, an
object — is reported once as **`layout-id-invalid`, a `warn`**. ADR 0099 D4's reasoning holds:
`validateBlueprint` is the only gate a model-composed artifact passes, so an unreported malformed
id would pass silently everywhere; and nothing is lost but state preservation across a recompose,
so `ok` stays `true`.

Everywhere else a malformed id is **absent**: renderers key the container positionally,
`blueprintLayoutIds` skips it, and it collides with nothing (two `""` ids are two warnings, not a
duplicate).

Layout-level findings (`role-invalid`, `columns-invalid`, and `duplicate-node-id` on a layout) set
`nodeId` to the layout's id when it has a well-formed one, and `"<layout>"` otherwise. A
cell-level finding (`span-out-of-range`, `placement-out-of-range`) on a cell wrapping a nested
layout names that layout's id the same way. `layout-id-invalid` itself is always `"<layout>"`.

### D4 — Absent ⇒ today's behaviour, exactly

A layout without an id is keyed positionally by every renderer, exactly as under 2.3.0, and its
bytes — hence its content address — are 2.3.0's (the builders omit the key). Existing blueprints
are byte-identical.

### D5 — The id enters the content address

An id is in the Blueprint's canonical bytes, so it is part of the address. Leaving a field a
renderer acts on out of the address would make the address lie about what renders. A field that
stayed out of the digest was **rejected** as a side channel; so was a separate `key` or
`containerKey` vocabulary, a second identity axis exactly as ADR 0099 objected.

What changes: a Blueprint compiled with ids, from the next recompile on — the ids plus the
2.4.0 stamp — the same effect every minor bump already has. What does not: loom-ui addresses the
Experience it compiles FROM, and container ids are already inside it; stored blueprints are never
rewritten and keep their addresses.

### D6 — The identity walk covers layout ids (the same axis, not a second one)

- **`blueprintLayoutIds(bp)`** (new export): every well-formed layout id, pre-order, the root
  included — the same total, iterative walk as `blueprintNodeIds`.
- **`preservesBlueprintNodes(before, after)`** compares **widget ids ∪ layout ids** in one
  pre-order walk. A re-identified container (a planner re-minting its ids) is a
  `dropped-node-id` finding instead of a silent loss of the user state under it. A `before`
  with no layout ids — any pre-2.4.0 artifact — contributes none, so upgrading only adds to
  `added` and `ok` stays `true`.
- **`blueprintNodeIds` stays widget-only.** Its callers read its output as widget ids
  (renderer-lit's `remountedOf`, the a2ui bridge's `identityDiff`); adding container ids would
  silently change a published function's meaning — **rejected**. Leaving the whole walk
  widget-only was rejected too: ADR 0099's objection would still hold.

This amends ADR 0099 D3's "a Layout still has no id": a Layout may now have one, and it is node
identity. A `role` still is not.

### D7 — loom's renderers: React keys by it, the terminal ignores it

- **React** (`renderReactContainer`) sets `key={layout.id}` on the element it returns (the
  `<div>`, or the titled `<section>`) when the id is well-formed. `Children.toArray` keeps an
  existing key, and the span > 1 grid wrapper already inherits the child's key, so the id
  reaches React on every path — eager and fiber. The rendered DOM is identical with or without
  an id; only reconciliation changes.
- **Grid cell keys are prefixed.** An id may be `"0"` or `"1"` — exactly what an index key
  stringifies to — so a grid cell's key is `k:<child key>` for a keyed child and `i:<index>` for
  an unkeyed one, two disjoint spaces. A span-1 cell (formerly emitted bare) is carried by a keyed
  `<Fragment>`, which renders no element, so the DOM is unchanged. Before the prefixes a span > 1
  wrapper around a container `id: "1"` and an unkeyed wrapper at index 1 shared the key `1`: a
  duplicate-key warning and exactly the misreconcile this ADR fixes. The non-grid path was already
  disjoint (`Children.toArray` writes a key as `.$1`, an index as `.1`); both are pinned. Without an id React keys by index, as before. Pinned: a
  step inserted above a typed-in, focused step keeps the same `<input>` node, its value and focus,
  on both paths, and the same test without ids still re-creates it.
- **Terminal** (`renderBlueprintToString`) ignores it: a one-shot string has nothing to
  reconcile, and its output is byte-identical with or without ids (malformed included).
- Ignoring it in React was **rejected**: it would leave the same defect in loom's own renderer
  for no saving.

### D8 — A minor bump, and 2.3.0 artifacts are read as they are

An optional field on every Layout is ADR 0096 D2's **minor** case. The three layout manifests gain
`id:optional`; `irVersion.test.ts` pins a sixth digest beside the frozen `1.0.0`–`2.3.0` rows.
`IR_VERSIONS_READ_AS_IS` gains `2.3.0`, so `validateBlueprint` knows 2.0.0–2.4.0 and
`upgradeBlueprint` is identity on all five; a 1.0.0 layout carrying an id keeps it when wrapped.
Writers (`blueprint$`) stamp `2.4.0` from here on.

## Consequences

- `BLUEPRINT_IR_VERSION` is `"2.4.0"`. Every artifact written under 2.x is read as it is.
- `BlueprintFindingCode` gains `layout-id-invalid` (warn), and `duplicate-node-id` can now name a
  layout. A consumer that switches exhaustively over the codes sees a new case; one that gates on
  `ok` sees a new error only for a genuinely colliding id.
- `preservesBlueprintNodes` can now report a dropped CONTAINER id. A caller comparing an id'd
  tree against its own earlier id'd tree gets strictly more findings, all of them real losses of
  identity.
- `@loom/blueprint-runtime` exports two new values, `blueprintLayoutIds` and `isLayoutId`. Both
  are part of the IR contract, not vocabulary: they name no container.
- loom-ui's `packages/core/src/blueprintIr.test.ts` pins the IR version it compiles against and
  goes red when loom-ui bumps its `LOOM_REF` past this ADR. That is the intended signal: the same
  PR teaches its `compile` to emit `ContainerNode.id` on every container and its DOM adapter's
  `reconcileContainer` to key by it.
- `KERNEL_ABI_VERSION` stays 1.1.0 and `EVENT_SCHEMA_VERSION` stays 1.18.0. `@loom/spec` lists
  this ADR in `NOT_A_CAPABILITY`, for the same reason as 0096–0100: an IR contract and renderer
  behaviour, not a runtime subsystem to grade.
- The next minor bump adds `2.4.0` to `IR_VERSIONS_READ_AS_IS`.
