import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ADR 0114 — type-level proof (loom test files are NOT tsc-checked, so this one runs tsc itself).
// A consumer that imports ONLY `@loom/app` (+ the kernel's `ExecutionContext`) must see `ctx.ui`.
// Resolution is from @loom/testing's own `node_modules`, i.e. the built `dist` a consumer gets.
function diagnose(source: string): string[] {
  const file = join(
    __dirname,
    "..",
    "__ui_consumer__.ts"
  ) /* resolves from @loom/testing: depends on @loom/app + workflow-runtime, NOT agent-surface */;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    types: ["node"],
    typeRoots: [join(dirname(file), "node_modules", "@types")],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (f) => (f === file ? source : read(f));
  host.fileExists = (f) => f === file || exists(f);
  host.getSourceFile = (
    (orig) =>
    (f, lang, ...rest) =>
      f === file ? ts.createSourceFile(f, source, lang) : orig(f, lang, ...rest)
  )(host.getSourceFile.bind(host));
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("ADR 0114 — ctx.ui type reaches an @loom/app-only consumer", () => {
  it("type-checks ctx.ui.set when only @loom/app is imported", () => {
    const diags = diagnose(`
      import { defineConfig } from "@loom/app";
      import type { ExecutionContext } from "@loom/workflow-runtime";
      export const cfg = defineConfig;
      export function run(ctx: ExecutionContext): void {
        ctx.ui.set("status", "ok");
        ctx.ui.append("log", 1);
      }
    `);
    expect(diags).toEqual([]);
  });

  it("negative control: without @loom/app (or agent-surface) in the program ctx.ui is untyped", () => {
    const diags = diagnose(`
      import type { ExecutionContext } from "@loom/workflow-runtime";
      export function run(ctx: ExecutionContext): void {
        ctx.ui.set("status", "ok");
      }
    `);
    expect(diags.join("\n")).toMatch(/TS2339/);
  });
});
