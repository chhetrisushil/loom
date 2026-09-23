import { describe, expect, it } from "vitest";
import { grid, stack } from "./layout";
import { cell } from "./normalize";
import { type ContainerContext, traverseBlueprint } from "./traverseBlueprint";
import type { GridLayout, Widget } from "./types";
import { MetricCard } from "./widgets";

const w = (id: string, status?: { path: string }): Widget =>
  MetricCard({
    id,
    title: id,
    binding: { projectionId: "p", path: `v.${id}`, ...(status && { status }) },
  });

describe("traverseBlueprint (2.0.0)", () => {
  it("passes value AND status to renderWidget, status only when the binding declares a channel", () => {
    const state = { v: { a: 1, b: 2 }, s: { a: { state: "stale", seq: 2 } } };
    const map = new Map<string, unknown>([["p", state]]);
    const seen: Array<[string, unknown, unknown]> = [];
    let noChannelCtx: object | undefined;
    traverseBlueprint(stack({ children: [w("a", { path: "s.a" }), w("b")] }), map, {
      renderWidget: (ctx) => {
        const { widget, value, status } = ctx;
        seen.push([widget.id, value, status]);
        if (widget.id === "b") noChannelCtx = ctx;
        return widget.id;
      },
      renderContainer: ({ children }) => children.join(","),
    });
    expect(seen).toEqual([
      ["a", 1, { state: "stale", seq: 2 }],
      ["b", 2, undefined],
    ]);
    // Distinguishes an ABSENT `status` key from a present-`undefined` one — a renderer
    // testing `"status" in ctx` must see it missing, not present-and-undefined.
    expect("status" in (noChannelCtx as object)).toBe(false);
  });
  it("hands grid containers their cells with spans, and accepts a legacy bare child", () => {
    const legacy = {
      type: "grid",
      columns: 12,
      children: [w("a"), cell(8, w("b"))],
    } as unknown as GridLayout;
    let cells: Array<{ span: number; child: string }> | undefined;
    const out = traverseBlueprint<string>(legacy, new Map([["p", { v: {} }]]), {
      renderWidget: ({ widget }) => widget.id,
      renderContainer: (ctx) => {
        cells = ctx.cells;
        return ctx.children.join("|");
      },
    });
    expect(out).toBe("a|b");
    expect(cells).toEqual([
      { span: 1, child: "a" },
      { span: 8, child: "b" },
    ]);
  });
  it("a non-grid container has no cells", () => {
    let cells: unknown = "unset";
    let stackCtx: object | undefined;
    traverseBlueprint(stack({ children: [w("a")] }), new Map([["p", {}]]), {
      renderWidget: ({ widget }) => widget.id,
      renderContainer: (ctx) => {
        cells = ctx.cells;
        stackCtx = ctx;
        return "";
      },
    });
    expect(cells).toBeUndefined();
    // Distinguishes an ABSENT `cells` key from a present-`undefined` one.
    expect("cells" in (stackCtx as object)).toBe(false);
  });
  it("hands a placed cell's row, rowSpan and column to renderContainer, and omits absent ones (2.1.0)", () => {
    const g = grid({
      columns: 12,
      children: [cell(6, w("a"), { row: 2, column: 7, rowSpan: 3 }), w("b")],
    });
    let cells: ContainerContext<string>["cells"];
    traverseBlueprint<string>(g, new Map([["p", { v: {} }]]), {
      renderWidget: ({ widget }) => widget.id,
      renderContainer: (ctx) => {
        cells = ctx.cells;
        return ctx.children.join("|");
      },
    });
    expect(cells).toEqual([
      { span: 6, row: 2, column: 7, rowSpan: 3, child: "a" },
      { span: 1, child: "b" },
    ]);
    // ABSENT, not present-and-undefined: a renderer testing `"row" in cell` must see it missing.
    expect(Object.keys(cells?.[1] ?? {}).sort()).toEqual(["child", "span"]);
  });
});
