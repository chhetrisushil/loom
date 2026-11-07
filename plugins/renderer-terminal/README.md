# @loom/plugin-renderer-terminal — draw a Blueprint as plain text

Renders a Loom `Blueprint` (the widget layout that `blueprint$` builds) to a string, so the same view an
app shows in a browser can be printed in a terminal, a log or a test snapshot. It walks the blueprint
with the framework-agnostic `traverseBlueprint` and applies the shared binding-status rules, so
pending, stale, error and empty widgets read the same way they do in the React and DOM renderers.
Use it for CLIs, TUIs and golden-file tests of a view.

```ts
import { MetricCard, StatusBadge, blueprint$, stack } from "@loom/blueprint-runtime";
import { defaultTerminalRegistry, renderBlueprintToString } from "@loom/plugin-renderer-terminal";

const bp = blueprint$({
  id: "ops",
  title: "Ops Dashboard",
  layout: stack({
    children: [
      StatusBadge({ title: "Phase", binding: { projectionId: "ui", path: "phase" } }),
      MetricCard({ title: "CPU %", binding: { projectionId: "metrics", path: "cpu" }, unit: "%" }),
    ],
  }),
  projections: ["ui", "metrics"],
});

// One projection state per projection id the blueprint names.
const state = new Map<string, unknown>([
  ["ui", { phase: "triaging" }],
  ["metrics", { cpu: 87 }],
]);

console.log(renderBlueprintToString(bp, state, { registry: defaultTerminalRegistry }));
```

## Surface

- **`renderBlueprintToString(blueprint, stateMap, options?)`** is a one-shot render of values you
  already have.
- **`TerminalRenderer(projectionRuntime, options?)`** with `render(blueprint, executionId)` reads each
  of the blueprint's projections from a `ProjectionRuntime`, then renders.
- **`defaultTerminalRegistry`** covers the eight built-in widget kinds. `RendererRegistry` is
  re-exported for registering your own `TerminalWidgetRenderer`, `(widget, value, status?) => string`.
- **Options.** `registry` and `check`. `check` is a `WidgetValueCheck` you supply to validate a bound
  value; it runs only for widgets whose binding declares a status channel, and a finding renders as the
  error row. Loom validates nothing about the value itself.

## Behaviour that surprises people

- **Without a `registry` it is kind-blind.** Every widget prints as `title: value`, and an unknown kind
  is not noticed. With a registry, a kind it lacks is prefixed `[kind]` so the gap is visible.
- **It is not live.** Output is a string for one moment; re-render to update. For live updates use the
  DOM or React renderer.
- **Layout hints are partly ignored.** Placed grid cells print in reading order (row, then column), and
  a titled layout prints an underlined heading. `Layout.role` and `Layout.id` have no effect on the text.
- **A widget with no status channel and no `source` renders as it did before status existed.** A
  channel adds the glyphs (`⋯` pending or loading, `~` stale, `✗` error, `○` empty), and `source` adds a
  "(degraded from ...)" suffix to the first line.
- **A widget withheld for the surface's audience** prints a constant marker, with no title or value.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0097](../../docs/adr/0097-blueprint-ir-2.md), [ADR 0098](../../docs/adr/0098-blueprint-ir-placement-and-titles.md)
  and [ADR 0099](../../docs/adr/0099-blueprint-ir-layout-roles.md): the status matrix, placement, roles.
- Siblings: [`@loom/plugin-renderer-react`](../renderer-react/README.md) and `@loom/plugin-renderer-dom`.
- API reference: section "`@loom/plugin-renderer-terminal`" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
