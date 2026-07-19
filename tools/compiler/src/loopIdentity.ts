import ts from "typescript";

// ── Loop step-identity static analysis (DE-5, ADR 0061) ──────────────────────
//
// Frames are keyed by step id: `ctx.run(step, input)` inside a loop that cannot
// vary `step.id` per iteration is served iteration 0's memoized output for every
// subsequent iteration — silent replay corruption. The identity rule (ADR 0061
// D1): a step invoked more than once with different intent must mint a
// deterministic distinct id (`${id}#${index}`).
//
// This pass flags `*.run(...)` / `*.execute(...)` calls inside loop bodies whose
// first argument either IS a static step reference (identifier/property access —
// the id cannot vary) or is an expression whose subtree references NO loop-scoped
// binding (the id cannot depend on the iteration). Anything unresolvable stays
// quiet — false negatives are acceptable; false positives kill lints.
//
// Like `nondeterminism.ts`, this analyzes a SOURCE REGION (the flow runner /
// orchestration body). Step handler$ bodies are memoized by the kernel and are
// not the target. Output feeds `@loom/verify`'s determinism rule via
// `FlowSpec.loopIdentityCalls`.

export interface LoopStepIdentityFinding {
  /** The invoking method: `run` or `execute`. */
  callee: string;
  /** The innermost enclosing loop construct. */
  loopKind: string;
  reason: "static-step-in-loop" | "id-not-derived-from-loop-variable";
  location?: string;
}

const CALLBACK_LOOPS = new Set(["map", "forEach", "flatMap"]);

function isRunOrExecuteCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.name) &&
    (e.name.text === "run" || e.name.text === "execute")
  );
}

/** Collect binding names a loop scope introduces or mutates (iteration-varying names). */
function collectLoopBindings(loop: ts.Node, body: ts.Node): Set<string> {
  const names = new Set<string>();

  const addDeclarationList = (list: ts.ForInitializer | undefined): void => {
    if (list !== undefined && ts.isVariableDeclarationList(list)) {
      for (const d of list.declarations) collectBoundNames(d.name, names);
    }
  };
  if (ts.isForStatement(loop)) addDeclarationList(loop.initializer);
  if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) addDeclarationList(loop.initializer);

  // Counters mutated inside the body (`i++`, `i += 1`, `i = i + 1`) vary per
  // iteration even when declared outside the loop (the `while` idiom).
  const scanMutations = (node: ts.Node): void => {
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      names.add(node.operand.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      names.add(node.left.text);
    }
    ts.forEachChild(node, scanMutations);
  };
  scanMutations(body);
  return names;
}

/** Add every identifier bound by a (possibly destructuring) binding name. */
function collectBoundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBoundNames(element.name, into);
  }
}

/** True if the subtree references any of the given names as a VALUE (not a property name). */
function referencesAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const parent = n.parent;
      // `obj.i` — the `.i` name position is not a reference to the loop variable.
      const isPropertyNamePosition =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n);
      if (!isPropertyNamePosition) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** A `.map`/`.forEach`/`.flatMap` call whose first argument is a function — treat as a loop. */
function callbackLoop(
  node: ts.Node
): { body: ts.Node; params: Set<string>; kind: string } | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const e = node.expression;
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.name)) return undefined;
  if (!CALLBACK_LOOPS.has(e.name.text)) return undefined;
  const cb = node.arguments[0];
  if (cb === undefined || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) {
    return undefined;
  }
  const params = new Set<string>();
  for (const p of cb.parameters) collectBoundNames(p.name, params);
  return { body: cb.body, params, kind: `.${e.name.text}()` };
}

/** Analyze a parsed node (a flow runner / orchestration body) for loop-identity hazards. */
export function analyzeLoopIdentityNode(
  root: ts.Node,
  location?: string
): LoopStepIdentityFinding[] {
  const findings: LoopStepIdentityFinding[] = [];
  // Stack of active loop scopes; bindings accumulate (an id derived from ANY
  // enclosing loop's variable is accepted — the nested-loop case is documented
  // as out of scope for the heuristic).
  const loopStack: Array<{ kind: string; bindings: Set<string> }> = [];

  const classify = (call: ts.CallExpression): void => {
    if (loopStack.length === 0) return;
    const step = call.arguments[0];
    if (step === undefined) return;
    const callee = (call.expression as ts.PropertyAccessExpression).name.text;
    const loopKind = loopStack[loopStack.length - 1]!.kind;

    if (ts.isIdentifier(step) || ts.isPropertyAccessExpression(step)) {
      // A static StepDefinition reference — its id is fixed across iterations.
      findings.push({
        callee,
        loopKind,
        reason: "static-step-in-loop",
        ...(location !== undefined && { location }),
      });
      return;
    }
    if (ts.isCallExpression(step) || ts.isObjectLiteralExpression(step)) {
      const union = new Set<string>();
      for (const scope of loopStack) for (const n of scope.bindings) union.add(n);
      if (!referencesAny(step, union)) {
        findings.push({
          callee,
          loopKind,
          reason: "id-not-derived-from-loop-variable",
          ...(location !== undefined && { location }),
        });
      }
      return;
    }
    // Anything else (conditional, array index, helper-derived) — stay quiet.
  };

  const visit = (node: ts.Node): void => {
    if (isRunOrExecuteCall(node)) classify(node);

    if (ts.isIterationStatement(node, false)) {
      const body = node.statement;
      loopStack.push({
        kind: ts.SyntaxKind[node.kind],
        bindings: collectLoopBindings(node, body),
      });
      ts.forEachChild(node, visit);
      loopStack.pop();
      return;
    }
    const cb = callbackLoop(node);
    if (cb !== undefined) {
      // Visit the receiver/arguments outside the loop scope, then the callback
      // body inside it.
      loopStack.push({ kind: cb.kind, bindings: cb.params });
      visit(cb.body);
      loopStack.pop();
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return findings;
}

/**
 * Analyze a source string (a flow runner / orchestration body) for `ctx.run`/
 * `ctx.execute` calls inside loops whose step id cannot vary per iteration
 * (ADR 0061). Feed the result to `@loom/verify` via `FlowSpec.loopIdentityCalls`.
 */
export function analyzeLoopIdentity(source: string, location?: string): LoopStepIdentityFinding[] {
  const sf = ts.createSourceFile("loopid.ts", source, ts.ScriptTarget.ESNext, true);
  return analyzeLoopIdentityNode(sf, location);
}
