import type { Layout } from "@loom/blueprint-runtime";
import { Children, type ReactElement, type ReactNode, isValidElement } from "react";

// Shared container rendering used by BOTH the eager and fiber render paths, so
// their layout output stays byte-identical. Extracted verbatim from the original
// BlueprintRenderer container branch.
//
// `cells` (grid only, IR 2.0.0): each child paired with the column span it
// occupies. A cell gains a wrapper `<div style={{ gridColumn: "span N" }}>`
// ONLY when N > 1. A span of 1 needs no style — the grid's implicit
// auto-placement already gives it exactly one column — so it is emitted
// DIRECTLY, with no element of its own. Two properties follow from that, and
// both were broken while every cell got a wrapper:
//
//   1. a 1.0.0 grid (every cell implicitly span 1) renders the DOM it rendered
//      before this IR existed — no interposed div, no changed selector;
//   2. a grid child still reconciles by WIDGET ID. The eager path keys each
//      widget leaf `key={widget.id}` and the fiber path keys each mounted
//      widget the same way; emitting the child directly keeps that key on the
//      element React diffs, so removing a sibling moves the survivors rather
//      than re-creating them. A wrapper keyed by index would have re-keyed
//      every cell after the removed one and thrown away its DOM (and, with it,
//      focus, scroll position and any uncontrolled input state).
//
// A span > 1 wrapper therefore takes the CHILD's key when the child has one,
// falling back to the index only for an unkeyed child (a nested container),
// where there is no identity to preserve in the first place.
const cellKey = (child: ReactNode, index: number): string | number =>
  isValidElement(child) && child.key !== null ? child.key : index;

export function renderReactContainer(
  layout: Layout,
  children: ReactNode[],
  cells?: Array<{ span: number; child: ReactNode }>
): ReactElement {
  // Key the child array so React does not warn about missing keys. The eager path
  // keys widget leaves by widget.id, but the fiber path's leaves and nested
  // containers (both paths) are unkeyed; Children.toArray assigns stable keys to
  // all of them (preserving any existing key) without changing the rendered DOM.
  // The grid path runs through the SAME call — an id-derived key survives it, which
  // is how the non-grid layouts have always reconciled by id.
  const items =
    layout.type === "grid" && cells !== undefined
      ? Children.toArray(
          cells.map((c, i) =>
            c.span > 1 ? (
              <div key={cellKey(c.child, i)} style={{ gridColumn: `span ${c.span}` }}>
                {c.child}
              </div>
            ) : (
              c.child
            )
          )
        )
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
