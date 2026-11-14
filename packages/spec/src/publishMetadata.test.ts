import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_VERSION, filesFor, plan } from "../../../scripts/publish-metadata.mjs";

// ── Fitness function: every public package is publishable, and its metadata cannot drift ──
//
// `scripts/publish-metadata.mjs` is the one source of the npm publish fields (version, license,
// repository, the `files` allowlist, publishConfig, engines, `workspace:^`). This guard re-runs it
// in memory: a package.json edited by hand, or a new package added without running the generator,
// fails here instead of shipping tests and tsconfig files to npm (or not shipping at all).

const REPO_ROOT = resolve(__dirname, "../../..");

describe("publish metadata (fitness)", () => {
  it("every public package's package.json equals what the generator writes", () => {
    const { entries, errors } = plan(REPO_ROOT);
    expect(entries.length).toBeGreaterThan(50);
    expect(errors).toEqual([]);
    expect(entries.filter((e) => e.state === "stale").map((e) => e.rel)).toEqual([]);
    for (const e of entries) expect(e.next.version).toBe(RELEASE_VERSION);
  });

  it("the guard fires: a hand-edited package and a public→private dependency are reported", () => {
    const root = mkdtempSync(join(tmpdir(), "publish-metadata-"));
    try {
      const write = (rel: string, pkg: object) => {
        mkdirSync(join(root, rel), { recursive: true });
        writeFileSync(join(root, rel, "package.json"), JSON.stringify(pkg));
      };
      write("packages/a", {
        name: "@x/a",
        version: "0.0.1",
        dependencies: { "@x/b": "workspace:*" },
      });
      write("tools/b", { name: "@x/b", version: "0.0.1", private: true });
      const { entries, errors } = plan(root);
      expect(entries.map((e) => [e.rel, e.state])).toEqual([["packages/a", "stale"]]);
      expect(errors).toEqual(["packages/a: public package depends on private @x/b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ships subpath stubs at the package root but never tests, fixtures or build config", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-files-"));
    try {
      for (const f of [
        "memory.js",
        "memory.d.ts",
        "tsconfig.json",
        "vitest.config.ts",
        "README.md",
      ]) {
        writeFileSync(join(dir, f), "");
      }
      const files = filesFor(dir);
      expect(files).toContain("memory.js");
      expect(files).toContain("memory.d.ts");
      expect(files).not.toContain("tsconfig.json");
      expect(files).not.toContain("vitest.config.ts");
      expect(files).toContain("!src/**/*.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
