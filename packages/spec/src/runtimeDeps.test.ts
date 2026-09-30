import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
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
// `import type` / `export type` / all-`type` named specifiers are erased by tsc and need no
// runtime dependency, so they are not counted. Test files and fixtures are not shipped.
// A dependency may be declared as `dependencies`, `peerDependencies` or
// `optionalDependencies` — which one is a packaging choice, not this rule's business.

const REPO_ROOT = resolve(__dirname, "../../..");
const TIERS = ["apps", "packages", "plugins", "tools"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
]);
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

/** Package names a source file imports as VALUES (one AST pass, no regex). */
function runtimeImports(fileName: string, text: string): Set<string> {
  const out = new Set<string>();
  const add = (spec: string) => {
    const p = packageOf(spec);
    if (p !== null) out.add(p);
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
      if (!typeOnly) add(node.moduleSpecifier.text);
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
      if (!typeOnly) add(node.moduleSpecifier.text);
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      const r = node.moduleReference;
      if (ts.isExternalModuleReference(r) && ts.isStringLiteral(r.expression))
        add(r.expression.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      const a = node.arguments[0];
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamic || isRequire) && a !== undefined && ts.isStringLiteralLike(a)) add(a.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
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
}

function workspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const tier of TIERS) {
    const root = join(REPO_ROOT, tier);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const manifest = join(root, entry, "package.json");
      if (!existsSync(manifest) || !existsSync(join(root, entry, "src"))) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      const declared = new Set<string>();
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const k of Object.keys((pkg[field] as object | undefined) ?? {})) declared.add(k);
      }
      out.push({ dir: `${tier}/${entry}`, name: pkg.name as string, declared });
    }
  }
  return out;
}

describe("runtime imports are declared dependencies (fitness)", () => {
  const packages = workspacePackages();

  it("finds the workspace packages (the sweep can't silently match nothing)", () => {
    expect(packages.length).toBeGreaterThan(50);
  });

  it("the import scanner separates value imports from erased ones", () => {
    const got = runtimeImports(
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
import {
  type J,
  k,
} from "w8";`
    );
    expect([...got].sort()).toEqual(["@s/v3", "v1", "v2", "v4", "v5", "v6", "v7", "w8"]);
  });

  it("every package value-imported from src/ is in dependencies, peerDependencies or optionalDependencies", () => {
    const missing: string[] = [];
    for (const p of packages) {
      const seen = new Map<string, string>(); // import -> first file
      for (const file of sourceFiles(join(REPO_ROOT, p.dir, "src"))) {
        for (const spec of runtimeImports(file, readFileSync(file, "utf8"))) {
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
});
