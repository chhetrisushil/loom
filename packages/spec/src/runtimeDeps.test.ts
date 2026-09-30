import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ── Fitness function: a runtime import must be a declared runtime dependency ──
//
// A package's `src/` is compiled into `dist/`, and every VALUE import there is a `require`/
// `import` that runs in the consumer's process. If the imported package is declared only in
// `devDependencies`, the workspace is green (pnpm links every workspace package everywhere)
// while a consumer who installs the PUBLISHED package gets "Cannot find module". Nothing else
// in the suite can see this: tests run inside the workspace, where the link is always present.
//
// `import type` / `export type` / all-`type` named specifiers are erased from the JS, so they
// need no *runtime* dependency — but the emitted `.d.ts` still names the package, so a
// consumer's `tsc` fails ("Cannot find module 'zod'") if it is declared only in
// `devDependencies`. Rule 2 therefore applies the same declared-dependency requirement to
// type-only imports in shipped src. (Conservative: a type import used only internally is
// erased from the `.d.ts` too, but nothing cheap tells those apart.)
// Test files and `__tests__`/`__fixtures__` dirs are not shipped. A dependency may be
// declared as `dependencies`, `peerDependencies` or `optionalDependencies` — which one is a
// packaging choice, not this rule's business.
//
// Known limits (what this scan CANNOT see):
//  - Non-literal specifiers: `import(spec)` / `require(x)` with a computed argument are
//    invisible to a static scan. Known sites: tools/cli/src (deploy.ts, knowledge.ts,
//    learn.ts, pluginTry.ts, stores.ts x2) and packages/isolate/src/runner.ts. Those load
//    user-/config-named modules by design; they are not a fixed dependency.
//  - Files under `src/` are scanned, plus any hand-written file a package ships outside
//    `dist/` (named by `main`/`types`/`bin`/`exports`/`files`; today the root `memory.js` /
//    `sequence.js` subpath shims), which a dedicated test scans.
//  - The JSX automatic runtime emits `import ... from "<jsxImportSource>/jsx-runtime"`, which
//    is not in the source text; a test below requires that package to be declared for every
//    package whose tsconfig sets `jsx: react-jsx`/`react-jsxdev`.

const REPO_ROOT = resolve(__dirname, "../../..");
const TIERS = ["apps", "packages", "plugins", "tools"];
// Only test-only dirs by convention. Deliberately NOT `test`/`tests`/`fixtures`: a runtime
// source dir with such a name (src/test/...) must still be scanned. A top-level `test/` beside
// `src/` is never scanned anyway, because only `<pkg>/src` is walked.
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__fixtures__"]);
const TEST_FILE = /\.(test|spec|bench)\.[cm]?[tj]sx?$|\.d\.ts$/;
const SOURCE_FILE = /\.[cm]?[tj]sx?$/;
const NODE_BUILTINS = new Set(builtinModules);

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; relative/builtin/virtual -> null. */
function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
  return NODE_BUILTINS.has(name) ? null : name;
}

interface Imports {
  /** Packages imported as VALUES (survive into the emitted JS). */
  value: Set<string>;
  /** Packages imported ONLY as types (survive into the emitted `.d.ts`). */
  type: Set<string>;
}

/** Package names a source file imports, split value vs type-only (one AST pass, no regex). */
function scanImports(fileName: string, text: string): Imports {
  const value = new Set<string>();
  const type = new Set<string>();
  const add = (spec: string, typeOnly: boolean) => {
    const p = packageOf(spec);
    if (p !== null) (typeOnly ? type : value).add(p);
  };
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      const bindings = c?.namedBindings;
      const typeOnly =
        c !== undefined &&
        (c.isTypeOnly ||
          (c.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((e) => e.isTypeOnly)));
      add(node.moduleSpecifier.text, typeOnly);
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const c = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (c !== undefined &&
          ts.isNamedExports(c) &&
          c.elements.length > 0 &&
          c.elements.every((e) => e.isTypeOnly));
      add(node.moduleSpecifier.text, typeOnly);
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      const r = node.moduleReference;
      if (ts.isExternalModuleReference(r) && ts.isStringLiteral(r.expression))
        add(r.expression.text, false);
      return;
    }
    if (ts.isCallExpression(node)) {
      const a = node.arguments[0];
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamic || isRequire) && a !== undefined && ts.isStringLiteralLike(a))
        add(a.text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A package imported both ways is a value dependency; report it once.
  for (const v of value) type.delete(v);
  return { value, type };
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(join(dir, e.name), acc);
    } else if (SOURCE_FILE.test(e.name) && !TEST_FILE.test(e.name)) acc.push(join(dir, e.name));
  }
  return acc;
}

interface Pkg {
  dir: string;
  name: string;
  declared: Set<string>;
  manifest: Record<string, unknown>;
  /** jsxImportSource package the tsconfig makes tsc emit, or null when JSX is not automatic. */
  jsxImport: string | null;
}

