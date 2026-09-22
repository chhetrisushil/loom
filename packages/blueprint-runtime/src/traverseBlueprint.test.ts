import { describe, expect, it } from "vitest";
import { grid, stack } from "./layout";
import { cell } from "./normalize";
import { traverseBlueprint } from "./traverseBlueprint";
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
    traverseBlueprint(stack({ children: [w("a", { path: "s.a" }), w("b")] }), map, {
      renderWidget: ({ widget, value, status }) => {
        seen.push([widget.id, value, status]);
        return widget.id;
      },
      renderContainer: ({ children }) => children.join(","),
    });
    expect(seen).toEqual([
      ["a", 1, { state: "stale", seq: 2 }],
      ["b", 2, undefined],
    ]);
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
    traverseBlueprint(stack({ children: [w("a")] }), new Map([["p", {}]]), {
      renderWidget: ({ widget }) => widget.id,
      renderContainer: (ctx) => {
        cells = ctx.cells;
        return "";
      },
    });
    expect(cells).toBeUndefined();
  });
});
