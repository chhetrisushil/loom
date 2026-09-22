import { describe, expect, it } from "vitest";
import { grid, stack } from "./layout";
import { traverseBlueprintAsync } from "./traverseBlueprintAsync";
import type { IncrementalRenderer } from "./traverseBlueprintAsync";
import type { GridLayout, Layout, Widget } from "./types";

// A test-only reference IncrementalRenderer that builds a plain object tree and
// records the order in which nodes were committed (appendChild) — proving the
// push/incremental-commit contract works.
interface RefNode {
  kind: string;
  children: RefNode[];
}

function refRenderer(committed: string[]): IncrementalRenderer<RefNode> {
  return {
    createContainer: (layout) => ({ kind: `container:${layout.type}`, children: [] }),
    createWidget: (ctx) => ({
      kind: `widget:${ctx.widget.kind}:${String(ctx.value ?? "")}`,
      children: [],
    }),
    appendChild: (parent, child) => {
      parent.children.push(child);
      committed.push(child.kind);
    },
  };
}

function widget(id: string, kind: string, path: string): Widget {
  return { _tag: "Widget", id, kind, props: {}, binding: { projectionId: "p", path } };
}

const tree: Layout = grid({
  columns: 2,
  children: [
    widget("a", "MetricCard", "a"),
    stack({ children: [widget("b", "StatusBadge", "b"), widget("c", "StatusBadge", "c")] }),
  ],
});

const stateMap = new Map<string, unknown>([["p", { a: 1, b: 2, c: 3 }]]);

