import { flex, grid, stack } from "@loom/blueprint-runtime";
import { render } from "@testing-library/react";
import React, { type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderReactContainer } from "./renderContainer";

// Regression: container children must carry React keys, or React warns
// "Each child in a list should have a unique key prop" (the eager path keys
// widgets by widget.id, but fiber leaves and nested containers are unkeyed).
// renderReactContainer is the shared choke point, so it keys the whole array.
function childKeys(el: ReactElement): Array<string | null> {
  const kids = (el.props as { children: ReactElement[] }).children;
  return kids.map((k) => k.key);
}

describe("renderReactContainer keys children", () => {
  // Three UNKEYED children — the exact shape that triggered the warning.
  // biome-ignore lint/correctness/useJsxKeyInIterable: intentionally unkeyed — this is the input the code under test is supposed to assign keys to
  const unkeyed = [<div>a</div>, <div>b</div>, <div>c</div>];

  it.each([
    ["grid", grid({ columns: 2, children: [] })],
    ["flex", flex({ direction: "row", children: [] })],
    ["stack", stack({ children: [] })],
  ])("assigns a unique key to every child (%s)", (_name, layout) => {
    const keys = childKeys(renderReactContainer(layout, unkeyed));
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k != null)).toBe(true);
    expect(new Set(keys).size).toBe(3); // unique
  });

  it("preserves an existing key rather than dropping it", () => {
    const keys = childKeys(
      // biome-ignore lint/correctness/useJsxKeyInIterable: intentionally mixed keyed/unkeyed input to verify an existing key is preserved
      renderReactContainer(stack({ children: [] }), [<div key="widget-1">a</div>, <div>b</div>])
    );
    expect(keys.every((k) => k != null)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("renderReactContainer cell spans (IR 2.0.0 grids)", () => {
  const layout = grid({ columns: 8, children: [] });
  type Entry = [id: string, span: number];
  const view = (entries: Entry[]) => {
    const cells = entries.map(([id, span]) => ({
      span,
      child: (
        <span key={id} data-testid={id}>
          {id}
        </span>
      ),
    }));
    return renderReactContainer(
      layout,
      cells.map((c) => c.child),
      cells
    );
  };
  const gridEl = (container: HTMLElement) => container.firstChild as HTMLElement;
  const testIds = (container: HTMLElement) =>
    Array.from(gridEl(container).children).map((e) => e.getAttribute("data-testid"));

  it("emits a span-1 cell DIRECTLY — no wrapper element, so a 1.0.0 grid's DOM is unchanged", () => {
    const { container } = render(
      view([
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ])
    );
    expect(gridEl(container).children.length).toBe(3);
    // The grid's children ARE the widgets themselves, not wrappers around them.
    expect(testIds(container)).toEqual(["a", "b", "c"]);
    expect(
      Array.from(gridEl(container).querySelectorAll<HTMLElement>("*")).every(
        (e) => e.style.gridColumn === ""
      )
    ).toBe(true);
  });

  it("wraps a cell whose span > 1 with style.gridColumn = 'span N'; a span of 1 gets no wrapper", () => {
    const { container } = render(
      view([
        ["a", 1],
        ["b", 8],
      ])
    );
    const a = container.querySelector("[data-testid='a']") as HTMLElement;
    const b = container.querySelector("[data-testid='b']") as HTMLElement;
    expect(b.parentElement?.style.gridColumn).toBe("span 8");
    expect(b.parentElement).not.toBe(gridEl(container)); // wrapped
    expect(a.parentElement).toBe(gridEl(container)); // NOT wrapped
  });

  // The property the wrapper-per-cell version broke: an index key re-identified every cell
  // after a removal, so React threw away the survivors' DOM (and their focus, scroll offset
  // and uncontrolled input state) and built new nodes. Keying by the child's own key — the
  // widget id, on both render paths — is what makes the surviving nodes the SAME nodes.
  it("keeps a cell's identity across a sibling's removal — both the wrapped and the unwrapped case", () => {
    const { container, rerender } = render(
      view([
        ["a", 1],
        ["b", 8],
        ["c", 1],
      ])
    );
    const before = {
      b: container.querySelector("[data-testid='b']") as HTMLElement,
      c: container.querySelector("[data-testid='c']") as HTMLElement,
    };
    expect(testIds(container)).toEqual(["a", null, "c"]); // b's span-8 wrapper carries no testid

    rerender(
      view([
        ["b", 8],
        ["c", 1],
      ])
    ); // the FIRST child is gone

    const after = {
      b: container.querySelector("[data-testid='b']") as HTMLElement,
      c: container.querySelector("[data-testid='c']") as HTMLElement,
    };
    expect(after.b.isSameNode(before.b)).toBe(true); // wrapped, span 8
    expect(after.c.isSameNode(before.c)).toBe(true); // unwrapped, span 1
    expect(after.b.parentElement?.style.gridColumn).toBe("span 8");
  });

  it("an UNKEYED cell child (a nested container) still renders without a React key warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cells = [
        { span: 1, child: <div data-testid="nested-1" /> },
        { span: 4, child: <div data-testid="nested-2" /> },
      ];
      render(
        renderReactContainer(
          layout,
          cells.map((c) => c.child),
          cells
        )
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
