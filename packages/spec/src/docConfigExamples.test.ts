import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ── Fitness function: documented config examples use options that exist ──────
//
// An audit found the API reference teaching `storage: { kind: "sqlite" }`, which ran normally and
// lost every event on restart, and a `LoomConfig` block of flat keys that throw at boot. Prose and
// other docs had drifted the same way: `sqliteStorage({ path })`, `new WorkflowRuntime({
// observability })`. Nothing could see it, because doc snippets are never compiled, and most cannot
// be: they use variables they never define.
//
// So this reads the examples rather than running them. Every `defineConfig({...})`, storage preset
// and `new WorkflowRuntime({...})` in a code block is parsed, and its keys are checked against the
// option lists read out of the source, so the docs and the check cannot disagree with the code.
//
// It checks option NAMES, not values or whether an example would pass `security.strict`. Dated
// records (ADRs, requirements, decks) stay out, because they describe what was true when written.

const ROOT = resolve(__dirname, "../../..");
const HISTORY = /^docs\/(adr|requirements|presentation|loom-2\.0|superpowers)\//;

function parseSource(path: string): ts.SourceFile {
  const file = resolve(ROOT, path);
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

const nameOf = (name: ts.PropertyName | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;

function membersOf(source: ts.SourceFile, interfaceName: string): Set<string> {
  const found = source.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === interfaceName
  );
  if (found === undefined) throw new Error(`no interface ${interfaceName} in ${source.fileName}`);
  const names = found.members.map((m) => nameOf(m.name)).filter((n) => n !== undefined);
  return new Set(names);
}

/** `GROUPED_OPTIONS`, read from the source: group name to the options that live in it. */
function groupedOptions(source: ts.SourceFile): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "GROUPED_OPTIONS"
    ) {
      const walk = (n: ts.Node): void => {
        if (
          ts.isArrayLiteralExpression(n) &&
          n.elements.length === 2 &&
          ts.isStringLiteral(n.elements[0] as ts.Expression) &&
          ts.isArrayLiteralExpression(n.elements[1] as ts.Expression)
        ) {
          const [group, options] = n.elements as unknown as [
            ts.StringLiteral,
            ts.ArrayLiteralExpression,
          ];
          groups.set(
            group.text,
            new Set(options.elements.filter(ts.isStringLiteral).map((e) => e.text))
          );
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return groups;
}

const defineConfigSource = parseSource("packages/app/src/defineConfig.ts");
const CONFIG_KEYS = membersOf(defineConfigSource, "LoomConfig");
const GROUPS = groupedOptions(defineConfigSource);
const RUNTIME_DEPS = membersOf(
  parseSource("packages/workflow-runtime/src/WorkflowRuntime.ts"),
  "WorkflowRuntimeDeps"
);
const PRESETS = new Map([
  ["sqliteStorage", membersOf(parseSource("plugins/sqlite/src/preset.ts"), "SqliteStorageOptions")],
  [
    "postgresStorage",
    membersOf(parseSource("plugins/postgres/src/preset.ts"), "PostgresStorageOptions"),
  ],
]);
const STORAGE_KINDS = new Set(["memory", "custom"]);

function keysOf(object: ts.ObjectLiteralExpression): Array<[string, ts.ObjectLiteralElementLike]> {
  const out: Array<[string, ts.ObjectLiteralElementLike]> = [];
  for (const property of object.properties) {
    const name = ts.isSpreadAssignment(property) ? undefined : nameOf(property.name);
    if (name !== undefined) out.push([name, property]);
  }
  return out;
}

const valueOf = (property: ts.ObjectLiteralElementLike): ts.Expression | undefined =>
  ts.isPropertyAssignment(property) ? property.initializer : undefined;

function checkStorage(value: ts.Expression | undefined, report: (m: string) => void): void {
  if (value === undefined || !ts.isObjectLiteralExpression(value)) return;
  for (const [key, property] of keysOf(value)) {
    if (key !== "kind") continue;
    const kind = valueOf(property);
    if (kind !== undefined && ts.isStringLiteral(kind) && !STORAGE_KINDS.has(kind.text)) {
      report(`storage kind "${kind.text}" does not exist`);
    }
  }
}

function checkConfig(config: ts.ObjectLiteralExpression, report: (m: string) => void): void {
  for (const [key, property] of keysOf(config)) {
    if (!CONFIG_KEYS.has(key)) {
      const group = [...GROUPS].find(([, options]) => options.has(key))?.[0];
      report(
        group === undefined
          ? `defineConfig has no option "${key}"`
          : `flat "${key}" throws at boot: it is ${group}.${key}`
      );
    }
    const value = valueOf(property);
    if (key === "storage") checkStorage(value, report);
    const options = GROUPS.get(key);
    if (options !== undefined && value !== undefined && ts.isObjectLiteralExpression(value)) {
      for (const [option] of keysOf(value)) {
        if (!options.has(option)) report(`${key} has no option "${option}"`);
      }
    }
  }
}

/** Every problem with the config-shaped calls in one code block. */
function problemsIn(code: string): string[] {
  // A migration note shows the old form on purpose, and says so on its first line.
  if (/^\s*\/\/ before\b/.test(code)) return [];
  const problems: string[] = [];
  const report = (message: string): void => {
    problems.push(message);
  };
  // Another tool's `defineConfig`, such as Vite's in the compiler guide, is not ours to check.
  const foreign = /import\s*\{[^}]*\bdefineConfig\b[^}]*\}\s*from\s*["'](?!@loom\/)/.test(code);
  const source = ts.createSourceFile("block.ts", code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        const callee = node.expression.text;
        if (callee === "defineConfig" && !foreign) checkConfig(argument, report);
        const preset = PRESETS.get(callee);
        if (preset !== undefined) {
          for (const [option] of keysOf(argument)) {
            if (!preset.has(option)) report(`${callee} has no option "${option}"`);
          }
        }
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "WorkflowRuntime"
    ) {
      const argument = node.arguments?.[0];
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        for (const [option] of keysOf(argument)) {
          if (!RUNTIME_DEPS.has(option)) report(`WorkflowRuntime has no dep "${option}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

const FENCES = [
  /^\s*```(?:ts|typescript|tsx|js|javascript)\b[^\n]*\n([\s\S]*?)^\s*```/gm,
  /^\s*#\+begin_src\s+(?:ts|typescript|tsx|js|javascript)\b[^\n]*\n([\s\S]*?)^\s*#\+end_src/gim,
];

function docs(): string[] {
  return execFileSync("git", ["ls-files", "*.md", "*.org"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && !HISTORY.test(f) && f !== "CHANGELOG.md");
}

describe("documented config examples", () => {
  it("reads real option lists from the source", () => {
    expect(CONFIG_KEYS.has("storage")).toBe(true);
    expect(CONFIG_KEYS.has("onEvent")).toBe(false);
    expect(GROUPS.get("observability")?.has("onEvent")).toBe(true);
    expect(RUNTIME_DEPS.has("onDurableEvent")).toBe(true);
    expect(PRESETS.get("sqliteStorage")?.has("dir")).toBe(true);
    expect(PRESETS.get("postgresStorage")?.has("url")).toBe(true);
  });

  it("fires on each mistake it exists to catch", () => {
    const cases: Array<[string, RegExp]> = [
      ['defineConfig({ storage: { kind: "sqlite", dir: ".data" } })', /kind "sqlite"/],
      ["defineConfig({ onEvent: () => {} })", /flat "onEvent" throws.*observability\.onEvent/],
      ["defineConfig({ nonsense: 1 })", /no option "nonsense"/],
      ["defineConfig({ observability: { onEvnt: f } })", /observability has no option "onEvnt"/],
      ['sqliteStorage({ path: "app.db" })', /sqliteStorage has no option "path"/],
      ["postgresStorage({ uri })", /postgresStorage has no option "uri"/],
      ["new WorkflowRuntime({ observability: { onEvent } })", /no dep "observability"/],
    ];
    for (const [code, expected] of cases) {
      expect(problemsIn(code).join("\n")).toMatch(expected);
    }
  });

  it("accepts correct and partial examples, and leaves other tools alone", () => {
    expect(problemsIn("// before       // now\ndefineConfig({ authorizer })")).toEqual([]);
    expect(
      problemsIn(`defineConfig({
        storage: sqliteStorage({ dir: ".data" }),
        ...shared,
        flows: [flow],
        observability: { onEvent, onDurableEvent },
        security: { strict: true, authorizer },
      })`)
    ).toEqual([]);
    expect(
      problemsIn('import { defineConfig } from "vite";\ndefineConfig({ plugins: [] })')
    ).toEqual([]);
  });

  it("every example in the docs uses options that exist", () => {
    const problems: string[] = [];
    let blocks = 0;
    for (const doc of docs()) {
      const text = readFileSync(resolve(ROOT, doc), "utf8");
      for (const fence of FENCES) {
        for (const match of text.matchAll(fence)) {
          blocks++;
          for (const problem of problemsIn(match[1] as string)) {
            const line = text.slice(0, match.index).split("\n").length;
            problems.push(`${doc}:${line}: ${problem}`);
          }
        }
      }
      // Prose and inline code teach it too, and no fence would catch these.
      for (const match of text.matchAll(/storage:\s*\{\s*kind:\s*["'](\w+)["']/g)) {
        if (!STORAGE_KINDS.has(match[1] as string)) {
          const line = text.slice(0, match.index).split("\n").length;
          problems.push(`${doc}:${line}: storage kind "${match[1]}" does not exist`);
        }
      }
    }
    expect(blocks).toBeGreaterThan(100); // the sweep itself cannot silently match nothing
    expect(problems).toEqual([]);
  });
});
