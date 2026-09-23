import type { Layout } from "@loom/blueprint-runtime";
import {
  type CSSProperties,
  Children,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from "react";

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
//
// IR 2.1.0 (ADR 0098) adds two things, neither of which changes an unplaced, untitled
// artifact's DOM:
//
//   * a PLACED cell (any of row / rowSpan / column set) is wrapped even at span 1, because its
//     position is exactly the "something to say" a wrapper exists for; the wrapper keeps the
//     child's key, so identity survives a sibling's removal as above;
//   * a layout with a non-empty string `title` renders as <section aria-label={title}><h2/><div …/></section>.
//     The grid/flex style stays on the inner <div>, so the heading is never a grid item. Always
//     h2: the blueprint title is the h1, and a container has no depth to derive a level from.
//     `aria-label` is what makes it a landmark at all: per HTML-AAM, a <section> does not take
//     its accessible name from content, so an unlabelled one (the <h2> notwithstanding) maps to
//     role `generic`, not `region`. The explicit label names the region.
//
// IR 2.2.0 (ADR 0099) adds `Layout.role`, which this renderer deliberately IGNORES: a role is a
// key into a container-renderer registry, and React has none, so every role draws the plain
// container above — DOM-identical to the same layout without one. It is never an ARIA role.
const cellKey = (child: ReactNode, index: number): string | number =>
  isValidElement(child) && child.key !== null ? child.key : index;

type Cell = { span: number; row?: number; rowSpan?: number; column?: number; child: ReactNode };

const isPlaced = (c: Cell): boolean =>
  c.row !== undefined || c.rowSpan !== undefined || c.column !== undefined;

function cellStyle(c: Cell): CSSProperties {
  const style: CSSProperties = {
    gridColumn: c.column !== undefined ? `${c.column} / span ${c.span}` : `span ${c.span}`,
  };
  if (c.row !== undefined) style.gridRow = `${c.row} / span ${c.rowSpan ?? 1}`;
  else if (c.rowSpan !== undefined) style.gridRow = `span ${c.rowSpan}`;
  return style;
}

function layoutStyle(layout: Layout): CSSProperties {
  const gap = layout.gap !== undefined ? { gap: `${layout.gap}px` } : {};
  if (layout.type === "grid") {
    return { display: "grid", gridTemplateColumns: `repeat(${layout.columns}, 1fr)`, ...gap };
  }
  if (layout.type === "flex") return { display: "flex", flexDirection: layout.direction, ...gap };
  return { display: "flex", flexDirection: "column", ...gap };
}

export function renderReactContainer(
  layout: Layout,
  children: ReactNode[],
  cells?: Cell[]
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
            c.span > 1 || isPlaced(c) ? (
              <div key={cellKey(c.child, i)} style={cellStyle(c)}>
                {c.child}
              </div>
            ) : (
              c.child
            )
          )
        )
      : Children.toArray(children);

  const body = <div style={layoutStyle(layout)}>{items}</div>;
  const title = typeof layout.title === "string" && layout.title !== "" ? layout.title : undefined;
  if (title === undefined) return body;
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {body}
    </section>
  );
}
