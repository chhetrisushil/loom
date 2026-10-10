# @loom/plugin-renderer-dom

A framework-free DOM renderer for loom Blueprints: the web sibling of `@loom/plugin-renderer-react` and `@loom/plugin-renderer-terminal`. No React, no Lit, no loom-ui, no runtime dependency beyond `@loom/blueprint-runtime` and `@loom/projection-runtime`. Design and decisions: [ADR 0127](../../docs/adr/0127-plugin-renderer-dom.md).

```ts
import { mountBlueprint } from "@loom/plugin-renderer-dom";

const handle = mountBlueprint(document.getElementById("app")!, blueprint, {
  projectionRuntime,
  executionId,
  onAction: (a) => submit(a), // { type: "APPROVE", widgetId, payload: { approved: true } }
});

const report = handle.update(revisedBlueprint); // keyed reconcile: matching widgets keep their DOM node;
// report.outcome is "updated" | "recovered" | "failed" | "busy" | "disposed" (+ report.error)
handle.dispose();
```

- `renderBlueprintToDom(blueprint, stateMap, options?)` renders once (not live), like `renderBlueprintToString`.
- `mountBlueprint(host, blueprint, { projectionRuntime, executionId, ... })` subscribes each bound projection and re-draws only the widgets whose value or status changed.
- `defaultDomRegistry` covers the eight built-in kinds (`MetricCard`, `Timeline`, `ApprovalCard`, `StatusBadge`, `StreamingText`, `ProgressBar`, `DataTable`, `AlertCard`); add your own with `defaultDomRegistry.merge(new RendererRegistry().register("Kind", ({ doc, widget, value }) => h(doc, "div", {}, String(value))))`.
- The canonical binding-status matrix, `source` degradation, titled layouts and grid placement follow the React renderer. `Layout.role` is ignored.

## Security

Every element is built through `h()`; a string child is a text node, and the package contains no `innerHTML`. Tags and attributes are allowlisted (`script`, `iframe`, `on*` and `style` throw), `href` goes through `safeUrl` (`http`, `https`, `mailto`, `tel` or relative; `javascript:` and its disguises dropped), and data never authors a class, attribute name or inline style. Use `h` in custom renderers to inherit this.

## Styling

No CSS ships. Class names (`metric-value`, `badge--ready`, `alert--error`, `progress-track`, ...) and `data-*` attributes (`data-widget-id`, `data-widget-kind`, `data-binding-state`, `data-layout`) are the contract.
