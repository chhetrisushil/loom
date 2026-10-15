import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED_MARKER, plan, workspacePackages } from "../../../scripts/package-readmes.mjs";

// ── Fitness function: every workspace package has a README, and generated ones cannot drift ──
//
// An audit found 59 of 75 workspace packages with no README.md: a reader landing on
// `plugins/mcp` on GitHub saw a bare file list. `scripts/package-readmes.mjs` generates a
// short README (name, description, entry points from `exports`, api-reference link) for every
// package that has no hand-written one. A hand-written README (no GENERATED_MARKER) is never
// overwritten. This guard asserts, for every package under packages/, plugins/, tools/:
//   1. a README.md exists;
//   2. its first `# ` heading names the package (backticks ignored) — a copied README fails;
//   3. a generated README equals what the generator would write NOW (re-run in memory), so a
//      changed description / `exports` / api-reference heading cannot leave a stale README.

const REPO_ROOT = resolve(__dirname, "../../..");

type Entry = { file: string; text: string; state: "missing" | "stale" | "ok" };

function titleOf(readme: string): string | undefined {
  const line = readme.split("\n").find((l) => /^# /.test(l));
  return line?.replace(/^# /, "").replace(/`/g, "").trim();
}

/** The violations for the workspace rooted at `root` (empty = clean). */
function violations(root: string): string[] {
  const out: string[] = [];
  const pkgs = workspacePackages(root) as { dir: string; rel: string; pkg: { name: string } }[];
  for (const { dir, rel, pkg } of pkgs) {
    const file = join(dir, "README.md");
    if (!existsSync(file)) {
      out.push(`${rel}: no README.md`);
      continue;
    }
    const title = titleOf(readFileSync(file, "utf8"));
    if (title !== pkg.name && !title?.startsWith(`${pkg.name} `)) {
      out.push(`${rel}: README title "${title}" does not name ${pkg.name}`);
    }
  }
  for (const e of plan(root) as Entry[]) {
    if (e.state === "stale")
      out.push(`${e.file.slice(root.length + 1)}: generated README is stale`);
  }
  return out;
}

describe("package READMEs (fitness)", () => {
  it("finds the workspace (the sweep can't silently match nothing)", () => {
    expect((workspacePackages(REPO_ROOT) as unknown[]).length).toBeGreaterThan(60);
  });

  it("every package has a README titled with its name, and generated ones are current", () => {
    expect(
      violations(REPO_ROOT),
      "run `node scripts/package-readmes.mjs` (generated) or fix the hand-written README title"
    ).toEqual([]);
  });

  it("generated files carry the marker; hand-written ones do not need it", () => {
    const generated = (plan(REPO_ROOT) as Entry[]).filter((e) => e.state === "ok");
    for (const e of generated) {
      expect(readFileSync(e.file, "utf8").startsWith(GENERATED_MARKER)).toBe(true);
    }
  });

  // The proof the guard fires: plant each defect in a scratch copy of two packages + the reference.
  describe("fires on planted defects", () => {
    function scratch(): string {
      const root = mkdtempSync(join(tmpdir(), "readme-guard-"));
      mkdirSync(join(root, "docs"), { recursive: true });
      cpSync(join(REPO_ROOT, "docs/api-reference.org"), join(root, "docs/api-reference.org"));
      for (const rel of ["packages/saga", "plugins/mcp"]) {
        mkdirSync(join(root, rel), { recursive: true });
        cpSync(join(REPO_ROOT, rel, "package.json"), join(root, rel, "package.json"));
        cpSync(join(REPO_ROOT, rel, "README.md"), join(root, rel, "README.md"));
      }
      return root;
    }

    it("clean scratch copy passes", () => {
      const root = scratch();
      try {
        expect(violations(root)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a missing README, a wrong title and a stale generated README are each reported", () => {
      const root = scratch();
      try {
        rmSync(join(root, "packages/saga/README.md"));
        const pg = join(root, "plugins/mcp/README.md");
        writeFileSync(
          pg,
          readFileSync(pg, "utf8").replace("# @loom/plugin-mcp", "# something else")
        );
        expect(violations(root).sort()).toEqual(
          [
            'plugins/mcp: README title "something else" does not name @loom/plugin-mcp',
            "packages/saga: no README.md",
            "plugins/mcp/README.md: generated README is stale",
          ].sort()
        );

        // stale: description changes after generation
        writeFileSync(
          join(root, "packages/saga/README.md"),
          readFileSync(join(REPO_ROOT, "packages/saga/README.md"))
        );
        const pj = join(root, "plugins/mcp/package.json");
        const pkg = JSON.parse(readFileSync(pj, "utf8"));
        const fresh = (plan(root) as Entry[]).find((e) => e.file === pg);
        writeFileSync(pg, fresh?.text ?? "");
        expect(violations(root)).toEqual([]);
        pkg.description = `${pkg.description} (changed)`;
        writeFileSync(pj, JSON.stringify(pkg));
        expect(violations(root)).toEqual(["plugins/mcp/README.md: generated README is stale"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
