import { describe, expect, it } from "vitest";
import {
  KERNEL_PACKAGES,
  PURE_PACKAGES,
  SPI_PACKAGES,
  findLayeringViolations,
  readWorkspaceGraph,
} from "./layering";

describe("kernel/plugin layering guard (ADR 0043)", () => {
  it("no kernel or SPI package transitively depends on a plugins/* adapter", () => {
    const violations = findLayeringViolations();
    // A readable message so a regression names the offending edge, not just a count.
    const detail = violations
      .map((v) => `${v.plugin} reached from ${v.from} via ${v.path.join(" → ")}`)
      .join("\n");
    expect(violations, `minimal-kernel invariant broken:\n${detail}`).toEqual([]);
  });

  it("every declared pure package that exists is actually in the workspace under packages/", () => {
    const graph = readWorkspaceGraph();
    for (const name of PURE_PACKAGES) {
      const node = graph.get(name);
      if (node === undefined) continue; // may not exist yet in a partial checkout
      expect(node.tier, `${name} must live in packages/, not ${node.tier}/`).toBe("packages");
    }
  });

  it("classifies at least the known kernel + SPI packages", () => {
    // Guards against an accidental empty list silently passing the invariant.
    expect(KERNEL_PACKAGES.length).toBeGreaterThanOrEqual(8);
    expect(SPI_PACKAGES.length).toBeGreaterThanOrEqual(6);
  });
});
