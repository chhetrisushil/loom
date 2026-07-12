import ts from "typescript";

// ── Stage 4 validation: in-process TypeScript diagnostics ────────────────────
//
// The real correctness gate for generated/edited code is `tsc --noEmit`: it catches the
// mistakes an AI planner actually makes — bad imports, wrong step signatures, unresolved
// symbols, malformed edits. We run it in-process via the compiler API (no shell) so the
// diagnostics are structured and can be fed back to a model in the self-repair loop.
// We deliberately do NOT use `loom check`: that reads a post-build compiler manifest,
// which freshly-written source does not have.
//
// Note: typechecking a NET-NEW project requires its dependencies to be installed; without
// them, module-resolution errors dominate. Validation is therefore most useful for
// brownfield edits inside an already-installed app, and is best-effort otherwise.

export interface Diagnostic {
  file?: string;
  line?: number;
  message: string;
}

export interface TypecheckResult {
  ok: boolean;
  /** No tsconfig.json was found under the directory — nothing was checked. */
  skipped: boolean;
  diagnostics: Diagnostic[];
}

function formatDiagnostic(d: ts.Diagnostic): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (d.file !== undefined && d.start !== undefined) {
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return { file: d.file.fileName, line: line + 1, message };
  }
  return { message };
}

/**
 * Typecheck the app rooted at `dir` using its `tsconfig.json`. Returns structured
 * diagnostics (empty ⇒ clean). If there is no tsconfig, returns `skipped: true` rather
 * than failing — a net-new project that hasn't been installed yet can't be typechecked.
 */
export function typecheck(dir: string): TypecheckResult {
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) return { ok: true, skipped: true, diagnostics: [] };

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    return { ok: false, skipped: false, diagnostics: [formatDiagnostic(configFile.error)] };
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    configPath.slice(0, configPath.lastIndexOf("/") + 1) || "./"
  );
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program).map(formatDiagnostic);
  return { ok: diagnostics.length === 0, skipped: false, diagnostics };
}
