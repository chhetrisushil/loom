import type { Layout } from "@loom/blueprint-runtime";
import { Children, type ReactElement, type ReactNode } from "react";

// Shared container rendering used by BOTH the eager and fiber render paths, so
// their layout output stays byte-identical. Extracted verbatim from the original
// BlueprintRenderer container branch.
//
// `cells` (grid only, IR 2.0.0): each child paired with the column span it
// occupies. When given, a cell is wrapped in a `<div>` carrying
// `style.gridColumn = "span N"` for N > 1 (a span of 1 needs no such style —
// the grid's implicit auto-placement already gives it one column). Cell
// wrappers are keyed by index: `traverseBlueprint` builds `cells` fresh on
// every render in stable child order, so an index key is safe here the same
// way `Children.toArray` below is safe for the non-cells path.
export function renderReactContainer(
  layout: Layout,
  children: ReactNode[],
  cells?: Array<{ span: number; child: ReactNode }>
): ReactElement {
  // Key the child array so React does not warn about missing keys. The eager path
  // keys widget leaves by widget.id, but the fiber path's leaves and nested
  // containers (both paths) are unkeyed; Children.toArray assigns stable keys to
  // all of them (preserving any existing key) without changing the rendered DOM.
  const items =
    layout.type === "grid" && cells !== undefined
      ? cells.map((c, i) => (
          <div key={i} style={c.span > 1 ? { gridColumn: `span ${c.span}` } : undefined}>
            {c.child}
          </div>
        ))
      : Children.toArray(children);

  if (layout.type === "grid") {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
          ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
        }}
      >
        {items}
      </div>
    );
  }
  if (layout.type === "flex") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: layout.direction,
          ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
        }}
      >
        {items}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
      }}
    >
      {items}
    </div>
  );
}
