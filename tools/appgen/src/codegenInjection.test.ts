import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AppModel } from "./appModel";
import { applyChanges } from "./applyChanges";
import { planChangesDeterministic } from "./changeSpec";
import {
  assertSafeId,
  blockCommentText,
  commentText,
  hasUnsafeChars,
  markdownText,
  templateLiteralText,
  tsStringLiteral,
} from "./emit";
import { generateFlows, generateProject } from "./generate";
import { parseIntent } from "./parseIntent";
import { stepConstSource } from "./stepTemplate";
import type { CapabilitySpec } from "./types";

// Model-supplied (or user-typed) text is untrusted. Each payload below tries to leave
// its comment / string literal / template literal and run `globalThis.pwned = 1`.
const EXEC = "globalThis.pwned = 1;";
const PAYLOADS: Record<string, string> = {
  newline: `do a thing\n${EXEC}`,
  crlf: `do a thing\r\n${EXEC}`,
  lineSeparator: `do a thing\u2028${EXEC}`,
  paragraphSeparator: `do a thing\u2029${EXEC}`,
  blockClose: `do a thing */ ${EXEC} /*`,
  templateSubstitution: `\`\${${EXEC}}\``,
  doubleQuote: `"; ${EXEC} "`,
  backslash: `\\"; ${EXEC} //\\`,
  trailingBackslash: "ends with a backslash \\",
  scriptTag: `</script><script>${EXEC}</script>`,
  bidiOverride: `evil \u202e${EXEC}`,
};

/** Syntactic problems TypeScript reports for `source` (empty = parses cleanly). */
function syntaxErrors(source: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** What the CODE of a file is: its statement kinds and every identifier it mentions. */
function shape(source: string): { kinds: string[]; identifiers: string[] } {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.ES2022, true);
  const ids = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) ids.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return {
    kinds: sf.statements.map((s) => ts.SyntaxKind[s.kind] as string),
    identifiers: [...ids].sort(),
  };
}

function cap(over: Partial<CapabilitySpec>): CapabilitySpec {
  return { id: "plan", name: "Plan", intent: "benign", steps: ["run"], ...over };
}

const NET_NEW: AppModel = { root: "/nonexistent", isExisting: false, flows: [] };

describe.each(Object.entries(PAYLOADS))("codegen injection: %s", (_label, payload) => {
  it("an intent is inert in the generated flow file", () => {
    const baseline = shape(generateFlows({ name: "a", capabilities: [cap({})] })[0]!.contents);
    const file = generateFlows({ name: "a", capabilities: [cap({ intent: payload })] })[0]!;
    expect(syntaxErrors(file.contents)).toEqual([]);
    const got = shape(file.contents);
    expect(got).toEqual(baseline); // no extra statement, no extra identifier
    expect(got.identifiers).not.toContain("pwned");
  });

  it("reasoning model names are inert (comment sinks)", () => {
    const spec = {
      name: "a",
      capabilities: [
        cap({ reasoning: { baseModel: payload, elevateTo: [payload, `x${payload}`] } }),
      ],
    };
    const baseline = shape(
      generateFlows({
        name: "a",
        capabilities: [cap({ reasoning: { baseModel: "m", elevateTo: ["n"] } })],
      })[0]!.contents
    );
    const file = generateFlows(spec)[0]!;
    expect(syntaxErrors(file.contents)).toEqual([]);
    expect(shape(file.contents)).toEqual(baseline);
  });

  it("a whole new project built from the plan parses and adds no code", () => {
    const mk = (intent: string) =>
      generateProject({
        name: "app",
        capabilities: [cap({ intent })],
        compute: { target: "local" },
      });
    const baseline = new Map(mk("benign").map((f) => [f.path, f.contents]));
    for (const f of mk(payload)) {
      if (!f.path.endsWith(".ts")) continue;
      expect(syntaxErrors(f.contents), f.path).toEqual([]);
      expect(shape(f.contents), f.path).toEqual(shape(baseline.get(f.path) ?? ""));
    }
  });

  it("the deterministic planner (NL typed by a user) cannot inject either", () => {
    // No `create` directive: the whole input becomes the capability's intent verbatim.
    const plan = planChangesDeterministic(payload, NET_NEW);
    const planned = applyChanges(plan, NET_NEW);
    const baseline = applyChanges(planChangesDeterministic("benign", NET_NEW), NET_NEW);
    const flow = planned.creates.find((c) => c.path.endsWith("/flow.ts"));
    expect(flow).toBeDefined(); // a flow was still generated
    for (const f of planned.creates) {
      if (!f.path.endsWith(".ts")) continue;
      expect(syntaxErrors(f.contents), f.path).toEqual([]);
      const b = baseline.creates.find((c) => c.path === f.path);
      expect(shape(f.contents), f.path).toEqual(shape(b?.contents ?? ""));
    }
  });

  it("parseIntent output survives generation", () => {
    const spec = parseIntent(payload);
    for (const f of generateProject(spec)) {
      if (f.path.endsWith(".ts")) expect(syntaxErrors(f.contents), f.path).toEqual([]);
    }
  });

  it("the compute target cannot add markdown structure", () => {
    const files = generateProject({
      name: "app",
      capabilities: [cap({})],
      compute: { target: payload },
    });
    const readme = files.find((f) => f.path === "README.md")?.contents ?? "";
    const computeBlock = readme.slice(readme.indexOf("## Compute"));
    // exactly the template's own lines: heading, blank, one sentence on two lines, trailing
    expect(computeBlock.split(/\r\n|\n|\r|\u2028|\u2029/).length).toBe(5);
    expect(computeBlock).not.toContain("<script>");
  });
});

