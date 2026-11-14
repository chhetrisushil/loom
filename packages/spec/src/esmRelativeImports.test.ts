import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { workspacePackages } from "../../../scripts/package-readmes.mjs";

// ── Fitness function: a published ESM package's relative imports carry a file extension ──
//
// Node's ESM loader does not add extensions: `import "./x"` from a `"type": "module"` package
// fails with ERR_MODULE_NOT_FOUND. `moduleResolution: "Bundler"` type-checks it anyway, and a
// sibling consumed through `link:` hides it (Vite inlines files outside node_modules), so
// `@loomwork/conformance@0.1.0` shipped unloadable by plain Node and nothing in this repo noticed.
// tsc copies the specifier verbatim, so checking the SOURCE is checking the emitted dist.

const REPO_ROOT = join(__dirname, "../../..");
const SPEC = /(?:\bfrom|\bimport\s*\(|^\s*import)\s*["'](\.{1,2}\/[^"']+)["']/gm;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!name.startsWith("__")) sourceFiles(p, acc);
    } else if (
      /\.tsx?$/.test(name) &&
      !/\.(test|spec|bench)\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/** Relative specifiers without an extension in one source text. Pure, so the guard can be proven. */
function extensionlessRelative(text: string): string[] {
  return [...text.matchAll(SPEC)]
    .map((m) => m[1] as string)
    .filter((s) => !/\.(m|c)?js$|\.json$/.test(s));
}

describe("ESM relative imports (fitness)", () => {
  it('every "type": "module" package names a file extension on each relative import', () => {
    const bad: string[] = [];
    let esm = 0;
    for (const { dir, rel, pkg } of workspacePackages(REPO_ROOT)) {
      if (pkg.type !== "module" || pkg.private) continue;
      esm++;
      for (const f of sourceFiles(join(dir, "src"))) {
        for (const s of extensionlessRelative(readFileSync(f, "utf8"))) {
          bad.push(`${rel}/${relative(dir, f)}: "${s}" (Node's ESM loader needs "${s}.js")`);
        }
      }
    }
    expect(esm).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("the guard fires on extensionless specifiers, multi-line imports and dynamic import()", () => {
    const text = [
      'import { a } from "./a";',
      "import {\n  b,\n} from '../b';",
      'const c = await import("./c");',
      'import "./side-effect";',
      'import { ok } from "./ok.js";',
      'import data from "./data.json";',
      'import { pkg } from "@loomwork/core";',
    ].join("\n");
    expect(extensionlessRelative(text)).toEqual(["./a", "../b", "./c", "./side-effect"]);
  });
});
