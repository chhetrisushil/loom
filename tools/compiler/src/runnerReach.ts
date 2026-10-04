import ts from "typescript";

// ── Runner-body reach analysis ───────────────────────────────────────────────
//
// Three `@loom/verify` rules — `capability-compat`, `effect-class` and
// `suspension-safety` — define "what a flow reaches" as the toolIds of its
// DECLARED `FlowDefinition.steps`. A step invoked through `ctx.run(...)` but not
// listed there is invisible to all three, and `FlowSpec.suspends` had no
// producer at all, so two of suspension-safety's checks could never fire.
//
// Suspend points and `ctx.run` targets live in the runner BODY, which is a
// source region — the same thing `analyzeNonDeterminism` already works on. This
// reads that region and reports what it finds.
//
// **What it can and cannot resolve, stated up front, because the whole point is
// not to imply coverage it does not have.** `ctx.run(chargeCard, …)` names a
// binding; a binding declared in the SAME region as `step$({ toolId: "…" })`
// resolves, and one imported from another module does not. An unresolved target
// is reported as unresolved rather than dropped, so the rules downstream can say
// "partially verified" instead of reporting clean — the distinction that makes
// this worth doing at all.

/** A `ctx.run` target resolved to a concrete tool. */
export interface RunnerStepRef {
  /** The step's declared id, when the binding carried one. */
  stepId?: string;
  toolId: string;
  /**
   * The target was reached through `scope.invokeTransient(…)` inside a `ctx.decide`
   * decider (L31), not through `ctx.run`. Such a call is transient: it is refused at
   * runtime for a `journaled` effect, which the verifier can only check if it knows
   * the call came from a scope.
   */
  viaDecider?: true;
}

/** A `ctx.run`/`ctx.suspend` whose target could not be resolved statically. */
export interface UnresolvedReach {
  /** Source text of the unresolved expression, e.g. `mcpInvoke$(…)` or `steps[i]`. */
  expr: string;
  /** What was being resolved — a step target or a suspend condition. */
  kind: "step" | "suspend";
  location?: string;
}

/** A suspend point read from a `ctx.suspend({ … })` object literal. */
export interface RunnerSuspend {
  /** The `on` event type, used to name the finding. */
  id?: string;
  correlationKey?: string;
  /** A `timeout` was declared — the wake depends on a timer. */
  timed?: boolean;
  /** A `wakeAt` was declared explicitly in the condition. */
  wakeAt?: boolean;
}

/**
 * L32 — the flow's `ctx` (or its `ctx.decide`) is handed to code outside this region. The
 * compiler cannot see that code, so it records WHERE it went; `@loom/verify`'s adapter
 * resolves `callee`/`root` against the app's declared reach (`verify.reach`) and either
 * counts the declared tools or reports the escape unresolved.
 */
export interface ReachEscape {
  /** Source text of the callee the value was handed to, e.g. `planner.compose`. */
  callee: string;
  /** The leftmost identifier of `callee` (`planner`), absent for `this.x` / call results. */
  root?: string;
  /** What was handed over: the whole `ctx`, or just `ctx.decide`. */
  via: "ctx" | "decide";
  location?: string;
}

export interface RunnerReach {
  steps: RunnerStepRef[];
  unresolved: UnresolvedReach[];
  suspends: RunnerSuspend[];
  /** L32 — `ctx` handed to out-of-region callees. Absent when there are none. */
  escapes?: ReachEscape[];
}

/** The string value of a property on an object literal, when it is a literal. */
function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (key !== name) continue;
    if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) {
      return p.initializer.text;
    }
    return undefined;
  }
  return undefined;
}

/** Whether a property is present at all, regardless of whether its value is a literal. */
function hasProp(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    return (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name;
  });
}

/** A method call `<anything>.<name>(…)` — receiver-agnostic, like the determinism analyzer. */
function methodCall(node: ts.Node, name: string): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const e = node.expression;
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) && e.name.text === name
    ? node
    : undefined;
}

/**
 * Collect `const NAME = anything$({ … toolId: "…" … })` bindings in this region.
 *
 * Shape-based rather than keyed to `step$` by name, so a project wrapper
 * (`myStep$`, a re-export, a locally curried factory) resolves too. The
 * discriminator is a string-literal `toolId`, which is the only thing that makes
 * a binding useful here.
 */
