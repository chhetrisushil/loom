import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkspaceGraph } from "./layering";

// ── Fitness function: an exports map that ESM cannot enter ───────────────────
//
// Forty-nine packages declared `exports: { ".": { types, require } }` and nothing
// else. Node matches export conditions in order and stops at the first hit, so an
// `import` — which offers ["node", "import"] and never "require" — matched nothing
// and failed with ERR_PACKAGE_PATH_NOT_EXPORTED. Every one of these packages was
// unreachable from ESM.
//
// It stayed invisible because loom's own test config forces
// `conditions: ["require", "default"]`, and TypeScript reads `types` directly, so
// nothing in the repo ever asked for the missing condition. `@loom/memory` was the
// first to be caught, by a package that happened to have no vitest config.
//
// `default` is the fallback that any condition set matches. It is checked LAST,
// which is why its POSITION matters as much as its presence: ahead of `require` it
// would shadow it and hand a CJS consumer the wrong entry.

const REPO_ROOT = resolve(__dirname, "../../..");

interface Entry {
  pkg: string;
  subpath: string;
  conditions: string[];
}

/** Every conditional export object in the workspace, flattened. */
function conditionalExports(): Entry[] {
  const out: Entry[] = [];
  for (const node of readWorkspaceGraph().values()) {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, node.location, "package.json"), "utf8")
    ) as { exports?: Record<string, unknown> };
    for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        out.push({ pkg: node.name, subpath, conditions: Object.keys(value) });
      }
    }
  }
  return out;
}

const describeEntry = (e: Entry): string => `${e.pkg} "${e.subpath}" (${e.conditions.join(", ")})`;

describe("package exports conditions (fitness)", () => {
  it("every conditional export an ESM importer can enter", () => {
    const unreachable = conditionalExports()
      .filter((e) => e.conditions.includes("require"))
      .filter((e) => !e.conditions.includes("default") && !e.conditions.includes("import"))
      .map(describeEntry);
    expect(
      unreachable,
      `these resolve for require() and fail ERR_PACKAGE_PATH_NOT_EXPORTED for import:\n${unreachable.join("\n")}`
    ).toEqual([]);
  });

  it("`default` is the last condition wherever it appears", () => {
    const misordered = conditionalExports()
      .filter((e) => e.conditions.includes("default"))
      .filter((e) => e.conditions[e.conditions.length - 1] !== "default")
      .map(describeEntry);
    expect(
      misordered,
      `\`default\` matches everything, so anything after it is dead:\n${misordered.join("\n")}`
    ).toEqual([]);
  });

  it("`types` is the first condition wherever it appears", () => {
    const misordered = conditionalExports()
      .filter((e) => e.conditions.includes("types"))
      .filter((e) => e.conditions[0] !== "types")
      .map(describeEntry);
    expect(misordered, `TypeScript matches in order too:\n${misordered.join("\n")}`).toEqual([]);
  });

  // ── The checks must be able to FAIL ─────────────────────────────────────────
  it("is looking at a populated list", () => {
    const entries = conditionalExports();
    expect(entries.length).toBeGreaterThan(40);
    // And the shape it guards is the one the workspace actually uses.
    expect(entries.filter((e) => e.conditions.includes("require")).length).toBeGreaterThan(40);
  });
});
