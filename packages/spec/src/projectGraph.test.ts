import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: the root project graph is complete ─────────────────────
//
// `tsconfig.json`'s references ARE the build graph for `tsc --build` — which is
// what `pnpm typecheck` and `pnpm build:fast` walk. A package missing from it is
// not slightly slower; it is silently unchecked. Two were: `packages/isolate`
// and `plugins/crypto` produced no output from a root build at all, and three
// more (including two kernel packages) were built only transitively, undeclared
// — so nothing would have noticed if a dependent stopped importing them.
//
// The failure mode is the reason this is a test rather than a convention: adding
// a package is the moment you are least likely to think about the root graph,
// and every symptom of forgetting shows up somewhere else.

const REPO_ROOT = resolve(__dirname, "../../..");

/** Workspace dirs whose `build` script runs tsc — exactly what the graph must cover. */
function tscBuiltPackages(): string[] {
  const out: string[] = [];
  for (const tier of ["packages", "plugins", "tools"]) {
    const dir = join(REPO_ROOT, tier);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const manifest = join(dir, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        scripts?: { build?: string };
      };
      if (pkg.scripts?.build?.includes("tsc") === true) out.push(`${tier}/${entry}`);
    }
  }
  return out;
}

function rootReferences(): string[] {
  // The root tsconfig carries comments; strip them before parsing.
  const raw = readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8").replace(/\/\/.*$/gm, "");
  const { references } = JSON.parse(raw) as { references?: { path: string }[] };
  return (references ?? []).map((r) => r.path.replace(/\/$/, ""));
}

describe("root project graph (fitness)", () => {
  const built = tscBuiltPackages();
  const referenced = new Set(rootReferences());

  it("finds the workspace packages (the sweep can't silently match nothing)", () => {
    expect(built.length).toBeGreaterThan(50);
  });

  it("every tsc-built package is referenced by the root tsconfig", () => {
    expect(built.filter((p) => !referenced.has(p))).toEqual([]);
  });

  it("every reference points at a real package", () => {
    // The other direction: a reference left behind by a rename fails the whole
    // root build with a path error, which is a worse failure than a slow one.
    expect([...referenced].filter((p) => !existsSync(join(REPO_ROOT, p, "package.json")))).toEqual(
      []
    );
  });
});
