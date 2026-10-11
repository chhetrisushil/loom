import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkspaceGraph } from "./layering";

// ── Fitness function: the dual-built packages' exports map ───────────────────
//
// core, classify, scheduler, blueprint-runtime and projection-runtime ship TWO builds: the
// CommonJS `dist/` every Node consumer gets, and `dist/esm/` (ES modules, `moduleResolution:
// "Bundler"`) so a browser bundler can tree-shake them. The exports map that routes between them
// is `types, require, node, import, default`, and the ORDER is load-bearing (Node and bundlers
// both stop at the FIRST condition they match):
//
//  - `node` BEFORE `import`. The ESM output is EXTENSIONLESS (`export … from "./eventKinds"`),
//    which a bundler resolves and native Node ESM refuses (ERR_MODULE_NOT_FOUND; the package has
//    no `"type": "module"` either). Node's `import` offers ["node", "import", "default"], so with
//    `node` first it gets the CJS build, which it can load; swap the two and every
//    `import "@loom/core"` in Node breaks while a bundler (no `node` condition) keeps working, so
//    nothing in a browser-only check would notice.
//  - `require` before `import`, `types` first and `default` (CJS) last: see
//    exportsConditions.test.ts.
//  - `sideEffects` must be declared, or a bundler keeps every module it reaches and the ESM
//    build buys nothing.
//
// The mapped files are checked on disk: a condition that points at a file the build does not
// emit is the same ERR_MODULE_NOT_FOUND, only later.

const REPO_ROOT = resolve(__dirname, "../../..");

/** The dual-built packages. A new one must be added here (the discovery test below says so). */
const DUAL_BUILT = [
  "@loom/blueprint-runtime",
  "@loom/classify",
  "@loom/core",
  "@loom/projection-runtime",
  "@loom/scheduler",
];

const ORDER = ["types", "require", "node", "import", "default"];

interface Manifest {
  name: string;
  main?: string;
  module?: string;
  types?: string;
  sideEffects?: unknown;
  exports?: Record<string, unknown>;
}

/** The CJS build: `./dist/…`, never under `./dist/esm/`. */
const isCjs = (p: unknown): boolean =>
  typeof p === "string" &&
  p.startsWith("./dist/") &&
  !p.startsWith("./dist/esm/") &&
  p.endsWith(".js");
const isEsm = (p: unknown): boolean =>
  typeof p === "string" && p.startsWith("./dist/esm/") && p.endsWith(".js");

/**
 * Every way `pkg`'s manifest breaks the dual-build contract. `dir` (when given) also checks that
 * each mapped file exists. Pure over the manifest so the negative cases can feed it a bad one.
 */
function dualBuildProblems(pkg: Manifest, dir?: string): string[] {
  const out: string[] = [];
  const where = (s: string) => `${pkg.name} ${s}`;
  if (pkg.sideEffects === undefined) out.push(where("declares no `sideEffects`"));
  else if (pkg.sideEffects !== false && !Array.isArray(pkg.sideEffects)) {
    out.push(where("`sideEffects` must be false or a list of files"));
  }
  const entries = Object.entries(pkg.exports ?? {});
  if (entries.length === 0) out.push(where("has no `exports` map"));
  const mapped = new Set<string>();
  for (const [subpath, value] of entries) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      out.push(where(`"${subpath}" is not a conditional export`));
      continue;
    }
    const map = value as Record<string, unknown>;
    const keys = Object.keys(map);
    if (keys.join(",") !== ORDER.join(",")) {
      out.push(
        where(`"${subpath}" conditions are (${keys.join(", ")}), want (${ORDER.join(", ")})`)
      );
    }
    const t = map.types;
    if (
      typeof t !== "string" ||
      !t.startsWith("./dist/") ||
      t.startsWith("./dist/esm/") ||
      !t.endsWith(".d.ts")
    ) {
      out.push(where(`"${subpath}" types → ${String(t)}, want a ./dist/*.d.ts`));
    }
    for (const c of ["require", "node", "default"]) {
      if (!isCjs(map[c]))
        out.push(where(`"${subpath}" ${c} → ${String(map[c])}, want the CJS ./dist/*.js`));
    }
    if (!isEsm(map.import)) {
      out.push(where(`"${subpath}" import → ${String(map.import)}, want ./dist/esm/*.js`));
    }
    // The CJS conditions name ONE file, and the ESM entry is its mirror under dist/esm.
    if (map.require !== map.node || map.require !== map.default) {
      out.push(where(`"${subpath}" require/node/default disagree`));
    }
    if (isCjs(map.require) && isEsm(map.import)) {
      const mirror = (map.require as string).replace("./dist/", "./dist/esm/");
      if (map.import !== mirror)
        out.push(where(`"${subpath}" import → ${String(map.import)}, want ${mirror}`));
    }
    for (const c of keys) if (typeof map[c] === "string") mapped.add(map[c] as string);
    if (subpath === ".") {
      if (pkg.main !== map.require)
        out.push(where(`main ${String(pkg.main)} ≠ require ${String(map.require)}`));
      if (pkg.module !== map.import)
        out.push(where(`module ${String(pkg.module)} ≠ import ${String(map.import)}`));
      if (pkg.types !== map.types)
        out.push(where(`types ${String(pkg.types)} ≠ exports types ${String(map.types)}`));
    }
  }
  if (dir !== undefined) {
    for (const f of mapped) {
      if (!existsSync(resolve(dir, f))) out.push(where(`maps ${f}, which the build did not emit`));
    }
  }
  return out;
}

