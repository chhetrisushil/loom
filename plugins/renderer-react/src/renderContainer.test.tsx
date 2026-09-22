import { flex, grid, stack } from "@loom/blueprint-runtime";
import { render } from "@testing-library/react";
import React, { type ReactElement } from "react";
import { describe, expect, it } from "vitest";
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
  it("wraps a cell whose span > 1 with style.gridColumn = 'span N'; a span of 1 gets no such style", () => {
    const layout = grid({ columns: 8, children: [] });
    const cells = [
      { span: 1, child: <span data-testid="a">a</span> },
      { span: 8, child: <span data-testid="b">b</span> },
    ];
    const { container } = render(
      renderReactContainer(
        layout,
        cells.map((c) => c.child),
        cells
      )
    );
    const a = container.querySelector("[data-testid='a']") as HTMLElement;
    const b = container.querySelector("[data-testid='b']") as HTMLElement;
    expect(b.parentElement?.style.gridColumn).toBe("span 8");
    expect(a.parentElement?.style.gridColumn).toBe("");
  });
});
