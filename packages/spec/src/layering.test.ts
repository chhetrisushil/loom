import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KERNEL_PACKAGES,
  PURE_PACKAGES,
  SPI_PACKAGES,
  findKernelClosureViolations,
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

  it("ADR 0114 D4: a kernel package depends only on kernel packages (closed set)", () => {
    const violations = findKernelClosureViolations();
    const detail = violations.map((v) => `${v.from} → ${v.dependsOn}`).join("\n");
    expect(
      violations,
      `kernel closure broken (declare it structurally instead):\n${detail}`
    ).toEqual([]);
  });

  it("the closure rule can fail: a kernel package with a non-kernel dependency is reported", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-layering-"));
    try {
      for (const [name, deps] of [
        ["core", {}],
        ["workflow-runtime", { "@loom/core": "workspace:*", "@loom/agent-surface": "workspace:*" }],
        ["agent-surface", { "@loom/core": "workspace:*" }],
      ] as const) {
        mkdirSync(join(root, "packages", name), { recursive: true });
        writeFileSync(
          join(root, "packages", name, "package.json"),
          JSON.stringify({ name: `@loom/${name}`, dependencies: deps })
        );
      }
      expect(findKernelClosureViolations(root)).toEqual([
        { from: "@loom/workflow-runtime", dependsOn: "@loom/agent-surface" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
