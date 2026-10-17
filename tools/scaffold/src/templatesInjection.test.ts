import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FLOW_TEMPLATES, templateFiles } from "./flowTemplates";
import {
  agentFile,
  flowFile,
  flowTestFile,
  memoryFile,
  projectionFile,
  scheduleFile,
  sentinelFile,
  skillFile,
  toolFile,
} from "./templates";

// The `loom new` templates are validated upstream (`constructNameProblem`), but they are exported,
// so each sink also escapes: a hostile name must either THROW or yield code with exactly the
// same syntax tree as a benign spelling of the same words.

const EXEC = "globalThis.pwned = 1;";
const HOSTILE: Record<string, string> = {
  newline: `x\n${EXEC}`,
  lineSeparator: `x\u2028${EXEC}`,
  paragraphSeparator: `x\u2029${EXEC}`,
  quote: `x"; ${EXEC} "`,
  backtick: "x`${globalThis.pwned = 1}`",
  blockClose: `x */ ${EXEC} /*`,
  backslash: "x\\",
  bidi: `x\u202e${EXEC}`,
  // Only whitespace separators: these DERIVE a valid identifier, so the string / comment /
  // template-literal sinks are what keeps them inert.
  newlineWord: "x\nglobalThis",
  lineSeparatorWord: "x\u2028globalThis",
  spaceWord: "x globalThis",
};
const INERT = ["newlineWord", "lineSeparatorWord", "spaceWord"];

function astShape(source: string): string {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.ES2022, true);
  const BLANK = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
  ]);
  const walk = (n: ts.Node): string => {
    const kind = ts.SyntaxKind[n.kind] as string;
    if (BLANK.has(n.kind)) return kind;
    if (ts.isIdentifier(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) {
      return `${kind}:${n.text}`;
    }
    const kids: string[] = [];
    ts.forEachChild(n, (c) => {
      kids.push(walk(c));
    });
    return kids.length === 0 ? kind : `${kind}(${kids.join(",")})`;
  };
  return walk(sf);
}

function syntaxErrors(source: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const GENERATORS: Record<string, (name: string) => string> = {
  flowFile,
  flowTestFile,
  sentinelFile,
  toolFile,
  agentFile,
  skillFile,
  scheduleFile,
  memoryFile,
  projectionFile,
  ...Object.fromEntries(
    FLOW_TEMPLATES.filter((t) => t !== "echo").flatMap((t) => [
      [`${t}.flow`, (n: string) => templateFiles(t, n).flow],
      [`${t}.test`, (n: string) => templateFiles(t, n).test],
    ])
  ),
};

describe("scaffold templates are inert for a hostile name", () => {
  for (const [gen, fn] of Object.entries(GENERATORS)) {
    for (const [label, name] of Object.entries(HOSTILE)) {
      it(`${gen} / ${label}`, () => {
        let out: string;
        try {
          out = fn(name);
        } catch (e) {
          // Refusing is fine - but not for the names that derive a valid identifier.
          expect(INERT).not.toContain(label);
          expect((e as Error).message).toMatch(/identifier/);
          return;
        }
        expect(syntaxErrors(out)).toEqual([]);
        expect(out).not.toMatch(/[\u2028\u2029\u202e]/);
        const benign = fn(name.replace(/\s/g, "-"));
        expect(astShape(out)).toBe(astShape(benign));
      });
    }
  }

  it("the inert names are really generated (the sinks, not a throw, keep them safe)", () => {
    for (const label of INERT) {
      const out = flowFile(HOSTILE[label] as string);
      expect(out).toContain("XGlobalThis");
      expect(out).not.toContain("\n  globalThis");
    }
  });
});
