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
  /** When `via` is "ctx": the ctx METHOD handed over (`run` for `lib(ctx.run)`), absent for the whole ctx. */
  member?: string;
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
  if (ts.isTaggedTemplateExpression(node)) return `${exprText(node.tag)}\`…\``;
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
  return scanDeclarations(root).fns;
}

/** Same unambiguity rule as {@link collectFunctions}, for any `const NAME = <initializer>`. */
function collectConstInits(root: ts.Node): Map<string, ts.Expression> {
  return scanDeclarations(root).inits;
}

function scanDeclarations(root: ts.Node): {
  fns: Map<string, FnNode>;
  inits: Map<string, ts.Expression>;
} {
  const fns = new Map<string, FnNode>();
  const inits = new Map<string, ts.Expression>();
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
      if (node.initializer !== undefined) inits.set(node.name.text, node.initializer);
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
  for (const name of [...inits.keys()]) {
    if (ambiguous.has(name) || (declared.get(name) ?? 0) > 1) inits.delete(name);
  }
  return { fns, inits };
}

/** A string-literal-like toolId (`"x"` or an expression-free template), else undefined. */
function literalToolId(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** ExecutionContext members whose VALUE, handed out, lets the receiver run or suspend the flow. */
const CTX_METHODS = new Set(["run", "execute", "parallel", "suspend", "sleep", "sleepUntil"]);

/** Strip parentheses and type-only wrappers. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken)
  ) {
    cur = ts.isBinaryExpression(cur) ? cur.right : cur.expression;
  }
  return cur;
}

/** Something with a parameter list: a function, or an object-literal method. */
type ParamOwner = FnNode | ts.MethodDeclaration;

/** A runner expression that is plainly not a function value (no refusal needed). */
function isInertValue(e: ts.Expression): boolean {
  return (
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    (ts.isIdentifier(e) && e.text === "undefined")
  );
}

/**
 * Runner functions declared in this region: a `runner:` property or `runner = …` class field
 * (inline or a local identifier / shorthand), a `runner(ctx, …) {}` method, the second argument
 * of `registerFlow(def, runner)`, or a function bound to a `…FlowRunner`-typed variable. Their
 * FIRST parameter is the flow's ctx whatever it is called.
 *
 * A runner VALUE that is not a followable function is never silently skipped (round 2):
 *  - a call (`withRetry(async (c) => …)`, `makeRunner(lib)`): every function-literal argument
 *    (or local function passed by name) is treated as a runner, because a wrapper hands its ctx
 *    to the callback; and the call itself is reported `runner not analysable` since the wrapper
 *    may do anything else with ctx;
 *  - an identifier is followed to a local function or a `const` initializer, else refused
 *    (imported, ambiguous);
 *  - anything else (member access, conditional branches that are not functions) is refused.
 */
function collectRunners(
  root: ts.Node,
  functions: Map<string, FnNode>
): { runners: ParamOwner[]; unresolved: string[] } {
  const out: ParamOwner[] = [];
  const unresolved: string[] = [];
  const inits = collectConstInits(root);
  const seenValues = new Set<ts.Node>();
  const refuse = (e: ts.Expression): void => {
    const text = `runner not analysable: ${exprText(e)}`;
    if (!unresolved.includes(text)) unresolved.push(text);
  };
  const argFn = (a: ts.Expression): FnNode | undefined => {
    const u = unwrap(a);
    if (isFn(u)) return u;
    return ts.isIdentifier(u) ? functions.get(u.text) : undefined;
  };
  /** The functions a factory returns, or undefined unless EVERY return is a followable function. */
  function returnedFns(factory: FnNode | ts.GetAccessorDeclaration): FnNode[] | undefined {
    const body = factory.body;
    if (body === undefined) return undefined;
    const found: FnNode[] = [];
    let ok = true;
    const take = (e: ts.Expression | undefined): void => {
      const f = e === undefined ? undefined : argFn(e);
      if (f === undefined) ok = false;
      else found.push(f);
    };
    if (!ts.isBlock(body)) take(body);
    else {
      const scan = (n: ts.Node): void => {
        if (isFn(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n)) return;
        if (ts.isReturnStatement(n)) take(n.expression);
        ts.forEachChild(n, scan);
      };
      ts.forEachChild(body, scan);
    }
    return ok && found.length > 0 ? found : undefined;
  }
  function runnerValue(e: ts.Expression | undefined): void {
    if (e === undefined) return;
    const u = unwrap(e);
    if (seenValues.has(u)) return;
    seenValues.add(u);
    if (isFn(u)) {
      out.push(u);
    } else if (isInertValue(u)) {
      return;
    } else if (ts.isIdentifier(u)) {
      const f = functions.get(u.text);
      const init = inits.get(u.text);
      if (f !== undefined) out.push(f);
      else if (init !== undefined) runnerValue(init);
      else refuse(u);
    } else if (ts.isCallExpression(u) || ts.isNewExpression(u)) {
      for (const a of u.arguments ?? []) {
        const f = argFn(a);
        if (f !== undefined) out.push(f);
      }
      // A LOCAL factory (`makeRunner(lib)` where `function makeRunner` is in this region) whose
      // every return is a function: those returned functions are the runners, nothing hidden.
      const callee = ts.isCallExpression(u) ? unwrap(u.expression) : undefined;
      const factory =
        callee !== undefined && ts.isIdentifier(callee) ? functions.get(callee.text) : undefined;
      const returned = factory === undefined ? undefined : returnedFns(factory);
      if (returned !== undefined) out.push(...returned);
      else refuse(u);
    } else if (ts.isConditionalExpression(u)) {
      runnerValue(u.whenTrue);
      runnerValue(u.whenFalse);
    } else {
      refuse(u);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && propName(node.name) === "runner") {
      runnerValue(node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === "runner") {
      runnerValue(node.name);
    } else if (ts.isMethodDeclaration(node) && propName(node.name) === "runner") {
      out.push(node);
    } else if (ts.isPropertyDeclaration(node) && propName(node.name) === "runner") {
      runnerValue(node.initializer);
    } else if (ts.isGetAccessorDeclaration(node) && propName(node.name) === "runner") {
      // `get runner() { return async (c) => … }`: the returned function(s) are the runner, like a
      // local factory; a getter returning anything else is refused, never silently skipped.
      const returned = returnedFns(node);
      if (returned !== undefined) out.push(...returned);
      else {
        const text = "runner not analysable: get runner()";
        if (!unresolved.includes(text)) unresolved.push(text);
      }
    } else if (
      ts.isCallExpression(node) &&
      (ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "") === "registerFlow"
    ) {
      runnerValue(node.arguments[1]);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      /FlowRunner\b/.test(node.type.getText())
    ) {
      runnerValue(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return { runners: out, unresolved };
}

function propName(n: ts.PropertyName): string | undefined {
  return ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : undefined;
}

/** What the analysis knows denotes the flow's context (or a method taken off it) in this region. */
interface CtxModel {
  /** Identifiers that denote the ctx object itself. */
  names: Set<string>;
  /** Local name -> the ctx member it was destructured from (`const { run: r } = ctx` -> r:run). */
  members: Map<string, string>;
  /** Shapes that bind ctx where it cannot be followed (nested/computed patterns, array patterns). */
  unresolved: Set<string>;
}

/**
 * L32 — names that denote a flow's execution context in this region. Textual and module-wide:
 *  - `ctx`, a parameter typed `…ExecutionContext` (or a local alias of that type), and the
 *    receiver of a `.decide/.suspend/.sleepUntil` call;
 *  - the FIRST parameter of every runner (`collectRunners`), whatever it is called, with an
 *    object pattern splitting into method values and a rest name (which IS the ctx);
 *  - propagation to a fixpoint: a ctx name handed as argument i to a same-module function adds
 *    that function's i-th parameter, and `const { …rest } = <ctx name>` adds the rest name.
 * Over-reports by design (a textual name shadowed elsewhere is still treated as ctx).
 */
function collectCtx(root: ts.Node, functions: Map<string, FnNode>): CtxModel {
  const names = new Set<string>(["ctx"]);
  const members = new Map<string, string>();
  const unresolved = new Set<string>();
  const methods = new Set(["decide", "suspend", "sleepUntil"]);

  // Local type aliases that resolve to an ExecutionContext.
  const ctxTypes = new Set<string>();
  const isCtxType = (t: ts.TypeNode | undefined): boolean =>
    t !== undefined &&
    ts.isTypeReferenceNode(t) &&
    (/ExecutionContext$/.test(t.typeName.getText()) || ctxTypes.has(t.typeName.getText()));
  for (let grew = true; grew; ) {
    grew = false;
    const scanTypes = (n: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(n) && !ctxTypes.has(n.name.text) && isCtxType(n.type)) {
        ctxTypes.add(n.name.text);
        grew = true;
      }
      ts.forEachChild(n, scanTypes);
    };
    scanTypes(root);
  }

  // Worklist: every name is processed once per set it joins, against indexes built by ONE walk.
  const queue: string[] = [];
  const addName = (n: string): void => {
    if (!names.has(n)) {
      names.add(n);
      queue.push(n);
    }
  };
  const addMember = (n: string, m: string): void => {
    if (!members.has(n)) {
      members.set(n, m);
      queue.push(n);
    }
  };
  const bindPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const el of pattern.elements) {
      if (el.dotDotDotToken !== undefined) {
        if (ts.isIdentifier(el.name)) addName(el.name.text);
        else unresolved.add(`ctx pattern ${exprText(el)}`);
        continue;
      }
      const key = el.propertyName ?? el.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (keyText === "decide") continue; // L31 reports every decide alias
      if (keyText === undefined || !ts.isIdentifier(el.name)) {
        unresolved.add(`ctx pattern ${exprText(el)}`);
        continue;
      }
      addMember(el.name.text, keyText);
    }
  };
  const bindParam = (p: ts.ParameterDeclaration): void => {
    if (ts.isIdentifier(p.name)) addName(p.name.text);
    else if (ts.isObjectBindingPattern(p.name)) bindPattern(p.name);
    else unresolved.add(`ctx parameter ${exprText(p.name)}`);
  };

  const found = collectRunners(root, functions);
  for (const u of found.unresolved) unresolved.add(u);
  for (const r of found.runners) {
    const first = r.parameters[0];
    if (first !== undefined) bindParam(first);
  }

  // One walk: seed names, and index the places a name can flow onward from.
  /** identifier argument -> the same-module parameter it is handed to. */
  const argUses = new Map<string, ts.ParameterDeclaration[]>();
  /** identifier -> declarations initialised from it (`const { … } = n`, `const k = n`). */
  const declUses = new Map<string, ts.VariableDeclaration[]>();
  const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
    const list = m.get(k);
    if (list === undefined) m.set(k, [v]);
    else list.push(v);
  };
  function index(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      methods.has(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      addName(node.expression.expression.text);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && isCtxType(node.type)) {
      addName(node.name.text);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      const fn = ts.isIdentifier(callee) ? functions.get(callee.text) : undefined;
      if (fn !== undefined) {
        (node.arguments ?? []).forEach((arg, i) => {
          const a = unwrap(arg);
          const param = fn.parameters[i];
          if (
            ts.isIdentifier(a) &&
            param !== undefined &&
            param.dotDotDotToken === undefined &&
            ts.isIdentifier(param.name)
          ) {
            push(argUses, a.text, param);
          }
        });
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = unwrap(node.initializer);
      const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
      if (
        ts.isIdentifier(init) &&
        (ts.isObjectBindingPattern(node.name) || (isConst && ts.isIdentifier(node.name)))
      ) {
        push(declUses, init.text, node);
      }
    }
    ts.forEachChild(node, index);
  }
  index(root);
  for (const n of [...names]) queue.push(n);
  for (const n of members.keys()) queue.push(n);

  while (queue.length > 0) {
    const n = queue.pop() as string;
    const asName = names.has(n);
    const m = members.get(n);
    for (const param of argUses.get(n) ?? []) {
      const pn = (param.name as ts.Identifier).text;
      if (asName) addName(pn);
      if (m !== undefined) addMember(pn, m);
    }
    for (const decl of declUses.get(n) ?? []) {
      if (ts.isObjectBindingPattern(decl.name)) {
        if (asName) bindPattern(decl.name);
      } else if (ts.isIdentifier(decl.name)) {
        if (asName) addName(decl.name.text);
        if (m !== undefined) addMember(decl.name.text, m);
      }
    }
  }
  return { names, members, unresolved };
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
 * receives it as an argument; `undefined` when the value is stored, returned or otherwise
 * leaves through something other than an argument. `direct` is true when the value IS the
 * argument (not wrapped in a literal/spread), with its index.
 */
function receivingCall(node: ts.Node):
  | {
      call: ts.CallExpression | ts.NewExpression;
      direct: boolean;
      index: number;
    }
  | undefined {
  let child: ts.Node = node;
  let direct = true;
  let p: ts.Node | undefined = node.parent;
  while (p !== undefined) {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p)
    ) {
      child = p;
      p = p.parent;
      continue;
    }
    if (
      ts.isObjectLiteralExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isSpreadElement(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === child)
    ) {
      direct = false;
      child = p;
      p = p.parent;
      continue;
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const index = p.arguments?.indexOf(child as ts.Expression) ?? -1;
      if (index >= 0) return { call: p, direct, index };
    }
    return undefined;
  }
  return undefined;
}

/** Callees that run their first argument (or forward the rest) rather than being the real target. */
const PASS_THROUGH = new Set([
  "Reflect.apply",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "process.nextTick",
]);

/** Analyze a parsed node (a flow runner body) for reachable steps and suspend points. */
export function analyzeReachNode(root: ts.Node, location?: string): RunnerReach {
  const bindings = collectBindings(root);
  const functions = collectFunctions(root);
  const steps: RunnerStepRef[] = [];
  const unresolved: UnresolvedReach[] = [];
  const suspends: RunnerSuspend[] = [];
  const escapes: ReachEscape[] = [];
  const escapeSeen = new Set<string>();
  const ctx = collectCtx(root, functions);
  const ctxNames = ctx.names;
  const at = location !== undefined ? { location } : {};
  for (const expr of ctx.unresolved) unresolved.push({ expr, kind: "step", ...at });

  const stripCallish = (c: ts.Expression): ts.Expression => {
    let cur = unwrap(c);
    while (
      ts.isPropertyAccessExpression(cur) &&
      ["call", "apply", "bind"].includes(cur.name.text)
    ) {
      cur = unwrap(cur.expression);
    }
    return cur;
  };
  const isPlainChain = (e: ts.Expression): boolean =>
    ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && isPlainChain(e.expression));

  /**
   * Record a hand-off to whatever `site` calls. `.call/.apply/.bind` on the callee is stripped
   * and a pass-through (`Reflect.apply(lib, …)`, `setTimeout(lib, …)`) is unwrapped to its real
   * target when that is a plain name; otherwise the hand-off is reported unresolved. A
   * same-module callee is already analysed for a `decide` alias; for ctx or a ctx method it is
   * reported (the value is wrapped or the parameter cannot be followed).
   */
  function recordEscape(
    site: ts.CallExpression | ts.NewExpression,
    via: "ctx" | "decide",
    member?: string
  ): void {
    const handed = via === "decide" ? "ctx.decide" : member !== undefined ? `ctx.${member}` : "ctx";
    let callee = unwrap(site.expression);
    const direct = exprText(callee);
    if (!PASS_THROUGH.has(direct)) callee = stripCallish(callee);
    if (PASS_THROUGH.has(direct)) {
      const target =
        site.arguments?.[0] === undefined ? undefined : stripCallish(site.arguments[0]);
      if (target === undefined || !isPlainChain(target)) {
        unresolved.push({
          expr: `${handed} handed through ${direct} (target not static)`,
          kind: "step",
          ...at,
        });
        return;
      }
      callee = target;
    } else if (/^Promise\./.test(direct)) {
      unresolved.push({ expr: `${handed} handed to ${direct}`, kind: "step", ...at });
      return;
    }
    if (ts.isIdentifier(callee) && functions.has(callee.text)) {
      if (via === "decide") return;
      unresolved.push({
        expr: `${handed} handed to same-module ${callee.text} in a shape that is not followed`,
        kind: "step",
        ...at,
      });
      return;
    }
    const text = exprText(callee);
    const rootName = chainRoot(callee);
    // The receiving callee is itself the ctx (`ctx.emit("x", ctx)`, `setTimeout(ctx.run, 0)`,
    // `Reflect.apply(ctx.run, ctx, [step])`): there is no outside code to look up a declaration
    // for, and `verify.reach["ctx"]` would be nonsense. The call is a ctx-method call whose
    // argument this walk does not resolve, so refuse it (once per callee).
    if (rootName !== undefined && (ctxNames.has(rootName) || ctx.members.has(rootName))) {
      const key = `ctx-rooted:${text}`;
      if (escapeSeen.has(key)) return;
      escapeSeen.add(key);
      unresolved.push({
        expr: `ctx value handed to ctx-rooted ${text} (not resolved)`,
        kind: "step",
        ...at,
      });
      return;
    }
    const key = `${via}:${member ?? ""}:${text}`;
    if (escapeSeen.has(key)) return;
    escapeSeen.add(key);
    escapes.push({
      callee: text,
      ...(rootName !== undefined && { root: rootName }),
      via,
      ...(member !== undefined && { member }),
      ...at,
    });
  }

  /** Route a ctx (or ctx-member) VALUE at `node` to its receiving callee, or report it stored. */
  function routeValue(node: ts.Node, member?: string): void {
    const recv = receivingCall(node);
    if (recv === undefined) {
      const what = member !== undefined ? `ctx.${member}` : "ctx";
      // A value interpolated into a tagged template reads as the whole tagged expression.
      let where: ts.Node = node.parent;
      for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
        if (ts.isTaggedTemplateExpression(p)) {
          where = p;
          break;
        }
        if (!ts.isTemplateSpan(p) && !ts.isTemplateExpression(p)) break;
      }
      unresolved.push({ expr: `${what} stored as ${exprText(where)}`, kind: "step", ...at });
      return;
    }
    // Direct hand-off to a same-module function: its i-th parameter was added to the ctx
    // names (propagation) and its body is walked here, so it is followed — but only for the
    // ctx itself, and only when the parameter is a plain identifier.
    const callee = unwrap(recv.call.expression);
    if (member === undefined && ts.isIdentifier(callee) && functions.has(callee.text)) {
      const fn = functions.get(callee.text);
      const param = fn?.parameters[recv.index];
      if (
        recv.direct &&
        param !== undefined &&
        param.dotDotDotToken === undefined &&
        ts.isIdentifier(param.name)
      ) {
        return;
      }
      unresolved.push({
        expr: `ctx handed to same-module ${callee.text} where the parameter cannot be followed`,
        kind: "step",
        ...at,
      });
      return;
    }
    recordEscape(recv.call, "ctx", member);
  }

  /**
   * `ctx.<m>` / `ctx["m"]`. A direct call is the normal path (the walk analyses it). A method
   * taken as a VALUE (`lib(ctx.run)`, `ctx.run.bind(ctx)`, `ctx.run.call(ctx, step)`) hands the
   * receiver the ability to run or suspend the flow: an escape like `ctx.decide`.
   */
  function flagCtxMember(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
    let member: string | undefined;
    if (ts.isPropertyAccessExpression(access)) member = access.name.text;
    else if (ts.isStringLiteralLike(access.argumentExpression))
      member = access.argumentExpression.text;
    else {
      unresolved.push({ expr: `ctx dynamic member ${exprText(access)}`, kind: "step", ...at });
      return;
    }
    if (member === "decide" || !CTX_METHODS.has(member)) return; // L31 / data properties
    // The expression the member value flows out of, skipping wrappers.
    let top: ts.Node = access;
    while (
      top.parent !== undefined &&
      (ts.isParenthesizedExpression(top.parent) ||
        ts.isNonNullExpression(top.parent) ||
        ts.isAsExpression(top.parent))
    ) {
      top = top.parent;
    }
    const parent = top.parent;
    if (parent !== undefined && ts.isCallExpression(parent) && parent.expression === top) {
      // Direct call. Property form is analysed by the receiver-agnostic walk; the
      // element-access form is not, so do it here.
      if (ts.isElementAccessExpression(access)) {
        if (member === "run") visitRun(parent);
        else if (member === "suspend") visitSuspend(parent);
      }
      return;
    }
    if (
      parent !== undefined &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === top
    ) {
      const op = parent.name.text;
      const gp = parent.parent;
      const called = gp !== undefined && ts.isCallExpression(gp) && gp.expression === parent;
      if (called && (op === "call" || op === "apply")) {
        if (op === "call" && member === "run") visitRun(gp, 1);
        else if (op === "call" && member === "suspend") visitSuspend(gp, 1);
        else if (op === "apply" && (member === "run" || member === "suspend")) {
          unresolved.push({
            expr: `ctx.${member}.apply(…)`,
            kind: member === "run" ? "step" : "suspend",
            ...at,
          });
        }
        return;
      }
      if (called && op === "bind") {
        routeValue(gp, member);
        return;
      }
      return; // `ctx.run.length` and the like
    }
    routeValue(top, member);
  }

  /** A reference to the execution context (or a method taken off it) in a value position. */
  function flagCtxReference(node: ts.Identifier, kind: "ctx" | "method"): void {
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
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
        ].includes(parent.operatorToken.kind))
    ) {
      return;
    }
    // `const k = ctx` — a const alias is itself a ctx name (collectCtx), so it is followed
    // rather than reported stored. `let`/reassigned stays stored-unresolved.
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer !== undefined &&
      unwrap(parent.initializer) === node &&
      ts.isIdentifier(parent.name) &&
      (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0
    ) {
      return;
    }
    if (kind === "method") {
      const member = ctx.members.get(node.text) as string;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        if (member === "run") visitRun(parent);
        else if (member === "suspend") visitSuspend(parent);
        return;
      }
      routeValue(node, member);
      return;
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    ) {
      flagCtxMember(parent);
      return;
    }
    // `const { decide, …rest } = ctx` — `decide` is L31's, the rest names were bound as ctx.
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isObjectBindingPattern(parent.name)
    ) {
      return;
    }
    // `ctx.run.bind(ctx)` / `.call(ctx, …)`: the ctx argument belongs to the member call,
    // which flagCtxMember already routes.
    const recv = receivingCall(node);
    if (recv !== undefined) {
      const e = unwrap(recv.call.expression);
      if (ts.isPropertyAccessExpression(e) && ["bind", "call", "apply"].includes(e.name.text)) {
        const m = unwrap(e.expression);
        const mm =
          ts.isPropertyAccessExpression(m) && ts.isIdentifier(unwrap(m.expression))
            ? (unwrap(m.expression) as ts.Identifier).text
            : undefined;
        if (
          mm !== undefined &&
          ctxNames.has(mm) &&
          CTX_METHODS.has((m as ts.PropertyAccessExpression).name.text)
        )
          return;
      }
    }
    routeValue(node);
  }

  function visitRun(call: ts.CallExpression, argOffset = 0): void {
    const target = call.arguments[argOffset];
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

  function visitSuspend(call: ts.CallExpression, argOffset = 0): void {
    const condition = call.arguments[argOffset];
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
      const recv = receivingCall(node);
      if (recv !== undefined) {
        recordEscape(recv.call, "decide");
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
    if (ts.isIdentifier(node)) {
      if (ctxNames.has(node.text)) flagCtxReference(node, "ctx");
      else if (ctx.members.has(node.text)) flagCtxReference(node, "method");
    }
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
