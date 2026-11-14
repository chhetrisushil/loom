# @loomwork/blueprint-runtime — the Blueprint rendering IR

A Blueprint is a declarative, JSON-serializable description of a screen: a layout (grid, flex, stack) of
widgets, each bound to a path in a projection. This package defines that IR and the framework-agnostic
tools around it: builders, a validator that checks a Blueprint against a catalogue of allowed widgets,
identity and version-pin checks, and a traversal that every renderer is built on. It draws nothing itself;
renderers (`@loomwork/plugin-renderer-terminal`, `@loomwork/plugin-renderer-dom`, `@loomwork/plugin-renderer-react`) read the same Blueprint. Use it to compose
a surface in code, or to check one that a model composed, before rendering or storing it.

```ts
import {
  DataTable,
  MetricCard,
  blueprint$,
  builtinCatalog,
  cell,
  grid,
  validateBlueprint,
} from "@loomwork/blueprint-runtime";

const board = blueprint$({
  id: "db-health",
  title: "Database health",
  projections: ["db"],
  layout: grid({
    columns: 3,
    title: "Overview",
    children: [
      // Give a widget an explicit id if a composer will revise it: the default id hashes the props.
      MetricCard({
        id: "connections",
        title: "Connections",
        binding: { projectionId: "db", path: "connections" },
      }),
      cell(2, DataTable({ id: "slow", title: "Slow queries", binding: { projectionId: "db", path: "slow" } })),
    ],
  }),
});

// A blueprint a model composes is data: check it against the catalogue. Never throws.
const report = validateBlueprint(board, builtinCatalog);
console.log(report.ok, report.widgets, report.findings); // true 2 []
```

## Surface

- **Build.** `blueprint$({ id, title, layout, projections, projectionVersions? })`; layouts `grid`, `flex`,
  `stack` (with `cell(span, node, placement?)` for grid placement); widgets `MetricCard`, `Timeline`,
  `ApprovalCard`, `StatusBadge`, `ProgressBar`, `DataTable`, `AlertCard`, `StreamingText`, and
  `customWidget$` for your own kind.
- **Check.** `validateBlueprint(blueprint, catalog)` returns `{ ok, findings, widgets }`;
  `defineWidgetCatalog`, `builtinCatalog`, `catalogCoverage`. `blueprintNodeIds`, `blueprintLayoutIds` and
  `preservesNodes` report which ids a revision dropped. `blueprintPins` and `checkBlueprintPins` compare
  the projection versions a view recorded with the live ones.
- **Render.** `traverseBlueprint` and `traverseBlueprintAsync`, `RendererRegistry`, `resolveWidgetValue`,
  and `describeWidgetStatus` / `describeWidgetFrame`, the single decision about what a widget shows when its
  binding is pending, stale, empty, errored or redacted.
- **Versioning.** `BLUEPRINT_IR_VERSION` (currently 2.5.0), `upgradeBlueprint`, `blueprintIrVersion`.

## Behaviour that surprises people

- **A default widget id is a hash of its props.** It changes when any prop changes, so a revised widget is
  re-identified, remounted, and loses anything keyed on it. Pass `id` for any widget a composer will edit.
- **The checks report findings and never throw**, so a composer can degrade and record a gap. A report
  with zero `widgets` is not a pass; `widgets` is the denominator.
- **Grid reading order is guaranteed only for fully placed or fully unplaced grids.** If some cells have
  `row` and `column` and others do not, CSS auto-placement (React) and the terminal's absent-last sort can
  disagree (ADR 0098).
- **`empty` is not `error`.** A binding that delivered but has nothing to show is its own state (IR 2.3.0,
  ADR 0100), and a binding's `sensitivity` is read by compilers and delivery, never by renderers.
- **The IR is pinned.** A test pins the shape digest per version; any shape change needs a version bump.
  A Blueprint without `irVersion` reads as 1.0.0, and `upgradeBlueprint` is the identity on 2.0.0 through
  2.5.0.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/blueprint-runtime` — declarative UI" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [composed surfaces](../../docs/composed-surfaces.md), [user guide, section 6: projections and agent surfaces](../../docs/user-guide.md#6-projections--agent-surfaces).
- ADRs: [0088 blueprint conformance](../../docs/adr/0088-blueprint-conformance.md), [0094 node identity](../../docs/adr/0094-blueprint-node-identity.md), [0095 binding-semantics pin](../../docs/adr/0095-binding-semantics-pin.md), [0096 stable rendering IR](../../docs/adr/0096-blueprint-stable-rendering-ir.md), [0098 placement and titles](../../docs/adr/0098-blueprint-ir-placement-and-titles.md), [0100 empty state](../../docs/adr/0100-blueprint-ir-empty-binding-state.md).
- Source: `packages/blueprint-runtime/src`.
