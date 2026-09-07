import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkspaceGraph } from "./layering";

// ── Fitness function: a test suite cannot run outside the shared config ───────
//
// `vitest.shared.ts` says "each package keeps its own [vitest.config.ts], so the
// content lives here" — and seven packages did not have one. There is no root
// config to fall back to, so their suites ran on vitest's defaults instead, which
// differs in two ways that matter:
//
//   • no `conditions: ["require", "default"]`, so importing a VALUE from a
//     workspace sibling whose exports map lacks a `default` condition fails to
//     resolve. That is not hypothetical — it is how `plugins/sqlite` broke the
//     first time it imported one from `@loom/memory`.
//   • no source aliases, so `LOOM_TEST_SRC=1` was silently inert there: the run
//     reported the same green while resolving the other tree.
//
// Both are invisible from the outside — a suite with the wrong resolution still
// passes, right up until it doesn't — so the invariant is asserted rather than
// documented.

const REPO_ROOT = resolve(__dirname, "../../..");

/** Packages whose `test` script runs vitest. */
function packagesWithTests(): { name: string; location: string }[] {
  const out: { name: string; location: string }[] = [];
  for (const node of readWorkspaceGraph().values()) {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, node.location, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test?.includes("vitest") === true) {
      out.push({ name: node.name, location: node.location });
    }
  }
  return out;
}

const hasConfig = (location: string): boolean =>
  existsSync(resolve(REPO_ROOT, location, "vitest.config.ts"));

describe("test-harness coverage (fitness)", () => {
  it("every package that runs vitest has a vitest.config.ts", () => {
    const missing = packagesWithTests()
      .filter((p) => !hasConfig(p.location))
      .map((p) => p.location);
    expect(
      missing,
      `these packages run vitest with no config, so they silently opt out of the shared resolution in vitest.shared.ts:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("every vitest.config.ts delegates to the shared base", () => {
    // A config that exists but forks the settings reintroduces the same drift with
    // an extra step; overrides go THROUGH `loomTest({ … })`.
    const forked = packagesWithTests()
      .filter((p) => hasConfig(p.location))
      .filter(
        (p) =>
          !readFileSync(resolve(REPO_ROOT, p.location, "vitest.config.ts"), "utf8").includes(
            "loomTest"
          )
      )
      .map((p) => p.location);
    expect(forked, `not built on loomTest():\n${forked.join("\n")}`).toEqual([]);
  });

  // ── The check must be able to FAIL ──────────────────────────────────────────
  it("would notice a package with tests and no config", () => {
    const withTests = packagesWithTests();
    expect(withTests.length).toBeGreaterThan(20); // the list is populated, not empty
    expect(hasConfig("packages/does-not-exist")).toBe(false);
  });

  it("sees the shared base it is guarding", () => {
    expect(existsSync(resolve(REPO_ROOT, "vitest.shared.ts"))).toBe(true);
    // Guards the two behaviours the missing configs were costing.
    const shared = readFileSync(resolve(REPO_ROOT, "vitest.shared.ts"), "utf8");
    expect(shared).toContain('conditions: ["require", "default"]');
    expect(shared).toContain("LOOM_TEST_SRC");
  });
});
