import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { type ImportedBinding, inferStepFactory, stringLiteralValue } from "./runnerReach";

// ── L37: follow a RELATIVE import to the constant / step factory it names ─────
//
// `runnerReach` reads one parsed module. A flow that writes `llmStep$(id, LLM_RESHAPE)` imports both
// the factory and the constant, so on one module they are unresolvable. This reads the imported
// module (relative specifiers only: `./x`, `../x`, with `.ts`/`.tsx`/`/index.ts` and `.js`->`.ts`
// mapping) and reports what its top-level declarations SHOW:
//   - `export const NAME = "literal"` (or an expression-free template / `as const`) -> a value;
//   - `export function f(id, toolId) { return step$({ toolId, … }) }` (or an arrow) -> a factory.
// Not followed, so they stay unresolved: bare/aliased specifiers (`@x/y`, tsconfig paths),
// re-exports (`export { X } from`, `export *`), namespace imports, a constant defined by another
// constant or call. Never a guess: a miss is the same "unresolved" the single-module analysis gives.

interface ParsedModule {
  mtimeMs: number;
  consts: Map<string, string>;
  /** exported name -> declaration node (function or arrow/function-expression initializer) */
  fns: Map<string, ts.Node>;
  exportedConsts: Set<string>;
}

const cache = new Map<string, ParsedModule>();

function resolveFile(from: string, spec: string): string | undefined {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
  const base = path.resolve(path.dirname(from), spec);
  const stem = base.replace(/\.(m|c)?js$/, "");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    `${stem}.ts`,
    `${stem}.tsx`,
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile() && /\.tsx?$/.test(c)) return c;
    } catch {
      // not there
    }
  }
  return undefined;
}

function parseModule(file: string): ParsedModule | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const consts = new Map<string, string>();
  const fns = new Map<string, ts.Node>();
  const exportedConsts = new Set<string>();
  const exported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined || !isConst) continue;
        const v = stringLiteralValue(d.initializer);
        if (v !== undefined) {
          consts.set(d.name.text, v);
          if (exported(st)) exportedConsts.add(d.name.text);
        } else if (
          exported(st) &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          fns.set(d.name.text, d.initializer);
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name !== undefined && exported(st)) {
      fns.set(st.name.text, st);
    }
  }
  const parsed = { mtimeMs, consts, fns, exportedConsts };
  cache.set(file, parsed);
  return parsed;
}

/** Build the `importResolver` for one module (`undefined` when it imports nothing relative). */
export function createImportResolver(
  sourceFile: ts.SourceFile,
  absolutePath: string
): ((localName: string) => ImportedBinding | undefined) | undefined {
  const imports = new Map<string, { file: string; name: string }>();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const file = resolveFile(absolutePath, st.moduleSpecifier.text);
    if (file === undefined) continue;
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue;
        imports.set(el.name.text, { file, name: (el.propertyName ?? el.name).text });
      }
    }
  }
  if (imports.size === 0) return undefined;
  return (localName) => {
    const imp = imports.get(localName);
    if (imp === undefined) return undefined;
    const mod = parseModule(imp.file);
    if (mod === undefined) return undefined;
    if (mod.exportedConsts.has(imp.name)) return { value: mod.consts.get(imp.name) as string };
    const fn = mod.fns.get(imp.name);
    if (fn === undefined) return undefined;
    const factory = inferStepFactory(fn, (e) => {
      const lit = stringLiteralValue(e);
      if (lit !== undefined) return lit;
      return ts.isIdentifier(e) ? mod.consts.get(e.text) : undefined;
    });
    return factory === undefined ? undefined : { factory };
  };
}
