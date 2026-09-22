import { bench, describe } from "vitest";
import { grid } from "./layout";
import { traverseBlueprint } from "./traverseBlueprint";
import type { Layout, Widget } from "./types";

// ── Regression gate ───────────────────────────────────────────────────────────
// traverseBlueprint is the synchronous render fast-path. It is deliberately left
// untouched by the scheduler work; this bench is the committed baseline that CI
// compares against so any accidental regression to the hot path is caught.

function buildTree(nodeCount: number): Layout {
  // Build a balanced grid tree whose leaves are widgets, totalling ~nodeCount
  // widgets. Each level fans out by `branch`.
  const branch = 4;
  let leaves: Array<Widget | Layout> = Array.from({ length: nodeCount }, (_unused, i) => ({
    _tag: "Widget",
    id: `w${i}`,
    kind: "MetricCard",
    props: { label: `metric ${i}` },
    binding: { projectionId: "p", path: "value" },
  }));

  while (leaves.length > 1) {
    const parents: Array<Widget | Layout> = [];
    for (let i = 0; i < leaves.length; i += branch) {
      parents.push(grid({ columns: branch, children: leaves.slice(i, i + branch) }));
    }
    leaves = parents;
  }
  return leaves[0] as Layout;
}

const stateMap = new Map<string, unknown>([["p", { value: 42 }]]);

const options = {
  renderWidget: ({ value }: { value: unknown }) => value,
  renderContainer: ({ children }: { children: unknown[] }) => children,
};

for (const size of [10, 100, 1000, 10000]) {
  describe(`traverseBlueprint / ${size} nodes`, () => {
    const tree = buildTree(size);
    bench("traverse", () => {
      traverseBlueprint(tree, stateMap, options);
    });
  });
}
