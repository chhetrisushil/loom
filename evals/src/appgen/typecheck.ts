import { join, relative, sep } from "node:path";
import ts from "typescript";

// ── The tight typecheck behind "plan validity" ────────────────────────────────────────────────────────────────
//
// A generated or edited flow file must typecheck, but NOT under the repo build: that is 70 packages and minutes.
// This checks exactly the files it is handed (the fixture's `app/flows/*/flow.ts`) with `tsc --noEmit` semantics,
// in-process through the compiler API.
//
//   - ONE shared compiler host per checker: the SourceFiles of everything outside the fixture (the TypeScript lib,
//     `@loom/core`, `@loom/workflow-runtime`, `zod` .d.ts) are parsed once and reused by every program, so the
//     second case onward costs only the few new flow files. Fixture files are always re-read (they differ per case).
//   - A bare import in a fixture file ("@loom/core", "zod") is resolved FROM THIS PACKAGE (`evals/node_modules`,
//     i.e. the workspace's built `dist`), not from the temp directory, which has no node_modules. Relative imports
//     resolve normally.
//   - `types: []` and `skipLibCheck`: no @types scan, and no diagnostics from dependency declarations.
//
// The options mirror `tsconfig.base.json` (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess), so a flow
// that passes here passes in a real app.

export interface TypecheckDiagnostic {
  /** Path relative to the checked root (never an absolute temp path), or "" for a global diagnostic. */
  file: string;
  line: number;
  code: number;
  message: string;
}

export interface Typechecker {
  /** Typecheck `files` (paths relative to `root`). Empty result = clean. */
  check(root: string, files: readonly string[]): TypecheckDiagnostic[];
  /** Programs built so far (a test asserts the host is shared: this grows, the lib parses do not). */
  readonly programs: number;
  /** SourceFiles parsed for files OUTSIDE the fixtures, i.e. what the shared host saved re-parsing. */
  readonly sharedParses: number;
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  noEmit: true,
  types: [],
};

/** A file inside this package, so a bare specifier resolves against `evals/node_modules`. */
const ANCHOR = join(__dirname, "typecheck.ts");

const flat = (m: string | ts.DiagnosticMessageChain): string =>
  ts.flattenDiagnosticMessageText(m, "\n");

export function createTypechecker(): Typechecker {
  const host = ts.createCompilerHost(OPTIONS, true);
  const shared = new Map<string, ts.SourceFile | undefined>();
  const roots = new Set<string>();
  const insideFixture = (f: string): boolean => {
    for (const r of roots) if (f === r || f.startsWith(r + sep)) return true;
    return false;
  };
  const origGet = host.getSourceFile.bind(host);
  let sharedParses = 0;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (insideFixture(fileName)) {
      return origGet(fileName, languageVersionOrOptions, onError, shouldCreate);
    }
    if (!shared.has(fileName)) {
      sharedParses++;
      shared.set(fileName, origGet(fileName, languageVersionOrOptions, onError, shouldCreate));
    }
    return shared.get(fileName);
  };
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), (f) => f, OPTIONS);
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, options) =>
    literals.map((lit) => {
      const name = lit.text;
      const from = name.startsWith(".") ? containingFile : ANCHOR;
      return ts.resolveModuleName(name, from, options, host, cache, redirected);
    });

  let programs = 0;
  return {
    get programs() {
      return programs;
    },
    get sharedParses() {
      return sharedParses;
    },
    check(root, files) {
      roots.add(root);
      const program = ts.createProgram(
        files.map((f) => join(root, f)),
        OPTIONS,
        host
      );
      programs++;
      return ts.getPreEmitDiagnostics(program).map((d) => {
        const message = flat(d.messageText).split(root).join("<root>");
        if (d.file !== undefined && d.start !== undefined) {
          return {
            file: relative(root, d.file.fileName),
            line: d.file.getLineAndCharacterOfPosition(d.start).line + 1,
            code: d.code,
            message,
          };
        }
        return { file: "", line: 0, code: d.code, message };
      });
    },
  };
}

export const formatDiagnostic = (d: TypecheckDiagnostic): string =>
  `TS${d.code} ${d.file === "" ? "" : `${d.file}(${d.line}) `}${d.message}`;