function manifests(): Array<{ pkg: Manifest; dir: string; esmConfig: boolean }> {
  return [...readWorkspaceGraph().values()].map((node) => {
    const dir = resolve(REPO_ROOT, node.location);
    return {
      pkg: JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest,
      dir,
      esmConfig: existsSync(resolve(dir, "tsconfig.esm.json")),
    };
  });
}

const GOOD: Manifest = {
  name: "@loom/fixture",
  main: "./dist/index.js",
  module: "./dist/esm/index.js",
  types: "./dist/index.d.ts",
  sideEffects: false,
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      require: "./dist/index.js",
      node: "./dist/index.js",
      import: "./dist/esm/index.js",
      default: "./dist/index.js",
    },
  },
};
const withEntry = (entry: Record<string, string>, extra: Partial<Manifest> = {}): Manifest => ({
  ...GOOD,
  ...extra,
  exports: { ".": entry },
});
const goodEntry = (GOOD.exports as Record<string, Record<string, string>>)["."] as Record<
  string,
  string
>;

describe("dual-built package exports (fitness)", () => {
  it("the dual-built set is exactly the packages that build an ESM output", () => {
    // A package that grows a tsconfig.esm.json, a `module` field or an `import` → dist/esm
    // condition is dual-built, and is held to this contract by being named in DUAL_BUILT.
    const found = manifests()
      .filter(
        ({ pkg, esmConfig }) =>
          esmConfig ||
          pkg.module !== undefined ||
          JSON.stringify(pkg.exports ?? {}).includes("./dist/esm/")
      )
      .map(({ pkg }) => pkg.name)
      .sort();
    expect(found).toEqual(DUAL_BUILT);
  });

  it("each declares types, require, node, import, default (in that order), sideEffects, and files the build emitted", () => {
    const pkgs = manifests().filter(({ pkg }) => DUAL_BUILT.includes(pkg.name));
    expect(pkgs.map(({ pkg }) => pkg.name).sort()).toEqual(DUAL_BUILT);
    const problems = pkgs.flatMap(({ pkg, dir }) => dualBuildProblems(pkg, dir));
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("native Node ESM loads each package (through `node` → CJS), and could NOT load the ESM output", () => {
    // Why `node` must precede `import`: the extensionless dist/esm is a bundler's build. A
    // self-reference resolves through the package's own exports map, as a consumer's import does.
    for (const { pkg, dir } of manifests().filter(({ pkg }) => DUAL_BUILT.includes(pkg.name))) {
      const viaExports = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(pkg.name)}); if (Object.keys(m).length < 2) process.exit(3);`,
        ],
        { cwd: dir, encoding: "utf8" }
      );
      expect(viaExports.status, `${pkg.name}: ${viaExports.stderr}`).toBe(0);
      const esm = (pkg.exports as Record<string, Record<string, string>>)["."]?.import as string;
      const direct = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(resolve(dir, esm))});`],
        { cwd: dir, encoding: "utf8" }
      );
      expect(
        direct.status,
        `${pkg.name}: the ESM output loaded natively; is it still extensionless?`
      ).not.toBe(0);
      expect(direct.stderr).toMatch(/ERR_MODULE_NOT_FOUND|SyntaxError/);
    }
  });

  // ── The checks must be able to FAIL ─────────────────────────────────────────
  describe("negative cases", () => {
    it("accepts the good shape", () => {
      expect(dualBuildProblems(GOOD)).toEqual([]);
    });

    it("refuses `import` ahead of `node` (native Node ESM would get the extensionless build)", () => {
      const { types, require, node, import: imp, default: dflt } = goodEntry;
      const swapped = withEntry({ types, require, import: imp, node, default: dflt } as Record<
        string,
        string
      >);
      expect(dualBuildProblems(swapped as Manifest)).toEqual([
        expect.stringContaining("conditions are (types, require, import, node, default)"),
      ]);
    });

    it("refuses a missing `node` condition", () => {
      const { node: _node, ...rest } = goodEntry;
      const problems = dualBuildProblems(withEntry(rest));
      expect(problems.some((p) => p.includes("conditions are"))).toBe(true);
      expect(problems.some((p) => p.includes("node →"))).toBe(true);
    });

    it("refuses `import` pointing at CJS, and `node` pointing at the ESM build", () => {
      expect(dualBuildProblems(withEntry({ ...goodEntry, import: "./dist/index.js" }))).toEqual(
        expect.arrayContaining([expect.stringContaining("import → ./dist/index.js")])
      );
      expect(dualBuildProblems(withEntry({ ...goodEntry, node: "./dist/esm/index.js" }))).toEqual(
        expect.arrayContaining([expect.stringContaining("node → ./dist/esm/index.js")])
      );
    });

    it("refuses an undeclared `sideEffects`", () => {
      const { sideEffects: _s, ...rest } = GOOD;
      expect(dualBuildProblems(rest)).toEqual([
        expect.stringContaining("declares no `sideEffects`"),
      ]);
    });

    it("refuses a mapped file the build did not emit", () => {
      const problems = dualBuildProblems(GOOD, resolve(REPO_ROOT, "packages/spec/no-such-dir"));
      expect(problems).toContain(
        "@loom/fixture maps ./dist/esm/index.js, which the build did not emit"
      );
    });
  });
});
