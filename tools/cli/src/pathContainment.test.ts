import * as path from "node:path";
import { pluginFiles } from "@loom/scaffold";
import { describe, expect, it } from "vitest";
import { resolveInside } from "./appgen";

// ChangeSpec paths come from a PLANNER (optionally an LLM) or a `--from-spec` lockfile on
// disk — neither trustworthy. `path.join(dir, "../../../tmp/x")` resolves to `/tmp/x`, so
// appgen's apply step was an arbitrary file WRITE, and `plan.deletes` an arbitrary
// `fs.rmSync`, anywhere the CLI user could reach.
const ROOT = path.resolve("/tmp/loom-project");

describe("resolveInside — plan paths cannot escape the target directory", () => {
  it("refuses traversal, including after normalisation", () => {
    for (const bad of [
      "../evil.txt",
      "../../../tmp/pwned.txt",
      "a/../../../../etc/passwd",
      "nested/../../outside",
    ]) {
      expect(() => resolveInside(ROOT, bad)).toThrow(/outside the target directory/);
    }
  });

  it("refuses an absolute path", () => {
    expect(() => resolveInside(ROOT, "/etc/passwd")).toThrow(/outside the target directory/);
  });

  it("refuses the directory itself", () => {
    // Writing or deleting the root is never a file operation the plan meant.
    expect(() => resolveInside(ROOT, ".")).toThrow(/outside the target directory/);
    expect(() => resolveInside(ROOT, "")).toThrow(/outside the target directory/);
  });

  it("allows ordinary nested paths, including ones containing '..' as a name part", () => {
    expect(resolveInside(ROOT, "src/flows/a.ts")).toBe(path.join(ROOT, "src/flows/a.ts"));
    expect(resolveInside(ROOT, "a/b/../c.ts")).toBe(path.join(ROOT, "a/c.ts"));
    expect(resolveInside(ROOT, "..hidden.ts")).toBe(path.join(ROOT, "..hidden.ts"));
  });
});

describe("plugin scaffolder — the name is not a path", () => {
  it("rejects a name that would escape or nest", () => {
    for (const bad of ["../../evil", "a/b", ".hidden", "-lead", "Upper", ""]) {
      expect(() => pluginFiles("store", bad, { firstParty: true })).toThrow(/invalid plugin name/);
    }
  });

  it("accepts ordinary names and keeps every path under the plugin dir", () => {
    const files = pluginFiles("store", "my-store", { firstParty: true });
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(Object.keys(files).every((k) => k.startsWith("plugins/my-store/"))).toBe(true);
  });
});

// The rename branch is a SECOND entry point into the same write. It used to honour an
// absolute path outright, and otherwise joined without a check — so the containment guard on
// the initial path was one prompt away from being bypassed.
describe("appgen — the rename branch is contained too", () => {
  it("refuses a rename that escapes, absolute or relative", () => {
    for (const bad of ["/etc/passwd", "../escape.ts", "a/../../../x.ts"]) {
      expect(() => resolveInside(ROOT, bad)).toThrow(/outside the target directory/);
    }
  });

  it("accepts a rename that stays inside", () => {
    expect(resolveInside(ROOT, "src/renamed.ts")).toBe(path.join(ROOT, "src/renamed.ts"));
  });
});
