# ADR 0098 — Blueprint IR 2.1.0: cell placement and layout titles

- Status: **Accepted — implemented** (2026-09-23)
- Date: 2026-09-23
- Implements: §2.1 ("A") of the [loom-ui slice 6 design](../requirements/2026-09-23-genui-migration-design.md)
  (loom PR #439) — genUI migrating onto loom-ui.
- Builds on: [ADR 0096](0096-blueprint-stable-rendering-ir.md) (the version pin, and D2's
  major/minor rule this bump follows), [ADR 0097](0097-blueprint-ir-2.md) (the `GridCell` edge
  this ADR adds placement to), [ADR 0088](0088-blueprint-conformance.md) (`validateBlueprint`,
  extended with one code).
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** `BLUEPRINT_IR_VERSION`
  2.0.0 → 2.1.0.

## Context

genUI's dashboards are free-placed — every component has `position { x, y, w, h }` on a grid —
and its views are titled. loom-ui compiles to the Blueprint, and genUI is migrating onto loom-ui,
so both facts have to reach loom's IR: a `GridCell` carries only `span` (a width, placed by the
grid's auto-flow) and no `Layout` carries a heading. The standing ruling is to grow the IR rather
than smuggle a field through `props` or a side channel ([ADR 0097](0097-blueprint-ir-2.md)'s
Context records what the last workaround cost), so this ADR grows it.

## Decisions

### D1 — Placement lives on the `GridCell` edge, three independent optional fields

`GridCell` gains `row?`, `rowSpan?` and `column?`. They are 1-based grid lines, the same
coordinates as CSS grid and as `GridLayout.columns`: the cell occupies columns
`column..column+span-1` and rows `row..row+rowSpan-1` (`rowSpan` defaults to 1). `span` keeps its
2.0.0 meaning — width — so genUI's `w` is `span`, not a new field. Each field is independently
optional; all absent is flow placement, exactly as under 2.0.0. The fields go on the cell for the
reason ADR 0097 D1 put `span` there: a position is a fact about the edge from a grid to its
child, not about the child, and a `flex`/`stack` child has no grid to be placed in.

`cell(span, node, placement?)` writes only the placement keys it is given; `asCell` already
returns a real cell unchanged, so placement survives `grid()` and `upgradeBlueprint`.
`traverseBlueprint` passes the fields through `ContainerContext.cells` (present only when set).
`traverseBlueprintAsync` has no `cells` surface, as before.

### D2 — Every `Layout` gains an optional `title`

A section heading is a property of the container it heads. A heading *widget* was rejected: it
would need a `binding: "none"` entry in every catalogue that composes a titled view, and it would
be a sibling of the section rather than attached to it, which is the relationship a screen
reader needs. `grid`/`flex`/`stack` take `title?` and omit the key when it is absent.

### D3 — A minor bump, and 2.0.0 artifacts are read as they are

All four fields are optional, which is [ADR 0096 D2](0096-blueprint-stable-rendering-ir.md#d2--the-shape-is-guarded-twice-because-each-guard-fails-a-different-way)'s
**minor** case: `BLUEPRINT_IR_VERSION` becomes `2.1.0`, `BLUEPRINT_IR_SHAPE` gains the keys, and
`irVersion.test.ts` pins a third digest beside the frozen `1.0.0` and `2.0.0` rows. A 2.0.0
artifact is already a valid 2.1.0 artifact, so:

- `validateBlueprint` knows `2.0.0` as well as `2.1.0` (otherwise every stored 2.0.0 artifact
  would suddenly report `ir-version-unknown`);
- `upgradeBlueprint` is identity on 2.0.0 input, not only on the current version: re-stamping it
  would change its content address with no change to its shape. It still wraps and stamps a
  1.0.0 artifact.

Writers (`blueprint$`) stamp `2.1.0` from here on.

### D4 — What each renderer does with them

- **React** (`renderReactContainer`, shared by the eager and fiber paths): a placed cell is
  wrapped even at span 1, with `gridColumn: "<column> / span <span>"` (or `span <span>`) and
  `gridRow: "<row> / span <rowSpan ?? 1>"` (or `span <rowSpan>`, or nothing); the wrapper keeps
  the child's key, so a sibling's removal does not rebuild it. A layout with a non-empty string
  title renders `<section><h2>…</h2><div …/></section>`, the layout style staying on the inner
  element so the heading is not a grid item. Always `h2`: the blueprint title is the `h1`, and a
  container has no depth to derive a level from.
- **Terminal** (`renderBlueprintToString`): a one-column surface honours placement as reading
  order — cells sort by row, then column, an absent coordinate after every present one, ties in
  document order. A title prints on its own line, underlined with `─`.
- An unplaced, untitled artifact renders byte-identical (terminal) and DOM-identical (React) to
  2.0.0 on both.

### D5 — One new finding: `placement-out-of-range`

A model-composed artifact can place a cell off the grid. `validateBlueprint` reports, once per
cell, a `row`, `rowSpan` or `column` that is not a positive integer, a `column` past `columns`,
and a `column + span - 1` that overflows the grid. It never cascades: an invalid `span` is
reported only as `span-out-of-range`, and `columns-invalid` still suppresses every cell check of
its grid.

### D6 — What this does not do

- **No overlap check.** CSS grid draws overlapping cells; detecting them needs an occupancy map
  per grid, and genUI's positions come from an editor that already prevents them.
- **No upper bound on `row`.** A grid grows implicit rows.
- **No finding for a malformed `title`.** A renderer draws a title only when it is a non-empty
  string; the migration's need was placement, and a new code is added when a consumer needs it.
- **No placement or title on the `Blueprint` itself.** It already has a `title`.

## Consequences

- `BLUEPRINT_IR_VERSION` is `"2.1.0"`. Every reader written against 2.0.0 keeps working: the new
  fields are optional and absent on every existing artifact.
- Newly authored blueprints are stamped `2.1.0`, so re-composing content identical to an earlier
  `2.0.0` emission yields a different content address; stored `2.0.0` artifacts are unaffected
  and keep the address they were stamped with. loom-ui's exact `"2.0.0"` pin is adapted, not
  removed, in its phase-1 `LOOM_REF` bump.
- loom-ui's `packages/core/src/blueprintIr.test.ts` pins `"2.0.0"` and goes red when loom-ui
  bumps its `LOOM_REF` past this ADR. That is the intended signal: the same PR teaches loom-ui's
  `compile` to emit placement and titles (phase 1 of the slice 6 design).
- `KERNEL_ABI_VERSION` stays 1.1.0 and `EVENT_SCHEMA_VERSION` stays 1.18.0. `@loom/spec` lists
  this ADR in `NOT_A_CAPABILITY`, for the same reason as 0096 and 0097: an IR contract and
  renderer behaviour, not a runtime subsystem to grade.
- `IR_VERSIONS_READ_AS_IS` must gain the outgoing version (`2.1.0`) on every future minor bump,
  the same way it gained `2.0.0` here — the list is how a future reader stays backward-compatible
  with everything this ADR did not just deprecate.