/**
 * Shipped-but-unreachable files whose TYPE imports are exempt from rule 2, keyed by repo-relative
 * path. Each is emitted to dist (so its `.d.ts` does name the package) but no consumer can load
 * it: the package `exports` map exposes only the entry, and nothing under src/ re-exports it
 * (asserted below). The exemption is only honest while that holds.
 */
const UNREACHABLE_FROM_ENTRY = new Map<string, string>([
  [
    "packages/worker-runtime-local/src/spiShapeProof.ts",
    "compile-time SPI drift proof; must type-check in the normal build so it type-imports the " +
      "dev-only @loom/conformance, but it is not exported and is unreachable through `exports`",
  ],
]);

function jsxImportOf(pkgDir: string): string | null {
  const cfg = join(REPO_ROOT, pkgDir, "tsconfig.json");
  if (!existsSync(cfg)) return null;
  const parsed = ts.parseConfigFileTextToJson(cfg, readFileSync(cfg, "utf8")).config as
    | { compilerOptions?: { jsx?: string; jsxImportSource?: string } }
    | undefined;
  const o = parsed?.compilerOptions ?? {};
  const jsx = (o.jsx ?? "").toLowerCase();
  if (jsx !== "react-jsx" && jsx !== "react-jsxdev") return null;
  return o.jsxImportSource ?? "react";
}

function workspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const tier of TIERS) {
    const root = join(REPO_ROOT, tier);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const manifestPath = join(root, entry, "package.json");
      if (!existsSync(manifestPath) || !existsSync(join(root, entry, "src"))) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const declared = new Set<string>();
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const k of Object.keys((pkg[field] as object | undefined) ?? {})) declared.add(k);
      }
      out.push({
        dir: `${tier}/${entry}`,
        name: pkg.name as string,
        declared,
        manifest: pkg,
        jsxImport: jsxImportOf(`${tier}/${entry}`),
      });
    }
  }
  return out;
}