describe("codegen injection: identifiers", () => {
  const BAD = `x"; ${EXEC} ("`;
  it("a capability id that is not kebab-case is refused at the generator", () => {
    expect(() => generateFlows({ name: "a", capabilities: [cap({ id: BAD })] })).toThrow(
      /kebab-case/
    );
    expect(() => generateProject({ name: "a", capabilities: [cap({ id: BAD })] })).toThrow(
      /kebab-case/
    );
  });
  it("a step id that is not kebab-case is refused at the generator", () => {
    expect(() => generateFlows({ name: "a", capabilities: [cap({ steps: [BAD] })] })).toThrow(
      /kebab-case/
    );
    expect(() => stepConstSource("a`${EXEC}`")).toThrow(/kebab-case/);
  });
  it("the project name cannot start a new README section", () => {
    const name = "app\n\n## Pwn\n<script>x</script>";
    const files = generateProject({ name, capabilities: [cap({})] });
    const readme = files.find((f) => f.path === "README.md")?.contents ?? "";
    expect(readme.split("\n")[0]).toBe("# app ## Pwn <script>x</script>");
    const pkg = JSON.parse(files.find((f) => f.path === "package.json")?.contents ?? "{}");
    expect(pkg.name).toBe(name); // JSON-escaped, still one string
  });
});

describe("emit helpers", () => {
  it("commentText leaves no line terminator", () => {
    for (const p of Object.values(PAYLOADS)) {
      expect(commentText(p)).not.toMatch(/[\r\n\u2028\u2029\u202e]/);
    }
    expect(commentText("a\nb")).toBe("a b");
  });
  it("blockCommentText can never close or reopen a comment", () => {
    const t = blockCommentText("x */ y /* z");
    expect(t).not.toContain("*/");
    expect(t).not.toContain("/*");
  });
  it("tsStringLiteral round-trips and is a single line", () => {
    for (const p of Object.values(PAYLOADS)) {
      const lit = tsStringLiteral(p);
      expect(lit).not.toMatch(/[\r\n\u2028\u2029\u202e]/);
      expect(syntaxErrors(`const s = ${lit};`)).toEqual([]);
      expect(new Function(`return ${lit}`)()).toBe(p);
    }
  });
  it("templateLiteralText round-trips inside backticks", () => {
    for (const p of Object.values(PAYLOADS)) {
      const src = `const s = \`${templateLiteralText(p)}\`;`;
      expect(syntaxErrors(src)).toEqual([]);
      expect(new Function(`${src}; return s;`)()).toBe(p);
    }
  });
  it("markdownText is one line without markup metacharacters", () => {
    expect(markdownText("a\n# h <b>`c`")).toBe("a \\# h \\<b\\>\\`c\\`");
  });
  it("hasUnsafeChars flags controls but not ordinary punctuation", () => {
    expect(hasUnsafeChars("a\nb")).toBe(true);
    expect(hasUnsafeChars("a\u2028b")).toBe(true);
    expect(hasUnsafeChars("a\u007fb")).toBe(true);
    expect(hasUnsafeChars(`it's "fine" \`ok\` \${x} \\ </script> */`)).toBe(false);
  });
  it("assertSafeId accepts kebab-case only", () => {
    expect(assertSafeId("capability", "a-b-1")).toBe("a-b-1");
    for (const bad of ["", "-a", "A", "a b", 'a"', "a\n"]) {
      expect(() => assertSafeId("capability", bad)).toThrow();
    }
  });
});

describe("test sources", () => {
  it("contain no raw line-separator or bidi characters (payloads are written as escapes)", () => {
    for (const f of [__filename, `${__dirname}/emit.ts`]) {
      const text = readFileSync(f, "utf8");
      expect(hasUnsafeChars(text.replace(/[\n\t]/g, "")), f).toBe(false);
      expect(text, f).not.toContain("\r");
    }
  });
});
