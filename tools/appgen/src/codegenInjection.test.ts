import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AppModel } from "./appModel";
import { applyChanges } from "./applyChanges";
import { planChangesDeterministic } from "./changeSpec";
import { wireGrantsIntoConfig } from "./configEditor";
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
import type { AppSpec, CapabilitySpec } from "./types";

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
  // Only already-present identifiers / no new identifier: invisible to an identifier-set oracle.
  nestedImport: 'x\n  await import("../../../tmp/evil.js"); //',
  nestedLoop: "x\n  for (;;); //",
  // Astral / invisible characters a BMP-only character class misses.
  tagCharacters: `hello\u{e0041}\u{e0042}\u{e0067} ${EXEC}`,
  tagWithNewline: `\u{e0001}\u{e0041}\n${EXEC}`,
  musicalFormatting: `a\u{1d173}b\u{1d17a}c ${EXEC}`,
  interlinearAnnotation: `a\ufff9b\ufffac\ufffb ${EXEC}`,
  combiningGraphemeJoiner: `a\u034fb ${EXEC}`,
  loneSurrogate: `a\ud800b ${EXEC}`,
};

/** Syntactic problems TypeScript reports for `source` (empty = parses cleanly). */
function syntaxErrors(source: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/**
 * The CODE of a file, in full: every node's SyntaxKind, recursively, with identifier and
 * numeric text kept and string / template / regex text blanked (comments are not nodes, so
 * they never appear). A payload that stays inside its comment or string literal leaves this
 * unchanged; one that adds ANY node anywhere - a top-level statement, or an
 * `await import("../../tmp/evil.js")` / `for(;;);` smuggled into a nested runner body -
 * changes it. (The earlier oracle compared only top-level statement kinds plus the
 * identifier set, which a nested injection of already-present identifiers did not move.)
 */
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

/** A copy of `spec` with every free-text field replaced by a benign constant. */
function neutralise(spec: AppSpec): AppSpec {
  return {
    ...spec,
    name: "app",
    capabilities: spec.capabilities.map((c) => ({
      ...c,
      name: "Name",
      intent: "benign",
      ...(c.reasoning === undefined
        ? {}
        : {
            reasoning: {
              ...(c.reasoning.baseModel === undefined ? {} : { baseModel: "m" }),
              ...(c.reasoning.elevateTo === undefined
                ? {}
                : { elevateTo: c.reasoning.elevateTo.map(() => "n") }),
            },
          }),
    })),
    ...(spec.compute === undefined ? {} : { compute: { target: "local" } }),
  };
}

function cap(over: Partial<CapabilitySpec>): CapabilitySpec {
  return { id: "plan", name: "Plan", intent: "benign", steps: ["run"], ...over };
}

const NET_NEW: AppModel = { root: "/nonexistent", isExisting: false, flows: [] };

describe.each(Object.entries(PAYLOADS))("codegen injection: %s", (_label, payload) => {
  it("an intent is inert in the generated flow file", () => {
    const baseline = astShape(generateFlows({ name: "a", capabilities: [cap({})] })[0]!.contents);
    const file = generateFlows({ name: "a", capabilities: [cap({ intent: payload })] })[0]!;
    expect(syntaxErrors(file.contents)).toEqual([]);
    const got = astShape(file.contents);
    expect(got).toEqual(baseline); // no extra node anywhere in the file
    expect(got).not.toContain("pwned");
  });

  it("reasoning model names are inert (comment sinks)", () => {
    const spec = {
      name: "a",
      capabilities: [
        cap({ reasoning: { baseModel: payload, elevateTo: [payload, `x${payload}`] } }),
      ],
    };
    const baseline = astShape(
      generateFlows({
        name: "a",
        capabilities: [cap({ reasoning: { baseModel: "m", elevateTo: ["n"] } })],
      })[0]!.contents
    );
    const file = generateFlows(spec)[0]!;
    expect(syntaxErrors(file.contents)).toEqual([]);
    expect(astShape(file.contents)).toEqual(baseline);
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
      expect(astShape(f.contents), f.path).toEqual(astShape(baseline.get(f.path) ?? ""));
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
      expect(astShape(f.contents), f.path).toEqual(astShape(b?.contents ?? ""));
    }
  });

  it("parseIntent output survives generation and adds no code", () => {
    const spec = parseIntent(payload);
    const baseline = new Map(generateProject(neutralise(spec)).map((f) => [f.path, f.contents]));
    for (const f of generateProject(spec)) {
      if (!f.path.endsWith(".ts")) continue;
      expect(syntaxErrors(f.contents), f.path).toEqual([]);
      expect(astShape(f.contents), f.path).toEqual(astShape(baseline.get(f.path) ?? ""));
    }
  });

  it("a grant name cannot break out of the generated GrantTable", () => {
    const r = wireGrantsIntoConfig(
      'import { defineConfig } from "@loom/app";\nexport default defineConfig({});\n',
      { [payload]: [payload] }
    );
    expect(syntaxErrors(r.after)).toEqual([]);
    expect(hasUnsafeChars(r.after.replace(/\n/g, ""))).toBe(false);
    const base = wireGrantsIntoConfig(
      'import { defineConfig } from "@loom/app";\nexport default defineConfig({});\n',
      { a: ["b"] }
    );
    expect(astShape(r.after)).toEqual(astShape(base.after));
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
    // one heading line; markdown/HTML metacharacters are escaped, not passed through
    expect(readme.split("\n")[0]).toBe("# app \\#\\# Pwn \\<script\\>x\\</script\\>");
    expect(readme).not.toContain("<script>");
    expect(readme.split("\n").filter((l) => /^#{1,6}\s/.test(l))).toEqual(
      expect.not.arrayContaining(["## Pwn <script>x</script>"])
    );
    const pkg = JSON.parse(files.find((f) => f.path === "package.json")?.contents ?? "{}");
    expect(pkg.name).toBe(name); // JSON-escaped, still one string
  });
});

describe("the AST oracle itself", () => {
  const base = generateFlows({ name: "a", capabilities: [cap({})] })[0]!.contents;
  it("is unchanged by comment / string text but sees any added node, nested or not", () => {
    expect(astShape(base.replace("benign", "other words"))).toBe(astShape(base));
    const nested = base.replace(
      "const out = await ctx.run(",
      'await import("../../../tmp/evil.js");\n  const out = await ctx.run('
    );
    expect(nested).not.toBe(base);
    expect(astShape(nested)).not.toBe(astShape(base));
    const loop = base.replace(
      "const out = await ctx.run(",
      "for (;;);\n  const out = await ctx.run("
    );
    expect(loop).not.toBe(base);
    expect(astShape(loop)).not.toBe(astShape(base));
  });
});

describe("emit helpers", () => {
  it("commentText leaves no line terminator", () => {
    for (const p of Object.values(PAYLOADS)) {
      expect(commentText(p)).not.toMatch(/[\r\n\u2028\u2029\u202e]/);
      expect(hasUnsafeChars(commentText(p))).toBe(false);
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
      expect(hasUnsafeChars(lit)).toBe(false);
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
  it("hasUnsafeChars flags astral format characters (tag chars, musical formatting) and U+034F", () => {
    for (const c of [
      "\u{e0001}",
      "\u{e0041}",
      "\u{e007f}",
      "\u{1d173}",
      "\u{1d17a}",
      "\ufff9",
      "\ufffb",
      "\u034f",
      "\u2065",
      "\ud800",
    ]) {
      expect(hasUnsafeChars(`a${c}b`), c.codePointAt(0)?.toString(16)).toBe(true);
    }
    expect(hasUnsafeChars("caf\u00e9 \u{1f600} \u4e2d")).toBe(false); // ordinary non-ASCII is fine
  });
  it("tsStringLiteral escapes an astral character as a surrogate pair", () => {
    expect(tsStringLiteral("a\u{e0041}")).toBe('"a\\udb40\\udc41"');
    expect(tsStringLiteral("\u{1d173}")).toBe('"\\ud834\\udd73"');
    expect(commentText("a\u{e0041}b")).toBe("a b");
  });
  it("assertSafeId accepts the strict new-id kebab-case only", () => {
    expect(assertSafeId("capability", "a-b-1")).toBe("a-b-1");
    for (const bad of ["", "-a", "A", "a b", 'a"', "a\n", "1a", "a-", "a--b", "a\u{e0041}"]) {
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
