import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ── Fitness function: every store DECORATOR runs the decorator conformance kit ─────
//
// ADR 0074 Amendment (L1). Six decorators had each silently dropped some optional EventStore
// method — `Coalescing(TenantScoped(backend))` lost every batch, an encrypted log could be
// neither retained nor compacted, the audit chain lost enumeration — and nothing noticed,
// because `runEventStoreConformance` SKIPS an optional case when the method is absent and no
// decorator but the coalescer and the sharder ran it at all. `runEventStoreDecoratorConformance`
// closes that; this test makes sure a NEW decorator cannot ship without calling it.
//
// Discovery, never a hand list: a decorator is any non-test source that
//   - declares a class `implements EventStore | SnapshotStore` whose constructor's FIRST
//     parameter is that same store type (it wraps one), or
//   - exports a function whose first parameter is an `EventStore | SnapshotStore` and whose
//     declared return type is a store or a harness around one (its name ends in `Store`:
//     `hashChainedEventStore` → `HashChainedEventStore`, `faultInjectingStore` →
//     `FaultInjectingStore`, `crashingEventStore` → `CrashingEventStore`) — not a helper that
//     merely reads one (`headOf` → `Promise<number | null>`, `serveInspector` →
//     `InspectorServer`).
// It is covered when some test file calls the matching kit with the decorator's name among
// the call's identifiers.

const REPO_ROOT = resolve(__dirname, "../../..");
const ROOTS = ["packages", "plugins", "tools", "apps"];
const STORE_TYPES = ["EventStore", "SnapshotStore"] as const;
type StoreType = (typeof STORE_TYPES)[number];
const KIT: Record<StoreType, string> = {
  EventStore: "runEventStoreDecoratorConformance",
  SnapshotStore: "runSnapshotStoreDecoratorConformance",
};

interface SourceFile {
  path: string;
  text: string;
}

interface Decorator {
  name: string;
  store: StoreType;
  path: string;
}

function isStoreType(text: string | undefined): text is StoreType {
  return text !== undefined && (STORE_TYPES as readonly string[]).includes(text);
}

/** Every decorator declared in `sources` (see the header for the rule). */
function discoverDecorators(sources: readonly SourceFile[]): Decorator[] {
  const found: Decorator[] = [];
  for (const { path, text } of sources) {
    // Cheap pre-filter: the AST walk only runs on files that could declare one.
    if (!/\b(EventStore|SnapshotStore)\b/.test(text)) continue;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const implemented = (node.heritageClauses ?? [])
          .filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword)
          .flatMap((h) => h.types.map((t) => t.expression.getText(sf)));
        const ctor = node.members.find(ts.isConstructorDeclaration);
        const first = ctor?.parameters[0]?.type?.getText(sf);
        if (isStoreType(first) && implemented.includes(first)) {
          found.push({ name: node.name.text, store: first, path });
        }
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
      ) {
        const first = node.parameters[0]?.type?.getText(sf);
        const returns = node.type?.getText(sf) ?? "";
        if (isStoreType(first) && /^\w*Store$/.test(returns)) {
          found.push({ name: node.name.text, store: first, path });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/** For each kit, every identifier that appears inside one of its calls, across `tests`. */
function kitCoverage(tests: readonly SourceFile[]): Record<StoreType, Set<string>> {
  const covered: Record<StoreType, Set<string>> = {
    EventStore: new Set(),
    SnapshotStore: new Set(),
  };
  for (const { path, text } of tests) {
    if (!text.includes("DecoratorConformance")) continue;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const store = STORE_TYPES.find((s) => KIT[s] === (node.expression as ts.Identifier).text);
        if (store !== undefined) {
          const collect = (n: ts.Node): void => {
            if (ts.isIdentifier(n)) covered[store].add(n.text);
            // A label string names the decorator too — but only an identifier proves the
            // call actually CONSTRUCTS it, so strings are not counted.
            ts.forEachChild(n, collect);
          };
          for (const arg of node.arguments) collect(arg);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return covered;
}

/** Decorators no kit call constructs. */
function uncoveredDecorators(
  sources: readonly SourceFile[],
  tests: readonly SourceFile[]
): Decorator[] {
  const covered = kitCoverage(tests);
  return discoverDecorators(sources).filter((d) => !covered[d.store].has(d.name));
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
}

function repoFiles(): { sources: SourceFile[]; tests: SourceFile[] } {
  const files: string[] = [];
  for (const root of ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) walk(abs, files);
  }
  const read = (p: string): SourceFile => ({
    path: relative(REPO_ROOT, p),
    text: readFileSync(p, "utf8"),
  });
  const isTest = (p: string): boolean => /\.(test|spec)\.ts$/.test(p);
  return {
    sources: files.filter((p) => !isTest(p) && !p.endsWith(".bench.ts")).map(read),
    tests: files.filter(isTest).map(read),
  };
}

describe("store decorators run the decorator conformance kit (fitness, ADR 0074 Amendment)", () => {
  const { sources, tests } = repoFiles();
  const decorators = discoverDecorators(sources);

  it("discovers the decorators it must (the sweep can't silently match nothing)", () => {
    const names = decorators.map((d) => d.name);
    for (const known of [
      "TenantScopedEventStore",
      "EncryptingEventStore",
      "EncryptingSnapshotStore",
      "ContentResolvingEventStore",
      "hashChainedEventStore",
      "faultInjectingStore",
      "crashingEventStore",
      "CoalescingEventStore",
      "TenantScopedSnapshotStore",
    ]) {
      expect(names, `discovery lost ${known}`).toContain(known);
    }
    // A helper that TAKES a store but is not a decorator must not be swept in.
    expect(names).not.toContain("headOf");
    expect(names).not.toContain("serveInspector");
  });

  it("every discovered decorator is constructed inside a decorator-kit call in some test", () => {
    const missing = uncoveredDecorators(sources, tests).map(
      (d) => `${d.name} (${d.store}, ${d.path}) — call ${KIT[d.store]} with it`
    );
    expect(missing).toEqual([]);
  });

  it("NEGATIVE — a decorator with no kit call fails it", () => {
    const fixture: SourceFile = {
      path: "plugins/fixture/src/Dropper.ts",
      text: `export class DroppingEventStore implements EventStore {
        constructor(private readonly inner: EventStore) {}
      }
      export function wrapSnapshots(inner: SnapshotStore): SnapshotStore { return inner; }
      export async function notADecorator(store: EventStore): Promise<number> { return 1; }`,
    };
    const unrelatedTest: SourceFile = {
      path: "plugins/fixture/src/x.test.ts",
      text: `runEventStoreConformance(() => new DroppingEventStore(new InMemoryAsyncEventStore()));
       // the name in a STRING does not count:
       runEventStoreDecoratorConformance("DroppingEventStore", (inner) => inner);`,
    };
    expect(uncoveredDecorators([fixture], [unrelatedTest]).map((d) => d.name)).toEqual([
      "DroppingEventStore",
      "wrapSnapshots",
    ]);
    // And the positive: the right kit, constructing it, covers it. The WRONG kit does not.
    const coveringTest: SourceFile = {
      path: "plugins/fixture/src/y.test.ts",
      text: `runEventStoreDecoratorConformance("d", (inner) => new DroppingEventStore(inner));
       runEventStoreDecoratorConformance("w", (inner) => wrapSnapshots(inner));`,
    };
    expect(uncoveredDecorators([fixture], [coveringTest]).map((d) => d.name)).toEqual([
      "wrapSnapshots",
    ]);
  });
});
