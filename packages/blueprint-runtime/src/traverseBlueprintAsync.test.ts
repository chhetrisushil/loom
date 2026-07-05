import { describe, expect, it } from "vitest";
import { grid, stack } from "./layout";
import { traverseBlueprintAsync } from "./traverseBlueprintAsync";
import type { IncrementalRenderer } from "./traverseBlueprintAsync";
import type { Layout, Widget } from "./types";

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
