import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ── Fitness function: never read an LLM message's content RAW ────────────────
//
// Since R5 (ADR 0120) `LlmMessage.content` is `string | LlmContentPart[]`. A raw read such as
// `req.messages.map((m) => m.content).join(" ")`, `${m.content}` or `{ text: m.content }` passed to an
// untyped `JSON.stringify` still TYPE-CHECKS, and a parts message silently becomes "[object Object]" or
// a JSON array. This scanner finds those sites using the type checker (not a regex): a property access,
// or a destructured binding, whose type is the `LlmMessageContent` alias, in a position that does not
// preserve the union. The legitimate way to read it is `textOf` / `toParts` / a `typeof` branch.

const REPO_ROOT = resolve(__dirname, "../../..");
const ROOTS = ["packages", "plugins", "tools"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".vite", "coverage", "build", ".git"]);

/** The aliases whose raw read is the hazard. */
const CONTENT_ALIASES = new Set(["LlmMessageContent", "LlmMessageContentInput"]);
/** Functions that exist to read content safely (or to branch on its shape). */
const SAFE_CALLEES = new Set(["textOf", "toParts", "hasStructuredParts", "isArray"]);

interface RawContentFinding {
  file: string;
  line: number;
  text: string;
}

interface RawContentScan {
  findings: RawContentFinding[];
  /** Every typed `LlmMessageContent` access seen, flagged or not — the non-vacuity evidence. */
  examined: Map<string, number>;
}

function hasContentAlias(type: ts.Type): boolean {
  const alias = type.aliasSymbol?.getName();
  return alias !== undefined && CONTENT_ALIASES.has(alias);
}

/**
 * Whether `type` is the content union, nullable or not. `m?.content` is `LlmMessageContent | undefined`,
 * which loses the alias, so the nullable is stripped first and, failing the alias, the shape is matched:
 * a union of a string and an array of objects that carry a `type` discriminant (`LlmContentPart[]`).
 */
function isContentType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (hasContentAlias(type)) return true;
  const bare = checker.getNonNullableType(type);
  if (hasContentAlias(bare)) return true;
  if (!bare.isUnion()) return false;
  const hasString = bare.types.some((t) => (t.flags & ts.TypeFlags.StringLike) !== 0);
  const hasPartsArray = bare.types.some((t) => {
    if (!checker.isArrayType(t)) return false;
    const el = checker.getTypeArguments(t as ts.TypeReference)[0];
    return el !== undefined && el.getProperty("type") !== undefined;
  });
  return hasString && hasPartsArray;
}

/** Whether the contextual type at `node` is itself a content type (a type-preserving pass-through). */
function preservesUnion(checker: ts.TypeChecker, node: ts.Expression): boolean {
  const ctx = checker.getContextualType(node);
  if (ctx === undefined) return false;
  if (isContentType(checker, ctx)) return true;
  // `LlmMessage["content"]` etc. resolve to the same union without the alias on the contextual side.
  if (ctx.isUnion()) {
    const hasString = ctx.types.some((t) => (t.flags & ts.TypeFlags.StringLike) !== 0);
    const hasArray = ctx.types.some((t) => checker.isArrayType(t));
    return hasString && hasArray;
  }
  return false;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** True when this read is one of the safe shapes: a safe-callee argument, a `typeof` operand, a pass-through. */
function isSafeUse(checker: ts.TypeChecker, node: ts.Expression): boolean {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent))
    parent = parent.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node)) {
    const name = calleeName(parent);
    if (name !== undefined && SAFE_CALLEES.has(name)) return true;
  }
  // `x === "..."`: comparing to a literal never coerces the parts form into text.
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return true;
  }
  // `const content = m.content` re-types as the same union; its later reads are what get checked.
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return true;
  // A callback's result is inferred, not declared: `ms.map((m) => m.content)` has the union as its
  // contextual type only because inference put it there. The array it builds is what gets coerced.
  if (isInferredCallbackResult(node, parent)) return false;
  return preservesUnion(checker, node);
}

/** Whether an identifier is a value read (not a declaration name, member name, label or type reference). */
function isReadPosition(checker: ts.TypeChecker, id: ts.Identifier): boolean {
  const p = id.parent;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isFunctionLike(p) ||
      ts.isTypeReferenceNode(p)) &&
    (p as { name?: ts.Node }).name === id
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  // Only variables/parameters/properties are value reads (not a type alias or an import specifier).
  const sym = checker.getSymbolAtLocation(id);
  return (
    sym !== undefined && (sym.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) !== 0
  );
}

function isInferredCallbackResult(node: ts.Expression, parent: ts.Node): boolean {
  let fn: ts.Node | undefined;
  if (ts.isArrowFunction(parent) && parent.body === node) fn = parent;
  else if (ts.isReturnStatement(parent)) {
    for (let p: ts.Node | undefined = parent.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) {
        fn = p;
        break;
      }
    }
  }
  if (fn === undefined || !ts.isFunctionLike(fn) || fn.type !== undefined) return false;
  return (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(fn.parent);
}

const SOURCE_EXT = /\.(ts|tsx|mts)$/;
const DECLARATION_OR_TEST = /(\.d\.(ts|mts)|\.(perf\.)?test\.(ts|tsx|mts))$/;

function walkSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".tmp")) walk(resolve(dir, entry.name));
      } else if (SOURCE_EXT.test(entry.name) && !DECLARATION_OR_TEST.test(entry.name)) {
        out.push(resolve(dir, entry.name));
      }
    }
  };
  for (const root of ROOTS) walk(resolve(REPO_ROOT, root));
  return out;
}

