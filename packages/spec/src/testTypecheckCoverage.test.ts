import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: every package with tests is covered by `pnpm typecheck:tests` ──
//
// Every package tsconfig EXCLUDES `*.test.ts`, so `pnpm typecheck` (tsc --build) never sees a
// type error in a test — a cast like `{ a } as { b }` silently makes an assertion check the
// wrong thing. `pnpm typecheck:tests` runs each package's `tsconfig.test.json` (noEmit, tests
// included). A package left out of that gate is invisible again, so: any package that has a
// test file MUST have a `tsconfig.test.json` that extends its tsconfig, does not re-exclude
// tests, and a `typecheck:tests` script that runs it.

const REPO_ROOT = resolve(__dirname, "../../..");
const ROOTS = ["packages", "plugins", "tools"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".vite", "coverage", "build", ".git"]);

function hasTestFile(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory() ? hasTestFile(p) : /\.test\.tsx?$/.test(e.name)) return true;
  }
  return false;
}

/** Violations for one package dir (empty when covered). Pure so it can be exercised on bad input. */
function coverageViolations(
  pkgRel: string,
  testTsconfig: { extends?: string; exclude?: string[] } | undefined,
  scripts: Record<string, string> | undefined
): string[] {
  const out: string[] = [];
  if (!testTsconfig) return [`${pkgRel}: has tests but no tsconfig.test.json`];
  if (testTsconfig.extends !== "./tsconfig.json")
    out.push(`${pkgRel}: tsconfig.test.json must extend ./tsconfig.json`);
  if ((testTsconfig.exclude ?? []).some((g) => /test|__tests__|testSurface/.test(g))) {
    out.push(`${pkgRel}: tsconfig.test.json re-excludes tests`);
  }
  if (!scripts?.["typecheck:tests"]?.includes("tsconfig.test.json")) {
    out.push(`${pkgRel}: package.json lacks a typecheck:tests script running tsconfig.test.json`);
  }
  return out;
}

describe("test typecheck coverage (fitness)", () => {
  it("every package with test files is covered by typecheck:tests", () => {
    const violations: string[] = [];
    let covered = 0;
    for (const root of ROOTS) {
      for (const name of readdirSync(join(REPO_ROOT, root))) {
        const dir = join(REPO_ROOT, root, name);
        if (!existsSync(join(dir, "package.json")) || !hasTestFile(dir)) continue;
        const rel = relative(REPO_ROOT, dir);
        const cfgPath = join(dir, "tsconfig.test.json");
        const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : undefined;
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        violations.push(...coverageViolations(rel, cfg, pkg.scripts));
        covered++;
      }
    }
    expect(violations).toEqual([]);
    expect(covered).toBeGreaterThan(50); // non-vacuous: the walker really found the packages
  });

  it("flags the shapes it exists to catch", () => {
    expect(coverageViolations("packages/x", undefined, {})).toHaveLength(1);
    expect(
      coverageViolations(
        "packages/x",
        { extends: "./tsconfig.json", exclude: ["**/*.test.ts"] },
        { "typecheck:tests": "tsc -p tsconfig.test.json" }
      )
    ).toHaveLength(1);
    expect(
      coverageViolations("packages/x", { extends: "./tsconfig.json", exclude: [] }, {})
    ).toHaveLength(1);
    expect(
      coverageViolations(
        "packages/x",
        { extends: "./tsconfig.json", exclude: ["dist"] },
        { "typecheck:tests": "tsc -p tsconfig.test.json" }
      )
    ).toEqual([]);
  });
});