function collectBindings(root: ts.Node): Map<string, RunnerStepRef> {
  const bindings = new Map<string, RunnerStepRef>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init !== undefined && ts.isCallExpression(init) && init.arguments.length > 0) {
        const arg = init.arguments[0];
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          const toolId = stringProp(arg, "toolId");
          if (toolId !== undefined) {
            const stepId = stringProp(arg, "id");
            bindings.set(node.name.text, { toolId, ...(stepId !== undefined && { stepId }) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return bindings;
}

/** Short, stable source text for an unresolved expression (bounded for log safety). */
function exprText(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Function-like nodes a decider can be written as. */
type FnNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function isFn(node: ts.Node): node is FnNode {
  return (
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
  );
}

/**
 * Collect functions declared in this region by name (`function f(){}`,
 * `const f = (s) => …`), so `ctx.decide("x", f)` can be followed when `f` is local.
 *
 * Resolution is by TEXTUAL name in one flat map, so a name is only followed when it is
 * unambiguous: declared exactly once in the region (as a function, a variable, a
 * parameter or a binding), with `const`/`function`, and never reassigned. Anything else
 * is left out, which makes `ctx.decide("x", name)` unresolved rather than silently
 * binding to whichever declaration came last.
 */
function collectFunctions(root: ts.Node): Map<string, FnNode> {
  const fns = new Map<string, FnNode>();
  const declared = new Map<string, number>();
  const ambiguous = new Set<string>();
  const declare = (name: string): void => {
    declared.set(name, (declared.get(name) ?? 0) + 1);
  };
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      declare(node.name.text);
      fns.set(node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text);
      const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
      if (!isConst) ambiguous.add(node.name.text);
      if (
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        fns.set(node.name.text, node.initializer);
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      ambiguous.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  for (const name of [...fns.keys()]) {
    if (ambiguous.has(name) || (declared.get(name) ?? 0) > 1) fns.delete(name);
  }
  return fns;
}

/** A string-literal-like toolId (`"x"` or an expression-free template), else undefined. */
function literalToolId(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * L32 — names that denote a flow's execution context in this region: `ctx`, the receiver of a
 * `.decide/.suspend/.sleepUntil` call, and a parameter typed `…ExecutionContext`. Textual, so a
 * helper's parameter named otherwise (`c`) is only recognised if it calls one of those methods.
 */
function collectCtxNames(root: ts.Node): Set<string> {
  const names = new Set<string>(["ctx"]);
  const methods = new Set(["decide", "suspend", "sleepUntil"]);
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      methods.has(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      names.add(node.expression.expression.text);
    } else if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type !== undefined &&
      ts.isTypeReferenceNode(node.type) &&
      /ExecutionContext$/.test(node.type.typeName.getText())
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return names;
}

/** The leftmost identifier of a member/call chain (`planner` for `planner.a.b(c).d`). */
function chainRoot(e: ts.Expression): string | undefined {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
      cur = cur.expression;
    else if (ts.isCallExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else return undefined;
  }
}

/**
 * Where does a value go? Climb through literals/spreads/wrappers to the call or `new` that
 * receives it as an argument and return that callee; `undefined` when the value is stored,
 * returned or otherwise leaves through something other than an argument.
 */
function receivingCallee(node: ts.Node): ts.Expression | undefined {
  let child: ts.Node = node;
  let p: ts.Node | undefined = node.parent;
  while (p !== undefined) {
    if (
      ts.isObjectLiteralExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isSpreadElement(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === child)
    ) {
      child = p;
      p = p.parent;
      continue;
    }
    if (
      (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
      p.arguments?.includes(child as ts.Expression)
    ) {
      return p.expression;
    }
    return undefined;
  }
  return undefined;
}

/** Analyze a parsed node (a flow runner body) for reachable steps and suspend points. */
export function analyzeReachNode(root: ts.Node, location?: string): RunnerReach {
  const bindings = collectBindings(root);
  const functions = collectFunctions(root);
  const steps: RunnerStepRef[] = [];
  const unresolved: UnresolvedReach[] = [];
  const suspends: RunnerSuspend[] = [];
  const escapes: ReachEscape[] = [];
  const escapeSeen = new Set<string>();
  const ctxNames = collectCtxNames(root);
  const at = location !== undefined ? { location } : {};

  /** Record a hand-off to `callee`; a same-region function is already analysed, so skipped. */
  function recordEscape(callee: ts.Expression, via: "ctx" | "decide"): void {
    if (ts.isIdentifier(callee) && functions.has(callee.text)) return;
    const text = exprText(callee);
    const key = `${via}:${text}`;
    if (escapeSeen.has(key)) return;
    escapeSeen.add(key);
    const rootName = chainRoot(callee);
    escapes.push({
      callee: text,
      ...(rootName !== undefined && { root: rootName }),
      via,
      ...at,
    });
  }

  /**
   * L32 — a reference to the execution context that is not `ctx.<method>`. A call argument (or
   * inside an object/array argument) is an ESCAPE to that callee; any other leak (stored,
   * aliased, returned) has no callee to look up and is reported unresolved.
   */
  function flagCtxEscape(node: ts.Identifier): void {
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) &&
        (parent.expression === node || parent.name === node)) ||
      (ts.isElementAccessExpression(parent) && parent.expression === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
      ts.isTypeOfExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(parent.operatorToken.kind)) ||
      // `const { decide } = ctx` — the `decide` binding is L31's to report.
      (ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isObjectBindingPattern(parent.name))
    ) {
      return;
    }
    const callee = receivingCallee(node);
    if (callee !== undefined) recordEscape(callee, "ctx");
    else unresolved.push({ expr: `ctx stored as ${exprText(parent)}`, kind: "step", ...at });
  }

  function visitRun(call: ts.CallExpression): void {
    const target = call.arguments[0];
    if (target === undefined) return;
    if (ts.isIdentifier(target)) {
      const bound = bindings.get(target.text);
      if (bound !== undefined) steps.push(bound);
      else unresolved.push({ expr: target.text, kind: "step", ...at });
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      const toolId = stringProp(target, "toolId");
      if (toolId !== undefined) {
        const stepId = stringProp(target, "id");
        steps.push({ toolId, ...(stepId !== undefined && { stepId }) });
        return;
      }
    }
    // A minted step (`mcpInvoke$("hydrate#0")`), an element access, a parameter —
    // all real and all unresolvable from this region alone.
    unresolved.push({ expr: exprText(target), kind: "step", ...at });
  }

  function visitSuspend(call: ts.CallExpression): void {
    const condition = call.arguments[0];
    if (condition === undefined || !ts.isObjectLiteralExpression(condition)) {
      // A condition built elsewhere. Recording it as unresolved keeps a flow that
      // suspends from looking like a flow that does not.
      unresolved.push({
        expr: condition === undefined ? "suspend()" : exprText(condition),
        kind: "suspend",
        ...at,
      });
      return;
    }
    const on = stringProp(condition, "on");
    const correlationKey = stringProp(condition, "correlationKey");
    suspends.push({
      ...(on !== undefined && { id: on }),
      ...(correlationKey !== undefined && { correlationKey }),
      ...(hasProp(condition, "timeout") && { timed: true }),
      ...(hasProp(condition, "wakeAt") && { wakeAt: true }),
    });
  }

  /**
   * L31 — a `ctx.decide(id, decider)` decider receives a scope whose
   * `invokeTransient(toolId, …)` runs an effect as the deciding execution. Those calls
   * are reached effects exactly like `ctx.run` targets, but live in a callback the
   * `ctx.run` walk never classified.
   *
   * The scope is tracked by BINDING: the first parameter, either an identifier
   * (`(scope) =>`) whose only permitted use is as the receiver of a called
   * `.invokeTransient`, or an object pattern (`({ invokeTransient })`, with or without a
   * rename) whose bound name may only be called. ANY other use — passing the scope on,
   * aliasing it, `scope["invokeTransient"]`, a rest element — is reported as unresolved,
   * because the call it hides cannot be seen. Name matching is textual: a nested
   * function that shadows the scope's name is treated as the scope (over-reports, never
   * under-reports).
   */
  function visitDecide(call: ts.CallExpression): void {
    if (call.arguments.some((a) => ts.isSpreadElement(a))) {
      unresolved.push({
        expr: `decide(${exprText(call.arguments[0] ?? call)})`,
        kind: "step",
        ...at,
      });
      return;
    }
    const decider = call.arguments[1];
    if (decider === undefined) return;
    let fn: FnNode | undefined;
    if (isFn(decider)) fn = decider;
    else if (ts.isIdentifier(decider)) fn = functions.get(decider.text);
    if (fn === undefined) {
      // A decider whose body is not in this region (imported, returned from a factory,
      // a member). It may take a scope and call anything; same treatment as an
      // unresolvable `ctx.run` target.
      unresolved.push({ expr: `decide(${exprText(decider)})`, kind: "step", ...at });
      return;
    }
    const param = fn.parameters[0];
    if (param === undefined || fn.body === undefined) return; // never receives a scope
    const scopeNames = new Set<string>();
    const callNames = new Set<string>();
    if (ts.isIdentifier(param.name)) {
      scopeNames.add(param.name.text);
    } else if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (el.dotDotDotToken !== undefined) {
          unresolved.push({ expr: `decide scope rest ${exprText(el)}`, kind: "step", ...at });
          continue;
        }
        const key = el.propertyName ?? el.name;
        const keyText =
          ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
            ? key.text
            : undefined;
        // A computed key could be anything; a nested pattern or non-identifier name
        // could bind `invokeTransient` where the call cannot be followed.
        const couldBind = keyText === "invokeTransient" || ts.isComputedPropertyName(key);
        if (!couldBind) continue;
        if (keyText === "invokeTransient" && ts.isIdentifier(el.name)) {
          callNames.add(el.name.text);
        } else {
          unresolved.push({ expr: `decide scope ${exprText(el)}`, kind: "step", ...at });
        }
      }
    } else {
      unresolved.push({ expr: `decide(${exprText(param)})`, kind: "step", ...at });
      return;
    }
    if (scopeNames.size === 0 && callNames.size === 0) return;

    const record = (c: ts.CallExpression): void => {
      const id = literalToolId(c.arguments[0]);
      if (id !== undefined) steps.push({ toolId: id, viaDecider: true });
      else {
        const arg = c.arguments[0];
        unresolved.push({
          expr: `invokeTransient(${arg === undefined ? "" : exprText(arg)})`,
          kind: "step",
          ...at,
        });
      }
    };
    const escaped = (n: ts.Node): void => {
      unresolved.push({ expr: `decide scope used as ${exprText(n.parent)}`, kind: "step", ...at });
    };

    function scan(node: ts.Node): void {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        // Property names and declaration names are not references.
        const isName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node);
        if (!isName) {
          if (scopeNames.has(node.text)) {
            const grand = parent.parent;
            if (
              ts.isPropertyAccessExpression(parent) &&
              parent.expression === node &&
              parent.name.text === "invokeTransient" &&
              grand !== undefined &&
              ts.isCallExpression(grand) &&
              grand.expression === parent
            ) {
              record(grand);
            } else {
              escaped(node);
            }
          } else if (callNames.has(node.text)) {
            if (ts.isCallExpression(parent) && parent.expression === node) record(parent);
            else escaped(node);
          }
        }
      }
      ts.forEachChild(node, scan);
    }
    scan(fn.body);
  }

  /**
   * `ctx.decide` reached by any route other than a direct `<x>.decide(…)` call hides a
   * decider this walk would have followed: `ctx.decide.bind(ctx)`, `const f = ctx.decide`,
   * `const { decide } = ctx`, a `({ decide }) =>` runner parameter, `ctx["decide"](…)`.
   * Receiver-agnostic like `methodCall`; reported as unresolved so the shape cannot pass
   * vacuously.
   */
  function flagIndirectDecide(node: ts.Node): void {
    let hit = false;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "decide") {
      const p = node.parent;
      hit = !(ts.isCallExpression(p) && p.expression === node);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "decide"
    ) {
      hit = true;
    } else if (ts.isBindingElement(node) && node.dotDotDotToken === undefined) {
      const key = node.propertyName ?? node.name;
      hit = (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "decide";
    }
    if (!hit) return;
    // L32 — `lib({ decide: ctx.decide })` hands the decider seam to a callee a declaration may
    // cover; every other alias shape has no callee to look up.
    if (ts.isPropertyAccessExpression(node)) {
      const callee = receivingCallee(node);
      if (callee !== undefined) {
        recordEscape(callee, "decide");
        return;
      }
    }
    unresolved.push({ expr: `decide alias ${exprText(node)}`, kind: "step", ...at });
  }

  function visit(node: ts.Node): void {
    const run = methodCall(node, "run");
    if (run !== undefined) visitRun(run);
    const decide = methodCall(node, "decide");
    if (decide !== undefined) visitDecide(decide);
    else flagIndirectDecide(node);
    if (ts.isIdentifier(node) && ctxNames.has(node.text)) flagCtxEscape(node);
    const suspend = methodCall(node, "suspend");
    if (suspend !== undefined) visitSuspend(suspend);
    // `ctx.sleep`/`sleepUntil` are deliberately NOT recorded. The kernel authors
    // their condition (`on: TIMER_FIRED`, `wakeAt` always set), so treating them
    // as user-authored suspend points would manufacture findings about code the
    // developer never wrote.
    ts.forEachChild(node, visit);
  }

  visit(root);
  return { steps, unresolved, suspends, ...(escapes.length > 0 && { escapes }) };
}

/**
 * Analyze a source string (a flow runner / orchestration body). Feed the result
 * to `@loom/verify` via `resolveVerifyInput({ runnerReachByFlow })`.
 */
export function analyzeRunnerReach(source: string, location?: string): RunnerReach {
  const sf = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.ESNext, true);
  return analyzeReachNode(sf, location);
}