describe("traverseBlueprintAsync", () => {
  it("builds the tree and resolves widget values via bindings", async () => {
    const committed: string[] = [];
    const root = await traverseBlueprintAsync(tree, stateMap, {
      renderer: refRenderer(committed),
      // Force a yield on every node to exercise the yielding path deterministically.
      shouldYield: () => true,
    });

    expect(root.kind).toBe("container:grid");
    expect(root.children[0]?.kind).toBe("widget:MetricCard:1");
    const inner = root.children[1];
    expect(inner?.kind).toBe("container:stack");
    expect(inner?.children.map((c) => c.kind)).toEqual([
      "widget:StatusBadge:2",
      "widget:StatusBadge:3",
    ]);
  });

  it("commits children in document order (incremental commit)", async () => {
    const committed: string[] = [];
    await traverseBlueprintAsync(tree, stateMap, { renderer: refRenderer(committed) });
    // Depth-first: grid's first leaf (MetricCard) commits, then the stack's two
    // leaves, then the stack itself commits into the grid. Deterministic order.
    expect(committed).toEqual([
      "widget:MetricCard:1",
      "widget:StatusBadge:2",
      "widget:StatusBadge:3",
      "container:stack",
    ]);
  });

  it("a legacy bare-child grid (no GridCell wrapper) traverses to the same output as the grid()-built equivalent", async () => {
    // Built WITHOUT grid() — a hand-cast literal, so the walker (not the builder) is what's
    // under test. grid() would normalise bare children into GridCells before the walker
    // ever saw them, proving nothing about the walker's own asCell handling.
    const legacyTree = {
      type: "grid",
      columns: 2,
      children: [
        widget("a", "MetricCard", "a"),
        stack({ children: [widget("b", "StatusBadge", "b"), widget("c", "StatusBadge", "c")] }),
      ],
    } as unknown as GridLayout;

    const legacyCommitted: string[] = [];
    const builtCommitted: string[] = [];
    const legacyRoot = await traverseBlueprintAsync(legacyTree, stateMap, {
      renderer: refRenderer(legacyCommitted),
    });
    const builtRoot = await traverseBlueprintAsync(tree, stateMap, {
      renderer: refRenderer(builtCommitted),
    });

    expect(legacyRoot).toEqual(builtRoot);
    expect(legacyCommitted).toEqual(builtCommitted);
  });

  it("yields cooperatively for large trees (default budget)", async () => {
    let yields = 0;
    const big = grid({
      columns: 1,
      children: Array.from({ length: 200 }, (_v, i) => widget(`w${i}`, "MetricCard", "a")),
    });
    await traverseBlueprintAsync(big, stateMap, {
      renderer: refRenderer([]),
      yieldTo: () => {
        yields++;
        return Promise.resolve();
      },
    });
    // 201 nodes, default budget 64 → at least 3 yields.
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it("aborts mid-walk when the signal fires", async () => {
    const controller = new AbortController();
    let processed = 0;
    const big = grid({
      columns: 1,
      children: Array.from({ length: 50 }, (_v, i) => widget(`w${i}`, "MetricCard", "a")),
    });

    await expect(
      traverseBlueprintAsync(big, stateMap, {
        renderer: {
          createContainer: (l) => ({ kind: l.type, children: [] }) as RefNode,
          createWidget: () => {
            processed++;
            return { kind: "w", children: [] } as RefNode;
          },
          appendChild: () => {},
        },
        signal: controller.signal,
        shouldYield: () => true,
        // Abort after a few nodes have been processed.
        yieldTo: () => {
          if (processed >= 5) controller.abort(new Error("cancelled"));
          return Promise.resolve();
        },
      })
    ).rejects.toThrow("cancelled");

    expect(processed).toBeLessThan(50);
  });
});

// ── Status resolution on the async path (IR 2.0.0) ───────────────────────────
//
// The synchronous walker's status resolution is covered by traverseBlueprint.test.ts; the async
// walker gained the same `resolveWidgetStatus` call with no test of its own, so "the two walkers
// hand a renderer the same context" was an assumption rather than an assertion.

describe("traverseBlueprintAsync — status", () => {
  const statusState = new Map<string, unknown>([
    [
      "p",
      { v: { a: 1, b: 2 }, s: { a: { state: "stale", finding: { code: "d", message: "m" } } } },
    ],
  ]);
  const withChannel: Widget = {
    _tag: "Widget",
    id: "a",
    kind: "MetricCard",
    props: {},
    binding: { projectionId: "p", path: "v.a", status: { path: "s.a" } },
  };
  const withoutChannel: Widget = {
    _tag: "Widget",
    id: "b",
    kind: "MetricCard",
    props: {},
    binding: { projectionId: "p", path: "v.b" },
  };

  it("passes `status` for a widget that DECLARES a channel and omits the key entirely for one that does not", async () => {
    const seen: Array<{ id: string; ctx: Record<string, unknown> }> = [];
    await traverseBlueprintAsync(stack({ children: [withChannel, withoutChannel] }), statusState, {
      renderer: {
        createContainer: (l) => ({ kind: l.type, children: [] }) as RefNode,
        createWidget: (ctx) => {
          seen.push({ id: ctx.widget.id, ctx: ctx as unknown as Record<string, unknown> });
          return { kind: `w:${String(ctx.value)}`, children: [] } as RefNode;
        },
        appendChild: () => {},
      },
    });

    expect(seen.map((s) => s.id)).toEqual(["a", "b"]);
    expect(seen[0]?.ctx.status).toEqual({ state: "stale", finding: { code: "d", message: "m" } });
    // Not `status: undefined` — the key is absent, the same shape the sync walker produces.
    expect("status" in (seen[1]?.ctx ?? {})).toBe(false);
  });

  it("a malformed value at the declared status path resolves to no status, never a throw", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await traverseBlueprintAsync(
      stack({ children: [withChannel] }),
      new Map<string, unknown>([["p", { v: { a: 1 }, s: { a: { state: "nonsense" } } }]]),
      {
        renderer: {
          createContainer: (l) => ({ kind: l.type, children: [] }) as RefNode,
          createWidget: (ctx) => {
            seen.push(ctx as unknown as Record<string, unknown>);
            return { kind: "w", children: [] } as RefNode;
          },
          appendChild: () => {},
        },
      }
    );
    expect("status" in (seen[0] ?? {})).toBe(false);
  });
});
