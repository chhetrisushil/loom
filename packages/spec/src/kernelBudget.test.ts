import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ── Fitness function: the kernel does not grow by accident ────────────────────────────────────
//
// The kernel's CONTRACT is guarded at its edges: the ABI version, the syscall docs, layering, the
// capability list. Nothing guarded what goes INSIDE it, so features arrived as `kernel.features.*`
// flags and methods on one runtime class, and `WorkflowRuntime.ts` grew past 9,700 lines with the
// ABI unchanged. This guard makes that growth a decision instead of a drift.
//
// Every source file of the kernel package has a budget in `kernel-budget.json`, in CODE lines
// (lines holding a token: comments and blank lines are free, so documenting the kernel costs
// nothing). The rules:
//   1. a kernel source file with no budget fails (a new kernel file is a decision too);
//   2. a file over its budget fails;
//   3. a file UNDER its budget fails until the budget is lowered (the ratchet only tightens);
//   4. a budget for a file that no longer exists fails;
//   5. a budget's `adr` names an ADR file that exists (or is "baseline").
//
// To update: `LOOM_KERNEL_BUDGET_UPDATE=1 pnpm --filter @loom/spec exec vitest run kernelBudget`.
// Shrinking needs nothing more. Growing a file or adding one also needs
// `LOOM_KERNEL_BUDGET_ADR=<NNNN>`, the ADR that decided the kernel must hold this code (and why it
// cannot sit behind an existing seam in a 1P package); the entry records it, so the review sees
// the budget, the delta and the decision in the same diff.

const REPO_ROOT = resolve(__dirname, "../../..");
const KERNEL_DIR = "packages/workflow-runtime/src";
const BUDGET_FILE = resolve(__dirname, "../kernel-budget.json");
const ADR_DIR = resolve(REPO_ROOT, "docs/adr");

interface Entry {
  codeLines: number;
  /** The ADR that last RAISED this budget, or "baseline" for the figure the guard started from. */
  adr: string;
}
interface Budget {
  kernelDir: string;
  files: Record<string, Entry>;
}

/** Lines of `source` that hold at least one token: comments and blank lines do not count. */
function codeLines(source: string, fileName = "x.ts"): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const lines = new Set<number>();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source
  );
  // Each open brace pushes whether it opened a template substitution (`${`). Only the `}` that
  // closes one is rescanned as the template's continuation; any other `}` is a plain brace.
  const braces: boolean[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.OpenBraceToken) braces.push(false);
    else if (kind === ts.SyntaxKind.TemplateHead) braces.push(true);
    else if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (braces.pop() === true) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateMiddle) braces.push(true);
      }
    }
    const start = sf.getLineAndCharacterOfPosition(scanner.getTokenStart()).line;
    const end = sf.getLineAndCharacterOfPosition(scanner.getTokenEnd()).line;
    for (let l = start; l <= end; l++) lines.add(l);
  }
  return lines.size;
}

function kernelSources(): string[] {
  return readdirSync(resolve(REPO_ROOT, KERNEL_DIR), { withFileTypes: true, recursive: true })
    .filter(
      (d) =>
        d.isFile() &&
        d.name.endsWith(".ts") &&
        !d.name.endsWith(".test.ts") &&
        !d.name.endsWith(".d.ts") &&
        !d.name.includes(".fixture.")
    )
    .map((d) => {
      const dir = (d as { parentPath?: string }).parentPath ?? (d as { path?: string }).path ?? "";
      return resolve(dir, d.name).slice(resolve(REPO_ROOT, KERNEL_DIR).length + 1);
    })
    .sort();
}

function measure(): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of kernelSources()) {
    out.set(f, codeLines(readFileSync(resolve(REPO_ROOT, KERNEL_DIR, f), "utf8"), f));
  }
  return out;
}

const adrExists = (adr: string): boolean =>
  adr === "baseline" ||
  (/^\d{4}$/.test(adr) && readdirSync(ADR_DIR).some((f) => f.startsWith(`${adr}-`)));

function update(budget: Budget, measured: Map<string, number>): Budget {
  const adr = process.env.LOOM_KERNEL_BUDGET_ADR;
  const grown = [...measured].filter(([f, n]) => n > (budget.files[f]?.codeLines ?? -1));
  // "baseline" seeds an EMPTY budget once; it never raises an existing one.
  const seeding = adr === "baseline" && Object.keys(budget.files).length === 0;
  if (
    grown.length > 0 &&
    !seeding &&
    (adr === undefined || !adrExists(adr) || adr === "baseline")
  ) {
    throw new Error(
      `kernel budget: ${grown.map(([f, n]) => `${f} (${budget.files[f]?.codeLines ?? "new"} -> ${n})`).join(", ")} grew. Set LOOM_KERNEL_BUDGET_ADR=<NNNN> to the ADR that decided the kernel holds this code (docs/adr/NNNN-*.md must exist).`
    );
  }
  const files: Record<string, Entry> = {};
  for (const [f, n] of measured) {
    const prev = budget.files[f];
    files[f] = {
      codeLines: n,
      adr: prev !== undefined && n <= prev.codeLines ? prev.adr : (adr as string),
    };
  }
  return { kernelDir: budget.kernelDir, files };
}

describe("kernel budget (the kernel does not grow by accident)", () => {
  it("counts code lines, not comments or blank lines", () => {
    const src = [
      "/** A doc comment",
      " * over three lines */",
      "",
      "// a line comment",
      'const url = "http://x"; // a trailing comment',
      "const t = `a",
      "${url}",
      "b`;",
      "/* inline */ export const n = 1;",
    ].join("\n");
    expect(codeLines(src)).toBe(5);
  });

  it("a plain closing brace is not mistaken for a template's continuation", () => {
    // The regression: rescanning every `}` as a template tail swallowed the comments up to the
    // next backtick and counted them as code.
    const src = [
      "function f() {",
      "  return 1;",
      "}",
      "// one",
      "// two",
      "/* three",
      "   four */",
      "const s = `x${f()}y${ { a: 1 }.a }z`;",
    ].join("\n");
    expect(codeLines(src)).toBe(4);
  });

  it("every kernel source file is within its budget, and every budget is tight", () => {
    const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Budget;
    expect(budget.kernelDir).toBe(KERNEL_DIR);
    const measured = measure();

    if (process.env.LOOM_KERNEL_BUDGET_UPDATE === "1") {
      writeFileSync(BUDGET_FILE, `${JSON.stringify(update(budget, measured), null, 2)}\n`);
      return;
    }

    const problems: string[] = [];
    for (const [f, n] of measured) {
      const entry = budget.files[f];
      if (entry === undefined)
        problems.push(`${f}: new kernel file with no budget (${n} code lines)`);
      else if (n > entry.codeLines)
        problems.push(`${f}: ${n} code lines, over its budget of ${entry.codeLines}`);
      else if (n < entry.codeLines)
        problems.push(`${f}: ${n} code lines, under its budget of ${entry.codeLines}; lower it`);
    }
    for (const f of Object.keys(budget.files)) {
      if (!measured.has(f)) problems.push(`${f}: budgeted but no longer exists; remove it`);
    }
    for (const [f, e] of Object.entries(budget.files)) {
      if (!adrExists(e.adr)) problems.push(`${f}: adr "${e.adr}" names no file in docs/adr`);
    }
    expect(
      problems,
      `${problems.join("\n")}\n\nSee the header of packages/spec/src/kernelBudget.test.ts to update the budget.`
    ).toEqual([]);
  });

  it("the budget file sits where the guard reads it", () => {
    expect(existsSync(BUDGET_FILE)).toBe(true);
  });
});
