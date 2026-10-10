import { flex, grid, stack } from "@loom/blueprint-runtime";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
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
    // The role never reaches the DOM — neither as loom-ui's data attribute nor as an ARIA role.
    // (Other ARIA roles are not ruled out here; this renderer just must not derive one from it.)
    for (const role of ["stepped", "no-renderer-has-this", "Not A Key"]) {
      const roled = html(make(role));
      expect(roled).not.toContain("data-container-role");
      expect(roled).not.toContain(`role="${role}"`);
    }
  });
});

describe("renderReactContainer keys a container by its layout id (IR 2.4.0, ADR 0101)", () => {
  // A step container holding one uncontrolled <input>. The input is keyed by its widget id, as
  // both render paths key widget leaves; the CONTAINER is what this suite is about.
  const step = (id: string, keyed: boolean) =>
    renderReactContainer(stack({ ...(keyed && { id }), title: id, children: [] }), [
      <input key={`${id}-field`} data-testid={`${id}-field`} />,
    ]);
  const view = (ids: string[], keyed: boolean) =>
    renderReactContainer(
      stack({ ...(keyed && { id: "root" }), children: [] }),
      ids.map((id) => step(id, keyed))
    );
  const field = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`[data-testid="${id}-field"]`);

  it("a container inserted before a keyed sibling keeps the sibling's <input> node and its typed value", () => {
    const { container, rerender } = render(view(["account", "payment"], true));
    const payment = field(container, "payment");
    const account = field(container, "account");
    if (payment === null || account === null) throw new Error("fields not rendered");
    payment.value = "4111 1111";
    payment.focus();

    rerender(view(["account", "extra", "payment"], true));

    expect(field(container, "payment")).toBe(payment);
    expect(field(container, "account")).toBe(account);
    expect(payment.value).toBe("4111 1111");
    expect(document.activeElement).toBe(payment);
    expect(field(container, "extra")).not.toBeNull();
  });

  it("a reorder keeps both containers' nodes", () => {
    const { container, rerender } = render(view(["a", "b"], true));
    const a = field(container, "a");
    const b = field(container, "b");
    rerender(view(["b", "a"], true));
    expect(field(container, "a")).toBe(a);
    expect(field(container, "b")).toBe(b);
  });

  it("without ids, the same insert remounts the shifted sibling — the positional behaviour, unchanged", () => {
    // Pins the defect the id fixes: nested containers get index keys, so every container after
    // the insertion point is matched to a different step and its widgets are re-created.
    const { container, rerender } = render(view(["account", "payment"], false));
    const payment = field(container, "payment");
    rerender(view(["account", "extra", "payment"], false));
    expect(field(container, "payment")).not.toBe(payment);
  });

  it("an id'd tree renders DOM-identical to the unkeyed one — the id is a key, never markup", () => {
    const html = (keyed: boolean) => {
      const { container, unmount } = render(view(["a", "b"], keyed));
      const out = container.innerHTML;
      unmount();
      return out;
    };
    expect(html(true)).toBe(html(false));
    expect(html(true)).not.toContain("root");
  });

  it("sets the React key from a well-formed id only; a malformed id is absent (positional)", () => {
    expect(renderReactContainer(stack({ id: "s", children: [] }), []).key).toBe("s");
    expect(renderReactContainer(stack({ id: "t", title: "T", children: [] }), []).key).toBe("t");
    expect(renderReactContainer(stack({ children: [] }), []).key).toBeNull();
    for (const id of ["", 42, null]) {
      const layout = { type: "stack", id, children: [] } as unknown as Parameters<
        typeof renderReactContainer
      >[0];
      expect(renderReactContainer(layout, []).key, String(id)).toBeNull();
    }
  });

  it("a span > 1 grid cell wrapping an id'd container takes the container's key", () => {
    const inner = renderReactContainer(stack({ id: "inner", children: [] }), []);
    const g = renderReactContainer(
      grid({ columns: 4, children: [] }),
      [inner],
      [{ span: 2, child: inner }]
    );
    const kids = (g.props as { children: ReactElement[] }).children;
    // `k:inner` — Children.toArray escapes `:` as `=2`.
    expect(kids[0]?.key).toBe(".$k=2inner");
  });

  // A layout id is ANY non-empty string, so it can be "0" or "1" — the very strings an index key
  // stringifies to. Keyed and index-keyed cells must live under disjoint prefixes.
  const numericIdGrid = (order: string[], spans: number) => {
    const children: ReactElement[] = order.map((name) =>
      name.startsWith("#")
        ? renderReactContainer(stack({ id: name.slice(1), children: [] }), [
            <input key={`${name}-f`} data-testid={name} />,
          ])
        : // An UNKEYED cell (a nested container without an id), keyed by index.
          renderReactContainer(stack({ children: [] }), [<input key="f" data-testid={name} />])
    );
    return renderReactContainer(
      grid({ columns: 4, children: [] }),
      children,
      children.map((child) => ({ span: spans, child }))
    );
  };

  it.each([
    ["bare span-1 cells", 1],
    ["wrapped span > 1 cells", 2],
  ])('%s: ids "0"/"1" never collide with index-keyed siblings', (_n, spans) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const g = numericIdGrid(["#1", "plain"], spans);
      const keys = (g.props as { children: ReactElement[] }).children.map((k) => k.key);
      expect(new Set(keys).size).toBe(2);
      const { unmount } = render(g);
      unmount();
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    } finally {
      errors.mockRestore();
    }
  });

  it.each([
    ["bare span-1 cells", 1],
    ["wrapped span > 1 cells", 2],
  ])(
    "%s: an id'd cell keeps its node when an index-keyed cell shifts onto its id's ordinal",
    (_n, spans) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // "#0" at index 1, then an unkeyed cell is inserted first: without disjoint prefixes the
        // unkeyed cell at index 0 and the keyed "0" collide.
        const { container, rerender } = render(numericIdGrid(["plain", "#0"], spans));
        const zero = container.querySelector('[data-testid="#0"]');
        rerender(numericIdGrid(["new", "plain", "#0"], spans));
        expect(container.querySelector('[data-testid="#0"]')).toBe(zero);
        expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
      } finally {
        errors.mockRestore();
      }
    }
  );

  it("the grid path's DOM is unchanged: a bare cell still emits its child directly", () => {
    const { container } = render(numericIdGrid(["#1", "plain"], 1));
    const gridEl = container.firstChild as HTMLElement;
    expect(gridEl.children.length).toBe(2);
    for (const c of Array.from(gridEl.children))
      expect((c as HTMLElement).style.gridColumn).toBe("");
  });

  it('the non-grid path is already disjoint: an id "1" and an index-keyed sibling get distinct keys', () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = renderReactContainer(stack({ children: [] }), [
        renderReactContainer(stack({ id: "1", children: [] }), []),
        renderReactContainer(stack({ children: [] }), []),
      ]);
      const keys = (s.props as { children: ReactElement[] }).children.map((k) => k.key);
      expect(keys).toEqual([".$1", ".1"]);
      const { unmount } = render(s);
      unmount();
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    } finally {
      errors.mockRestore();
    }
  });
});