/** Every string leaf of a manifest field (handles `exports` conditions nesting). */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("runtime imports are declared dependencies (fitness)", () => {
  const packages = workspacePackages();

  it("finds the workspace packages (the sweep can't silently match nothing)", () => {
    expect(packages.length).toBeGreaterThan(50);
  });

  it("the import scanner separates value imports from erased ones", () => {
    const got = scanImports(
      "x.ts",
      `import type { A } from "t1";
import { type B } from "t2";
import { type C, d } from "v1";
import e from "v2/sub";
import * as f from "@s/v3/deep";
export type { G } from "t3";
export { type H } from "t4";
export * from "v4";
export { i } from "v5";
import "v6";
import fs from "node:fs";
import path from "path";
import "./rel";
const z = await import("v7");
const y = () => import(\`dyn\${1}\`);
import type { M } from "v1";
import {
  type J,
  k,
} from "w8";`
    );
    expect([...got.value].sort()).toEqual(["@s/v3", "v1", "v2", "v4", "v5", "v6", "v7", "w8"]);
    // type-only packages are reported separately; one also imported as a value is not repeated
    expect([...got.type].sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("the source walk skips test-only dirs by convention but not runtime dirs named test/tests", () => {
    const root = mkdtempSync(join(tmpdir(), "runtimedeps-"));
    try {
      for (const d of [
        "src/test",
        "src/tests/deep",
        "src/__tests__",
        "src/__fixtures__",
        "src/lib",
      ]) {
        mkdirSync(join(root, d), { recursive: true });
        writeFileSync(join(root, d, "m.ts"), "export {};\n");
      }
      writeFileSync(join(root, "src/lib/m.test.ts"), "export {};\n");
      const got = sourceFiles(join(root, "src"))
        .map((f) => f.slice(root.length + 1))
        .sort();
      expect(got).toEqual(["src/lib/m.ts", "src/test/m.ts", "src/tests/deep/m.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every package value-imported from src/ is in dependencies, peerDependencies or optionalDependencies", () => {
    const missing: string[] = [];
    for (const p of packages) {
      const seen = new Map<string, string>(); // import -> first file
      for (const file of sourceFiles(join(REPO_ROOT, p.dir, "src"))) {
        for (const spec of scanImports(file, readFileSync(file, "utf8")).value) {
          if (spec !== p.name && !p.declared.has(spec) && !seen.has(spec)) {
            seen.set(spec, file.slice(REPO_ROOT.length + 1));
          }
        }
      }
      for (const [spec, file] of seen) {
        missing.push(
          `${p.dir} (${p.name}) imports "${spec}" at runtime (${file}) but does not declare it`
        );
      }
    }
    expect(missing).toEqual([]);
  });

  it("every package type-imported from shipped src/ is declared too (the emitted .d.ts names it)", () => {
    const missing: string[] = [];
    for (const p of packages) {
      const seen = new Map<string, string>();
      for (const file of sourceFiles(join(REPO_ROOT, p.dir, "src"))) {
        const rel = file.slice(REPO_ROOT.length + 1);
        if (UNREACHABLE_FROM_ENTRY.has(rel)) continue;
        for (const spec of scanImports(file, readFileSync(file, "utf8")).type) {
          if (spec !== p.name && !p.declared.has(spec) && !seen.has(spec)) seen.set(spec, rel);
        }
      }
      for (const [spec, file] of seen) {
        missing.push(
          `${p.dir} (${p.name}) type-imports "${spec}" (${file}) but does not declare it; the published .d.ts would not resolve`
        );
      }
    }
    expect(missing).toEqual([]);
  });

  it("every UNREACHABLE_FROM_ENTRY exemption is a real file that nothing else in the package imports", () => {
    for (const [file, why] of UNREACHABLE_FROM_ENTRY) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
      expect(why.length, `${file} needs a justification`).toBeGreaterThan(10);
      const pkgSrc = join(REPO_ROOT, file.split("/").slice(0, 3).join("/"));
      const stem = (file.split("/").pop() as string).replace(/\.[cm]?tsx?$/, "");
      const importers = sourceFiles(pkgSrc)
        .filter((f) => f !== join(REPO_ROOT, file))
        .filter((f) =>
          new RegExp(`from\\s+["']\\.{1,2}/(?:[^"']*/)?${stem}(?:\\.js)?["']`).test(
            readFileSync(f, "utf8")
          )
        );
      expect(importers, `${file} must stay unreachable from the entry`).toEqual([]);
    }
    // the exemption is exact: nothing else is exempted, and a non-exempt file is still checked
    expect(UNREACHABLE_FROM_ENTRY.size).toBe(1);
  });

  it("hand-written files shipped outside dist/ (root subpath shims) import only relatively or declared packages", () => {
    // Some packages ship tiny hand-written `memory.js`/`memory.d.ts` subpath shims beside
    // package.json (event-runtime, snapshot-runtime, a2a). They are named by `exports`/`main`/
    // `bin`/`files` and are never compiled from src/, so the src/ scan cannot see them.
    const shipped = new Set<string>();
    const bad: string[] = [];
    let scanned = 0;
    for (const p of packages) {
      const entries = new Set<string>();
      for (const field of ["main", "module", "types", "typings", "bin", "exports", "files"]) {
        for (const e of strings(p.manifest[field])) entries.add(e);
      }
      for (const e of entries) {
        const norm = e.replace(/^\.\//, "").replace(/\/$/, "");
        if (norm === "dist" || norm.startsWith("dist/") || norm === "package.json") continue;
        if (norm.includes("*")) {
          bad.push(
            `${p.dir}: glob entry "${e}" outside dist/ cannot be scanned; list files explicitly`
          );
          continue;
        }
        const abs = join(REPO_ROOT, p.dir, norm);
        if (!existsSync(abs)) {
          bad.push(`${p.dir}: entry "${e}" names a file that does not exist`);
          continue;
        }
        const files = statSync(abs).isDirectory() ? sourceFiles(abs) : [abs];
        for (const f of files) {
          if (!SOURCE_FILE.test(f) && !f.endsWith(".d.ts")) continue;
          if (shipped.has(f)) continue;
          shipped.add(f);
          scanned++;
          const imports = scanImports(f, readFileSync(f, "utf8"));
          for (const spec of [...imports.value, ...imports.type]) {
            if (spec !== p.name && !p.declared.has(spec)) {
              bad.push(`${p.dir}: shipped file ${norm} imports "${spec}" but does not declare it`);
            }
          }
        }
      }
    }
    expect(scanned, "the shim scan must see the known shims").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("a package whose tsconfig uses the automatic JSX runtime declares the jsx import source", () => {
    const jsxPackages = packages.filter((p) => p.jsxImport !== null);
    expect(jsxPackages.map((p) => p.dir)).toContain("plugins/renderer-react");
    const missing = jsxPackages
      .filter((p) => !p.declared.has(p.jsxImport as string))
      .map(
        (p) =>
          `${p.dir}: tsconfig jsx emits "${p.jsxImport}/jsx-runtime" but ${p.jsxImport} is not declared`
      );
    expect(missing).toEqual([]);
    // .tsx in shipped src implies a JSX config (else the file wouldn't compile to a runtime import)
    const tsxWithoutJsx = packages
      .filter((p) => p.jsxImport === null)
      .filter((p) => sourceFiles(join(REPO_ROOT, p.dir, "src")).some((f) => f.endsWith(".tsx")))
      .map((p) => `${p.dir} has .tsx in src but its tsconfig has no react-jsx`);
    expect(tsxWithoutJsx).toEqual([]);
  });
});
