import { asCell, isWidget, resolvePath, resolveWidgetStatus } from "./normalize";
import type { Layout, Widget, WidgetAction, WidgetRendererProps } from "./types";

// Re-exported unchanged for existing consumers; it now lives in normalize.ts to avoid an
// import cycle (normalize.ts's `resolveWidgetStatus` needs it, and this module imports
// `asCell`/`isWidget`/`resolveWidgetStatus` from normalize.ts as of Task 2).
export { resolvePath };

// ── Context types ─────────────────────────────────────────────────────────────

export interface ContainerContext<TNode> {
  layout: Layout;
  children: TNode[];
  /** Grid containers only: each child with the columns it occupies (default 1), in order. */
  cells?: Array<{ span: number; child: TNode }>;
}

// ── Value resolution ──────────────────────────────────────────────────────────

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

  if (isWidget(node)) {
    const status = resolveWidgetStatus(node, stateMap);
    return renderWidget({
      widget: node,
      value: resolveWidgetValue(node, stateMap),
      ...(status !== undefined && { status }),
      ...(onAction !== undefined && { onAction }),
    });
  }

  const layout = node;
  if (layout.type === "grid") {
    const cells = layout.children
      .map(asCell)
      .map((c) => ({ span: c.span ?? 1, child: traverseBlueprint(c.node, stateMap, options) }));
    return renderContainer({ layout, children: cells.map((c) => c.child), cells });
  }

  const children = layout.children.map((child) => traverseBlueprint(child, stateMap, options));

  return renderContainer({ layout, children });
}
