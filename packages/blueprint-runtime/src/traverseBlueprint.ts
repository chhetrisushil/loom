import type { Layout, Widget, WidgetAction, WidgetRendererProps } from "./types";

// ── Context types ─────────────────────────────────────────────────────────────

export interface ContainerContext<TNode> {
  layout: Layout;
  children: TNode[];
}

// ── Value resolution ──────────────────────────────────────────────────────────

// Resolve a dot-path (e.g. "a.b.c") against a projection state. Null-safe and
// generic — no widget/UI coupling — so any live rendering surface can build a
// slice selector for `ProjectionRuntime.subscribeSelector` without duplicating
// this traversal (see useWidgetValue). An empty path binds to the whole state.
export function resolvePath(state: unknown, path: string): unknown {
  // An empty path binds the widget to the whole projection surface (the root),
  // not a nested field — otherwise `"".split(".")` yields `[""]` and dereferences
  // a non-existent "" key, silently returning undefined.
  if (path === "") return state;
  const parts = path.split(".");
  let current: unknown = state;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveWidgetValue(widget: Widget, stateMap: Map<string, unknown>): unknown {
  if (!widget.binding) return undefined;
  const state = stateMap.get(widget.binding.projectionId);
  return resolvePath(state, widget.binding.path);
}

// ── traverseBlueprint ─────────────────────────────────────────────────────────
//
// Framework-agnostic recursive tree walker. Given a blueprint layout node and a
// projection state map, walks the tree calling `renderWidget` for leaf nodes and
// `renderContainer` for layout nodes. Returns a single TNode representing the
// whole subtree — whatever type makes sense for the target framework:
//   React:    traverseBlueprint<React.ReactNode>(...)
//   DOM:      traverseBlueprint<HTMLElement>(...)
//   string:   traverseBlueprint<string>(...)  // server-side HTML
//
// Example (plain DOM adapter):
//   const el = traverseBlueprint<HTMLElement>(blueprint.layout, stateMap, {
//     renderWidget({ widget, value, onAction }) {
//       const div = document.createElement("div");
//       div.dataset.widgetId = widget.id;
//       div.textContent = String(value ?? "—");
//       return div;
//     },
//     renderContainer({ layout, children }) {
//       const div = document.createElement("div");
//       div.style.display = layout.type === "flex" ? "flex" : "grid";
//       children.forEach(c => div.appendChild(c));
//       return div;
//     },
//   });

export interface BlueprintTraversalOptions<TNode> {
  renderWidget: (ctx: WidgetRendererProps) => TNode;
  renderContainer: (ctx: ContainerContext<TNode>) => TNode;
  onAction?: (action: WidgetAction) => void;
}

export function traverseBlueprint<TNode>(
  node: Layout | Widget,
  stateMap: Map<string, unknown>,
  options: BlueprintTraversalOptions<TNode>
): TNode {
  const { renderWidget, renderContainer, onAction } = options;

  if ("_tag" in node && node._tag === "Widget") {
    const widget = node as Widget;
    return renderWidget({
      widget,
      value: resolveWidgetValue(widget, stateMap),
      ...(onAction !== undefined && { onAction }),
    });
  }

  const layout = node as Layout;
  const children = layout.children.map((child) =>
    traverseBlueprint(child as Layout | Widget, stateMap, options)
  );

  return renderContainer({ layout, children });
}
