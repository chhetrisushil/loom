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

describe("renderReactContainer placement and titles (IR 2.1.0)", () => {
  type Placed = { id: string; span: number; row?: number; rowSpan?: number; column?: number };
  const placedView = (entries: Placed[]) => {
    const cells = entries.map(({ id, ...placement }) => ({
      ...placement,
      child: (
        <span key={id} data-testid={id}>
          {id}
        </span>
      ),
    }));
    return renderReactContainer(
      grid({ columns: 12, children: [] }),
      cells.map((c) => c.child),
      cells
    );
  };
  const wrapperOf = (container: HTMLElement, id: string) =>
    (container.querySelector(`[data-testid='${id}']`) as HTMLElement).parentElement as HTMLElement;

  it("a placed cell is wrapped with an explicit start column and row, even at span 1", () => {
    const { container } = render(
      placedView([
        { id: "a", span: 6, row: 2, column: 7, rowSpan: 3 },
        { id: "b", span: 1, row: 1, column: 1 },
      ])
    );
    expect(wrapperOf(container, "a").style.gridColumn).toBe("7 / span 6");
    expect(wrapperOf(container, "a").style.gridRow).toBe("2 / span 3");
    expect(wrapperOf(container, "b").style.gridColumn).toBe("1 / span 1");
    expect(wrapperOf(container, "b").style.gridRow).toBe("1 / span 1");
  });

  it("rowSpan alone spans rows from the flow position; column alone leaves the row to flow", () => {
    const { container } = render(
      placedView([
        { id: "a", span: 2, rowSpan: 2 },
        { id: "b", span: 1, column: 3 },
      ])
    );
    expect(wrapperOf(container, "a").style.gridColumn).toBe("span 2");
    expect(wrapperOf(container, "a").style.gridRow).toBe("span 2");
    expect(wrapperOf(container, "b").style.gridColumn).toBe("3 / span 1");
    expect(wrapperOf(container, "b").style.gridRow).toBe("");
  });

  it("an unplaced span-1 cell is still emitted directly — 2.0.0 DOM is unchanged", () => {
    const { container } = render(
      placedView([
        { id: "a", span: 1 },
        { id: "b", span: 4, column: 1 },
      ])
    );
    expect(wrapperOf(container, "a")).toBe(container.firstChild);
  });

  // Regression guard (controller ruling, D6 pre-flight): the brief's original fixture used
  // `{ id: "b", span: 3, row: 1, column: 4 }` for this case, but a span > 1 cell was ALREADY
  // wrapped and keyed before IR 2.1.0 — that fixture could not fail before this change. `b` is
  // a PLACED span-1 cell instead, so this test actually exercises the new placement-wrap branch
  // (a span-1 cell wrapped only because it is placed) rather than the pre-existing span-wrap one.
  it("a placed wrapper keeps the child's key, so a sibling's removal does not rebuild it", () => {
    const { container, rerender } = render(
      placedView([
        { id: "a", span: 1 },
        { id: "b", span: 1, row: 1, column: 4 },
      ])
    );
    const before = container.querySelector("[data-testid='b']") as HTMLElement;
    rerender(placedView([{ id: "b", span: 1, row: 1, column: 4 }]));
    const after = container.querySelector("[data-testid='b']") as HTMLElement;
    expect(after.isSameNode(before)).toBe(true);
  });

  it.each([
    ["grid", grid({ columns: 2, title: "Latency", children: [] })],
    ["flex", flex({ title: "Latency", children: [] })],
    ["stack", stack({ title: "Latency", children: [] })],
  ])("a titled %s renders a section whose h2 precedes the layout element", (_n, layout) => {
    const { container } = render(
      renderReactContainer(layout, [
        <span key="x" data-testid="x">
          x
        </span>,
      ])
    );
    const section = container.firstChild as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    expect(section.children).toHaveLength(2);
    expect(section.children[0]?.tagName).toBe("H2");
    expect(section.children[0]?.textContent).toBe("Latency");
    expect(section.children[1]?.querySelector("[data-testid='x']")).not.toBeNull();
  });

  it.each([
    ["grid", grid({ columns: 2, title: "Latency", children: [] })],
    ["flex", flex({ title: "Latency", children: [] })],
    ["stack", stack({ title: "Latency", children: [] })],
  ])("a titled %s's section carries aria-label so it is a named region landmark", (_n, layout) => {
    const { container } = render(renderReactContainer(layout, [<span key="x">x</span>]));
    const section = container.firstChild as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    expect(section.getAttribute("aria-label")).toBe("Latency");
  });

  it("an untitled or empty-titled layout renders no section and no heading", () => {
    for (const layout of [stack({ children: [] }), stack({ title: "", children: [] })]) {
      const { container, unmount } = render(renderReactContainer(layout, [<span key="x">x</span>]));
      expect((container.firstChild as HTMLElement).tagName).toBe("DIV");
      expect(container.querySelector("h2")).toBeNull();
      unmount();
    }
  });

  it("the grid template stays on the inner element, so the heading is not a grid item", () => {
    const { container } = render(
      renderReactContainer(grid({ columns: 3, title: "T", children: [] }), [])
    );
    const inner = (container.firstChild as HTMLElement).children[1] as HTMLElement;
    expect(inner.style.display).toBe("grid");
    expect(inner.style.gridTemplateColumns).toBe("repeat(3, 1fr)");
  });
});

describe("renderReactContainer ignores a layout role (IR 2.2.0, ADR 0099)", () => {
  // React has no container registry: a role is a hint for a renderer that has one. Whatever the
  // role — well-formed, unknown, malformed — the DOM is the plain container's, byte for byte.
  const html = (layout: Parameters<typeof renderReactContainer>[0]) => {
    const { container, unmount } = render(
      renderReactContainer(layout, [<span key="x">x</span>, <span key="y">y</span>])
    );
    const out = container.innerHTML;
    unmount();
    return out;
  };

  it.each([
    [
      "grid",
      (role?: string) => grid({ columns: 2, title: "T", ...(role && { role }), children: [] }),
    ],
    ["flex", (role?: string) => flex({ ...(role && { role }), children: [] })],
    ["stack", (role?: string) => stack({ title: "T", ...(role && { role }), children: [] })],
  ])("a roled %s renders exactly as the same layout without a role", (_n, make) => {
    const plain = html(make());
    for (const role of ["stepped", "no-renderer-has-this", "Not A Key"]) {
      expect(html(make(role)), role).toBe(plain);
    }
    expect(plain).not.toContain("role");
  });
});
