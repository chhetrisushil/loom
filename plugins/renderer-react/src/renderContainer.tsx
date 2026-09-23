import { type Layout, isLayoutId } from "@loom/blueprint-runtime";
import {
  type CSSProperties,
  Children,
  Fragment,
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
// falling back to the index only for an unkeyed child (a nested container
// without an id), where there is no identity to preserve in the first place.
// Since IR 2.4.0 a bare span-1 cell is carried by a keyed <Fragment> under the
// same `cellKey` — still no element of its own, so property 1 holds (see the
// disjoint-prefix note at `cellKey`).
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
//
// IR 2.4.0 (ADR 0101) adds `Layout.id`, which this renderer USES as the React key of the element
// it returns (the <div>, or the <section> when titled). Without it a nested container reaches its
// parent unkeyed and `Children.toArray` gives it an INDEX key, so inserting a container mid-list
// (or reordering) matched every later container to a different step and re-created its widgets —
// typed input and focus lost. `Children.toArray` keeps an existing key, and every grid cell
// (wrapper or keyed Fragment) inherits the child's key through `cellKey`, so the id reaches React
// on every path. Validity is `isLayoutId`, the one spelling of the rule. It is a key, never markup: the DOM is identical with or without it. Absent or malformed
// (not a non-empty string) ⇒ no key, and React keys by index exactly as before.
//
// Grid cell keys live under two DISJOINT prefixes: `k:<key>` for a child that carries a key (a
// widget id, a layout id) and `i:<index>` for one that does not. A layout id is any non-empty
// string, so it can be "1" — exactly what a bare index key stringifies to; without the prefixes a
// container `id: "1"` beside an unkeyed cell at index 1 collided (a duplicate-key warning, and the
// misreconcile layout ids exist to prevent). A span-1 cell is wrapped in a keyed <Fragment>, which
// renders no element, so the DOM is unchanged.
const cellKey = (child: ReactNode, index: number): string =>
  isValidElement(child) && child.key !== null ? `k:${child.key}` : `i:${index}`;

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
              <Fragment key={cellKey(c.child, i)}>{c.child}</Fragment>
            )
          )
        )
      : Children.toArray(children);

  const id: unknown = (layout as { id?: unknown }).id;
  const key = isLayoutId(id) ? id : undefined;
  const title = typeof layout.title === "string" && layout.title !== "" ? layout.title : undefined;
  if (title === undefined) {
    return (
      <div key={key} style={layoutStyle(layout)}>
        {items}
      </div>
    );
  }
  const body = <div style={layoutStyle(layout)}>{items}</div>;
  return (
    <section key={key} aria-label={title}>
      <h2>{title}</h2>
      {body}
    </section>
  );
}
