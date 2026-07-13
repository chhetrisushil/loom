import ts from "typescript";

// ── Non-determinism static analysis (issue #82) ──────────────────────────────
//
// Detect calls whose result varies run-to-run — Date.now / Math.random /
// crypto.randomUUID / performance.now / bare fetch / new Date() — and whether each is
// inside a `ctx.decide(...)` / `ctx.execute(...)` boundary (where the result is logged and
// served on replay, hence safe). A call reachable OUTSIDE such a boundary in code that
// re-executes on replay (the flow runner / orchestration body) diverges the fold (P2).
//
// IMPORTANT: this analyzes a SOURCE REGION you give it. Step `handler$` bodies are memoized
// (their STEP_COMPLETED output is logged and served on replay), so they are NOT the target —
// feed this the flow runner / orchestration source. Output is shaped to `@loom/verify`'s
// `NonDeterministicCall` and can be fed to its determinism rule via
// `resolveVerifyInput({ nonDeterministicByFlow })`.

export interface NonDeterministicCall {
  callee: string;
  /** True if the call is inside a `ctx.decide`/`ctx.execute` call (its result is logged). */
  insideDecide: boolean;
  location?: string;
}

/** Member calls whose result is non-deterministic (object.method form). */
const NON_DET_MEMBER_CALLS = new Set([
  "Date.now",
  "Math.random",
  "crypto.randomUUID",
  "crypto.getRandomValues",
  "performance.now",
]);
/** Bare (identifier) calls that are non-deterministic / side-effectful. */
const NON_DET_BARE_CALLS = new Set(["fetch"]);

function calleeName(node: ts.CallExpression): string | undefined {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.name) &&
    ts.isIdentifier(e.expression)
  ) {
    return `${e.expression.text}.${e.name.text}`;
  }
  return undefined;
}

/** A `ctx.decide(...)`/`ctx.execute(...)`-shaped call (any receiver, method name decide/execute). */
function isDecideBoundary(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.name) &&
    (e.name.text === "decide" || e.name.text === "execute")
  );
}

/** Analyze a parsed node (a function/body) for non-deterministic calls. */
export function analyzeNode(root: ts.Node, location?: string): NonDeterministicCall[] {
  const calls: NonDeterministicCall[] = [];
  const ancestors: ts.Node[] = [];

  function record(callee: string): void {
    const insideDecide = ancestors.some(isDecideBoundary);
    calls.push({ callee, insideDecide, ...(location !== undefined && { location }) });
  }

  function visit(node: ts.Node): void {
    ancestors.push(node);
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && (NON_DET_MEMBER_CALLS.has(name) || NON_DET_BARE_CALLS.has(name))) {
        record(name);
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      // `new Date()` with no args reads the current time.
      record("new Date");
    }
    ts.forEachChild(node, visit);
    ancestors.pop();
  }

  visit(root);
  return calls;
}

/**
 * Analyze a source string (e.g. a flow runner / orchestration body) for non-deterministic
 * calls. Feed the result to `@loom/verify` via `resolveVerifyInput({ nonDeterministicByFlow })`.
 */
export function analyzeNonDeterminism(source: string, location?: string): NonDeterministicCall[] {
  const sf = ts.createSourceFile("nondet.ts", source, ts.ScriptTarget.ESNext, true);
  return analyzeNode(sf, location);
}
