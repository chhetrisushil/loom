# @loomwork/plugin-renderer-react — render a Blueprint with React

React components and hooks that draw a Loom `Blueprint` (the widget layout that `blueprint$` builds)
from a `ProjectionRuntime`. `BlueprintRenderer` subscribes to the projections the blueprint binds to and
re-renders as they change; `LoomProvider` carries the runtimes and can seed projection state from
server-rendered data so the first paint has no empty flash. Use it for a React front end over an
agent's surface. Needs `react` and `react-dom` 18 as peer dependencies.

```tsx
import { MetricCard, blueprint$, stack } from "@loomwork/blueprint-runtime";
import { BlueprintRenderer } from "@loomwork/plugin-renderer-react";
import type { ProjectionRuntime } from "@loomwork/projection-runtime";

const bp = blueprint$({
  id: "ops",
  title: "Ops",
  layout: stack({
    children: [MetricCard({ title: "CPU %", binding: { projectionId: "metrics", path: "cpu" } })],
  }),
  projections: ["metrics"],
});

export function Dashboard(props: { projectionRuntime: ProjectionRuntime; executionId: string }) {
  return (
    <BlueprintRenderer
      blueprint={bp}
      projectionRuntime={props.projectionRuntime}
      executionId={props.executionId}
      onAction={(action) => console.log(action.type, action.widgetId)}
    />
  );
}
```

## Surface

- **Rendering.** `BlueprintRenderer` (props: `blueprint`, `projectionRuntime`, `executionId`, and
  optionally `registry`, `onAction`, `check`, `fiber`) and `WidgetFrame`, which wraps a widget body in
  the binding-status display.
- **Registry.** `defaultRegistry` has renderers for the eight built-in kinds (MetricCard, Timeline,
  ApprovalCard, StatusBadge, StreamingText, ProgressBar, DataTable, AlertCard). `RendererRegistry` lets
  you add or replace one. Of the built-in components, `MetricCardRenderer`, `TimelineRenderer`,
  `ApprovalCardRenderer`, `StatusBadgeRenderer` and `StreamingTextRenderer` are exported individually.
- **Context.** `LoomProvider` (with `serializedExecutionState` and `serializedProjectionState` for
  hand-off from a server) and `useLoom`.
- **Hooks.** `useProjection`, `useDeferredProjection`, `useWidgetValue`, `useDeferredWidgetValue`,
  `useWidgetSlice` and `useAgentSurface`. The `Deferred` variants mark streamed updates as non-urgent.

## Behaviour that surprises people

- **A kind with no renderer shows a placeholder.** The text is `[No renderer for <kind>]`. The default
  registry covers the built-ins, and a custom widget kind needs your own registered renderer.
- **Render-side fiber features are opt-in.** `fiber` (granular updates, suspense, deferred streaming)
  defaults to off, and can be set per renderer or as a default on `LoomProvider`.
- **The value check is yours.** `check` runs only for widgets whose binding declares a status channel,
  after a delivery error or empty state, and a finding renders as the error row. Loom does not
  validate a bound value.
- **A widget with neither a status channel nor a `source` gets no extra wrapper element.** That keeps
  the DOM of an older artifact unchanged.
- **`useLoom` throws outside a `LoomProvider`;** `BlueprintRenderer` itself works without one.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0097](../../docs/adr/0097-blueprint-ir-2.md): the status matrix and the value-check slot.
- Siblings: [`@loomwork/plugin-renderer-terminal`](../renderer-terminal/README.md) and
  `@loomwork/plugin-renderer-dom` (no framework).
- API reference: section "`@loomwork/plugin-renderer-react`" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