/** Source files worth type-checking: only those that mention `content` can contain a read of it. */
function candidateFiles(): string[] {
  return walkSourceFiles().filter((f) => /\bcontent\b/.test(readFileSync(f, "utf8")));
}

/**
 * Scan `files` (default: every candidate under packages/plugins/tools) with the TypeScript checker.
 * `libFiles` are extra root files (e.g. a fixture) scanned the same way.
 */
function scanRawMessageContent(files: string[] = candidateFiles()): RawContentScan {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    types: ["node"],
    typeRoots: [resolve(REPO_ROOT, "node_modules/@types")],
  });
  const checker = program.getTypeChecker();
  const findings: RawContentFinding[] = [];
  const examined = new Map<string, number>();
  const wanted = new Set(files.map((f) => resolve(f)));

  for (const sf of program.getSourceFiles()) {
    if (!wanted.has(resolve(sf.fileName))) continue;
    const rel = relative(REPO_ROOT, sf.fileName);
    const record = (node: ts.Node, flagged: boolean): void => {
      examined.set(rel, (examined.get(rel) ?? 0) + 1);
      if (!flagged) return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      findings.push({ file: rel, line: line + 1, text: node.getText(sf) });
    };
    const typeIsContent = (n: ts.Node): boolean =>
      isContentType(checker, checker.getTypeAtLocation(n));
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "content") {
        if (typeIsContent(node)) record(node, !isSafeUse(checker, node));
      } else if (
        ts.isElementAccessExpression(node) &&
        (ts.isStringLiteral(node.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
        node.argumentExpression.text === "content"
      ) {
        // `m["content"]` is the same read as `m.content`.
        if (typeIsContent(node)) record(node, !isSafeUse(checker, node));
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        (node.propertyName ?? node.name).getText(sf) === "content"
      ) {
        // `const { content } = message` hides the property access; the binding is the raw read.
        if (typeIsContent(node)) record(node, true);
      } else if (ts.isIdentifier(node) && isReadPosition(checker, node)) {
        // An alias (`const c = m.content`) carries the union; a later `${c}` is the raw read.
        if (typeIsContent(node)) record(node, !isSafeUse(checker, node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { findings, examined };
}

// ── Allowlist ────────────────────────────────────────────────────────────────
// Files that legitimately handle BOTH shapes (they branch on the type, or ARE the helper).
// Every entry must still contain at least one typed content access, or it is stale.
const ALLOWLIST: Record<string, string> = {};

describe("no raw LLM message content reads (R5, ADR 0120)", () => {
  const scan = scanRawMessageContent();

  it("loom's own source reads message content only through textOf/toParts or a type branch", () => {
    const bad = scan.findings.filter((f) => ALLOWLIST[f.file] === undefined);
    const detail = bad.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
    expect(
      bad,
      `raw LlmMessage.content read: a parts message becomes "[object Object]". Use textOf(content) or branch on typeof:\n${detail}`
    ).toEqual([]);
  });

  it("is not vacuous: the scan resolved typed content accesses, and every allowlist entry is live", () => {
    // If @loom/llm's dist is missing the alias resolves to `any` and nothing is ever flagged.
    expect(scan.examined.size).toBeGreaterThanOrEqual(3);
    // .tsx and .mts sources are walked too (plugins/renderer-react is .tsx).
    expect(walkSourceFiles().some((f) => f.endsWith(".tsx"))).toBe(true);
    for (const file of Object.keys(ALLOWLIST)) {
      expect(
        scan.examined.get(file) ?? 0,
        `${file} no longer reads content; drop it from the allowlist`
      ).toBeGreaterThan(0);
    }
  });

  it("FAILS on a planted bad snippet (and passes the safe shapes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-rawcontent-"));
    try {
      // Resolve @loom/llm through the repo's own node_modules by living under the repo is not possible
      // for a tmp dir, so the fixture declares the same alias locally.
      const fixture = join(dir, "fixture.ts");
      const source = `type LlmContentPart = { type: "text"; text: string } | { type: "image"; data: string };
export type LlmMessageContent = string | LlmContentPart[];
interface LlmMessage { role: "user"; content: LlmMessageContent }
declare function textOf(c: LlmMessageContent | undefined): string;
declare function takesString(s: string): void;
declare function takesAny(a: any): void;
function bad(ms: LlmMessage[], m: LlmMessage, o?: LlmMessage) {
  const joined = ms.map((x) => x.content).join(" ");   // BAD
  const tpl = \`\${m.content}\`;                       // BAD
  takesAny({ text: m.content });                       // BAD
  const { content } = m;                               // BAD
  const c = m.content;
  const viaAlias = \`\${c}\`;                           // BAD alias
  const q = \`\${o?.content}\`;                         // BAD optional chain
  const e = \`\${m["content"]}\`;                       // BAD element access
  const qe = [o?.["content"]].join(",");               // BAD optional element access
  return [joined, tpl, viaAlias, q, e, qe];
}
function good(m: LlmMessage, o?: LlmMessage): LlmMessage {
  const t = textOf(m.content);
  if (typeof m.content === "string") takesString(m.content);
  const c = m.content;
  const t2 = textOf(c);
  const t3 = textOf(o?.content);
  const t4 = textOf(m["content"]);
  const t5 = textOf(o?.["content"]);
  if (typeof c === "string") takesString(c);
  return { role: "user", content: m.content, ...(t || t2 || t3 || t4 || t5 ? {} : {}) };
}
`;
      writeFileSync(fixture, source);
      const bad = source.split("\n").flatMap((l, i) => (l.includes("// BAD") ? [i + 1] : []));
      const { findings } = scanRawMessageContent([fixture]);
      expect(bad).toHaveLength(8);
      expect(findings.map((f) => f.line)).toEqual(bad);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
