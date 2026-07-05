import { flex, grid, stack } from "@loom/blueprint-runtime";
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
      renderReactContainer(stack({ children: [] }), [<div key="widget-1">a</div>, <div>b</div>])
    );
    expect(keys.every((k) => k != null)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });
});
