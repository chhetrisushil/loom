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
  /**
   * L34 - the arguments of the hand-off that RESOLVE to a step, by position, for a callee whose
   * declaration says it runs a step it is handed (`fanout$(ctx, step, items)`: argument 1). A
   * position absent here did not resolve; the verifier reports that only if the declaration names
   * the position. Absent for `via: "decide"`, a ctx method, and a pass-through
   * (`setTimeout(lib, …)`), whose arguments are not the callee's.
   */
  args?: ReachEscapeArg[];
  location?: string;
}

/** One argument of a ctx hand-off, see {@link ReachEscape.args}. */
export interface ReachEscapeArg {
  index: number;
  step: RunnerStepRef;
}

/**
 * Resolution services the analysis cannot do on a single parsed module. Optional: without it
 * the analysis is same-module only.
 */
export interface AnalyzeReachOptions {
  /**
   * L37 - resolve a name this module IMPORTS to what its declaration shows: a string constant
   * (`export const LLM_X = "llm.x"`) or a step-factory shape (`export function llmStep$(id, toolId)`).
   */
  importResolver?: (localName: string) => ImportedBinding | undefined;
}

/** What an imported name resolves to. */
export interface ImportedBinding {
  value?: string;
  factory?: StepFactoryShape;
}

/**
 * L37 - how a step factory yields its effect id: a fixed one (`mcpInvoke$` always dispatches
 * `mcp.invoke`; the step ID is minted but the EFFECT is what verify checks) or the value of one of
 * its parameters (`llmStep$(id, toolId)`).
 */
export type StepFactoryShape =
  | { fixed: string }
  /** The effect id is argument `argIndex`; when that argument is absent, `default` (a parameter default). */
  | { argIndex: number; default?: string };

/**
 * First-party factories whose effect id is fixed and whose source is in a package (never followed
 * through an import). `mcp.invoke` is `MCP_INVOKE_TOOL_ID` in `@loom/plugin-mcp` and `sandbox.eval` is
 * `SANDBOX_TOOL_ID` in `@loom/plugin-sandbox`; a test pins each to its package.
 */
export const KNOWN_STEP_FACTORIES: Readonly<Record<string, StepFactoryShape>> = {
  mcpInvoke$: { fixed: "mcp.invoke" },
  // `sandboxEval$(id, toolId = SANDBOX_TOOL_ID)` in `@loom/plugin-sandbox`.
  sandboxEval$: { argIndex: 1, default: "sandbox.eval" },
};

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

/** The name a call's callee ends in: `ctx.run` / `ctx["run"]` / `run`, through `.call/.apply/.bind`. */
function calleeMethodName(call: ts.CallExpression): string | undefined {
  let e: ts.Expression = unwrap(call.expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      if (
        ["call", "apply", "bind"].includes(e.name.text) &&
        ts.isPropertyAccessExpression(unwrap(e.expression))
      )
        e = unwrap(e.expression);
      else return e.name.text;
    } else if (ts.isElementAccessExpression(e)) {
      const a = unwrap(e.argumentExpression);
      return ts.isStringLiteralLike(a) ? a.text : undefined;
    } else return ts.isIdentifier(e) ? e.text : undefined;
  }
}

/**
 * Whether a step object bound to `name` can change between its declaration and its use (ADR 0086,
 * 2026-10-10 amendment). The only uses that cannot change it are: the declaration, an argument of a
 * ctx method call (`ctx.run(s)`) or a ctx hand-off (`lib(ctx, s)`, L34), an element of an array literal (a `ctx.parallel` tuple), a spread
 * copy, and a property READ. Anything else - a property assignment / `delete` / `++`, being handed to
 * `Object.assign(s, ...)` or any other function, aliased, returned, stored in another object -
 * makes the binding "not followed" (unresolved): a guess at `toolId` would name the wrong effect.
 */
function stepBindingEscapes(
  sourceFile: ts.SourceFile,
  name: string,
  ctxNames: ReadonlySet<string>,
  isLoomFlowBuilder: (callee: ts.Expression) => boolean = () => false
): boolean {
  let escapes = false;
  const strip = (n: ts.Node): ts.Node => {
    let top = n;
    while (
      top.parent !== undefined &&
      (ts.isParenthesizedExpression(top.parent) ||
        ts.isAsExpression(top.parent) ||
        ts.isNonNullExpression(top.parent) ||
        ts.isSatisfiesExpression(top.parent))
    )
      top = top.parent;
    return top;
  };
  const isWriteTarget = (member: ts.Node): boolean => {
    let top = strip(member);
    // Walk out of destructuring-assignment patterns: `[s.toolId] = …`, `({ a: s.toolId } = …)`.
    while (
      top.parent !== undefined &&
      (ts.isArrayLiteralExpression(top.parent) ||
        ts.isPropertyAssignment(top.parent) ||
        ts.isShorthandPropertyAssignment(top.parent) ||
        ts.isSpreadElement(top.parent) ||
        ts.isSpreadAssignment(top.parent) ||
        ts.isObjectLiteralExpression(top.parent))
    )
      top = strip(top.parent);
    const p = top.parent;
    if (p === undefined) return false;
    if (ts.isBinaryExpression(p))
      return (
        p.left === top &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    if (ts.isDeleteExpression(p)) return true;
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    // `for (s.toolId of xs)` / `for (s.toolId in o)`.
    return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === top;
  };
  const walk = (n: ts.Node): void => {
    if (escapes) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      const top = strip(n);
      const q = top.parent;
      const isDecl = ts.isVariableDeclaration(p) && p.name === n;
      // `{ s: 1 }` key, `x.s` member name, `{ s }` shorthand is a VALUE use (handled by falling through).
      const isNotAReference =
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertySignature(p) && p.name === n);
      if (!isDecl && !isNotAReference) {
        let ok = false;
        // A ctx method call or a ctx hand-off (`lib(ctx, s)`, the declared-reach seam, L34) may take
        // an argument: its step arguments are recorded for the callee's declaration.
        const isCtxCall = (c: ts.CallExpression): boolean => {
          const m = calleeMethodName(c);
          return (
            (m !== undefined && CTX_METHODS.has(m)) ||
            c.arguments.some((a) => {
              const u = unwrap(a);
              return ts.isIdentifier(u) && ctxNames.has(u.text);
            })
          );
        };
        if (
          q !== undefined &&
          ts.isCallExpression(q) &&
          q.arguments.includes(top as ts.Expression)
        ) {
          ok = isCtxCall(q);
        } else if (q !== undefined && ts.isArrayLiteralExpression(q)) {
          // A `ctx.parallel([[s, input]])` tuple: safe ONLY when the OUTERMOST enclosing array
          // literal is itself directly an argument of a ctx call. Bound, iterated, destructured or
          // spread (`const a = [s]`, `[s].forEach`, `f(...[s])`) it is an alias: an escape.
          let outer: ts.Node = q;
          for (;;) {
            const o = strip(outer);
            if (o.parent !== undefined && ts.isArrayLiteralExpression(o.parent)) outer = o.parent;
            else {
              outer = o;
              break;
            }
          }
          const host = outer.parent;
          if (
            host !== undefined &&
            ts.isVariableDeclaration(host) &&
            host.initializer === outer &&
            ts.isIdentifier(host.name) &&
            ts.isVariableDeclarationList(host.parent) &&
            (host.parent.flags & ts.NodeFlags.Const) !== 0
          ) {
            // `const pairs = [[s, 1]]; ctx.parallel(pairs)`: the list is followed (rule 5) only if
            // the binding is used nowhere but as a direct ctx-call argument.
            const listName = host.name.text;
            let clean = true;
            const scan = (n: ts.Node): void => {
              if (!clean) return;
              if (ts.isIdentifier(n) && n.text === listName && n !== host.name) {
                const isKey =
                  (ts.isPropertyAssignment(n.parent) && n.parent.name === n) ||
                  (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n);
                const t = strip(n);
                const c = t.parent;
                if (
                  !isKey &&
                  !(
                    c !== undefined &&
                    ts.isCallExpression(c) &&
                    c.arguments.includes(t as ts.Expression) &&
                    isCtxCall(c)
                  )
                )
                  clean = false;
              }
              ts.forEachChild(n, scan);
            };
            scan(sourceFile);
            ok = clean;
          } else if (
            host !== undefined &&
            ts.isPropertyAssignment(host) &&
            host.initializer === outer &&
            propName(host.name) === "steps" &&
            ts.isObjectLiteralExpression(strip(host.parent)) &&
            (() => {
              const lit = strip(host.parent);
              const call = lit.parent;
              return (
                call !== undefined &&
                ts.isCallExpression(call) &&
                call.arguments[0] === lit &&
                isLoomFlowBuilder(call.expression)
              );
            })()
          ) {
            // `flow$({ steps: [s] })` DECLARES the step: loom's own `flow$` (imported unshadowed from
            // @loom/core / @loom/sdk) keeps the list and the runtime only reads it.
            ok = true;
          } else {
            ok =
              host !== undefined &&
              ts.isCallExpression(host) &&
              host.arguments.includes(outer as ts.Expression) &&
              isCtxCall(host);
          }
        } else if (q !== undefined && ts.isSpreadAssignment(q)) ok = true;
        else if (
          q !== undefined &&
          (ts.isPropertyAccessExpression(q) || ts.isElementAccessExpression(q)) &&
          q.expression === top
        ) {
          // A property READ is fine; a write through it, or a method call on it, is not.
          let chain: ts.Node = q;
          while (
            chain.parent !== undefined &&
            (ts.isPropertyAccessExpression(chain.parent) ||
              ts.isElementAccessExpression(chain.parent)) &&
            chain.parent.expression === chain
          )
            chain = chain.parent;
          const callee = strip(chain).parent;
          const isMethodCall =
            callee !== undefined &&
            ts.isCallExpression(callee) &&
            callee.expression === strip(chain);
          ok = !isWriteTarget(chain) && !isMethodCall;
        }
        if (!ok) escapes = true;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sourceFile);
  return escapes;
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
  /** name -> how many times it is declared ANYWHERE in the region (any scope, any kind). */
  declared: Map<string, number>;
  ambiguous: Set<string>;
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
    } else if (
      (ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isFunctionExpression(node)) &&
      node.name !== undefined
    ) {
      declare(node.name.text);
      ambiguous.add(node.name.text);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text);
      ambiguous.add(node.name.text);
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
  return { fns, inits, declared, ambiguous };
}

/** Every name bound by a binding name (identifier or destructuring pattern). */
function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Every name declared anywhere inside `node` (parameters, variables, patterns, functions, classes). */
function namesDeclaredWithin(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.name)
      bindingNames(n.name, out);
    else if (
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n) ||
        ts.isEnumDeclaration(n)) &&
      n.name !== undefined
    )
      out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Whether any identifier inside `e` is in `names`. */
function mentionsAny(e: ts.Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(e) && names.has(e.text)) return true;
  return ts.forEachChild(e, (c) => (mentionsAny(c, names) ? true : undefined)) === true;
}

/** Import bindings of a module: local name -> module specifier and the imported (exported) name. */
/** Every local name an import binds (named, default and namespace; type-only included, harmlessly). */
function allImportBindings(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const clause = st.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) out.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb === undefined) continue;
    if (ts.isNamespaceImport(nb)) out.add(nb.name.text);
    else for (const el of nb.elements) out.add(el.name.text);
  }
  return out;
}

function importedNames(sf: ts.SourceFile): Map<string, { spec: string; imported: string }> {
  const out = new Map<string, { spec: string; imported: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        out.set(el.name.text, {
          spec: st.moduleSpecifier.text,
          imported: (el.propertyName ?? el.name).text,
        });
      }
    }
  }
  return out;
}

/**
 * Module specifiers a {@link KNOWN_STEP_FACTORIES} entry may be imported from: its package, and
 * `@loom/sdk` where the SDK re-exports it (`export * from "@loom/plugin-mcp"`; the sandbox plugin
 * is only at the `@loom/sdk/sandbox` subpath).
 */
const KNOWN_FACTORY_SOURCES: Readonly<Record<string, readonly string[]>> = {
  mcpInvoke$: ["@loom/plugin-mcp", "@loom/sdk"],
  sandboxEval$: ["@loom/plugin-sandbox", "@loom/sdk/sandbox"],
};

/** The string a literal-ish expression denotes (`"x"`, an expression-free template, `"x" as const`). */
export function stringLiteralValue(e: ts.Expression): string | undefined {
  const u = unwrap(e);
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined;
}

/**
 * L37 - infer how a function yields a step's effect id, by SHAPE (like {@link collectBindings}):
 * its single returned expression is a call whose first argument is an object literal with a
 * `toolId` that is a constant (per `str`) or one of the function's plain parameters. Anything else
 * (several returns, a spread, a computed toolId) is `undefined`, never a guess.
 */
export function inferStepFactory(
  fn: ts.Node,
  rawStr: (e: ts.Expression) => string | undefined
): StepFactoryShape | undefined {
  if (!isFn(fn) || fn.body === undefined) return undefined;
  // Names declared anywhere in the factory (parameters, body locals, nested scopes) shadow a
  // module constant of the same name, so an expression that mentions one is never constant-folded.
  const inner = namesDeclaredWithin(fn);
  const str = (e: ts.Expression): string | undefined =>
    mentionsAny(e, inner) ? undefined : rawStr(e);
  let returned: ts.Expression | undefined;
  if (!ts.isBlock(fn.body)) returned = fn.body;
  else {
    let count = 0;
    const scan = (n: ts.Node): void => {
      if (isFn(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n)) return;
      if (ts.isReturnStatement(n)) {
        count++;
        returned = n.expression;
      }
      ts.forEachChild(n, scan);
    };
    ts.forEachChild(fn.body, scan);
    if (count !== 1) return undefined;
  }
  if (returned === undefined) return undefined;
  const call = unwrap(returned);
  if (!ts.isCallExpression(call)) return undefined;
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  const paramIndex = (name: string): number | undefined => {
    const i = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
    const p = fn.parameters[i];
    return i >= 0 && p !== undefined && p.dotDotDotToken === undefined ? i : undefined;
  };
  const viaParam = (i: number): StepFactoryShape => {
    const init = fn.parameters[i]?.initializer;
    const dflt = init === undefined ? undefined : str(init);
    return { argIndex: i, ...(dflt !== undefined && { default: dflt }) };
  };
  for (const prop of arg.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "toolId") {
      const i = paramIndex("toolId");
      return i === undefined ? undefined : viaParam(i);
    }
    if (ts.isPropertyAssignment(prop) && propName(prop.name) === "toolId") {
      const v = unwrap(prop.initializer);
      if (ts.isIdentifier(v)) {
        const i = paramIndex(v.text);
        if (i !== undefined) return viaParam(i);
      }
      const fixed = str(v);
      return fixed !== undefined ? { fixed } : undefined;
    }
  }
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
  /** How many runner functions `collectRunners` found and followed in this region. */
  runners: number;
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
  return { names, members, unresolved, runners: found.runners.length };
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
export function analyzeReachNode(
  root: ts.Node,
  location?: string,
  options: AnalyzeReachOptions = {}
): RunnerReach {
  return analyzeReachRegion(root, location, options).reach;
}

/**
 * {@link analyzeReachNode} plus how many runner functions the region declares and the analysis
 * followed. An EMPTY reach is ambiguous on its own: "the runner reaches nothing" and "there is no
 * runner here to read" (a flow whose runner is registered from another module) look the same. A
 * runner that is NOT followable is never silent — it is reported as `unresolved` ("runner not
 * analysable: …") — so an empty reach with `runners > 0` means every runner here was read and none
 * reaches a step, a suspend or a ctx hand-off: a pure runner, analysed.
 */
export function analyzeReachRegion(
  root: ts.Node,
  location?: string,
  options: AnalyzeReachOptions = {}
): { reach: RunnerReach; runners: number } {
  const scan = scanDeclarations(root);
  const functions = scan.fns;
  const constInits = scan.inits;
  const sourceFile = ts.isSourceFile(root) ? root : root.getSourceFile();
  const declaredAnywhere = scan.declared;
  const imports = importedNames(sourceFile);
  // An imported name that is ALSO declared somewhere in the module (a same-named local in another
  // function) is ambiguous in BOTH directions: the use may be the import or the local, so neither
  // the local function/const/binding nor the import may answer for it (-> unresolved).
  const importBindings = allImportBindings(sourceFile);
  for (const name of importBindings) {
    functions.delete(name);
    constInits.delete(name);
  }
  // A step binding is followed only when its name is declared exactly once, never reassigned: a
  // shadowing parameter or a second same-named binding in another function makes it ambiguous.
  const bindings = collectBindings(root);
  for (const name of [...bindings.keys()]) {
    if (
      (declaredAnywhere.get(name) ?? 0) !== 1 ||
      scan.ambiguous.has(name) ||
      importBindings.has(name)
    )
      bindings.delete(name);
  }
  /** A name with no declaration anywhere in the module: only then can it be the import binding. */
  const unshadowed = (name: string): boolean => (declaredAnywhere.get(name) ?? 0) === 0;
  const importer = options.importResolver;
  const steps: RunnerStepRef[] = [];
  const unresolved: UnresolvedReach[] = [];
  const suspends: RunnerSuspend[] = [];
  const escapes: ReachEscape[] = [];
  const escapeSeen = new Set<string>();
  const ctx = collectCtx(root, functions);
  const ctxNames = ctx.names;
  const at = location !== undefined ? { location } : {};
  for (const expr of ctx.unresolved) unresolved.push({ expr, kind: "step", ...at });

  /**
   * L37 - the string a constant expression denotes: a literal, an expression-free or
   * all-constant template, `a + b`, or an identifier bound once to such a `const` in this module
   * (or IMPORTED from a relative module, when an `importResolver` is supplied). `undefined` for
   * anything else - never a guess.
   */
  const constString = (e: ts.Expression, depth = 0): string | undefined => {
    if (depth > 8) return undefined;
    const u = unwrap(e);
    if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
    if (ts.isTemplateExpression(u)) {
      let out = u.head.text;
      for (const span of u.templateSpans) {
        const v = constString(span.expression, depth + 1);
        if (v === undefined) return undefined;
        out += v + span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = constString(u.left, depth + 1);
      const r = l === undefined ? undefined : constString(u.right, depth + 1);
      return l !== undefined && r !== undefined ? l + r : undefined;
    }
    if (ts.isIdentifier(u)) {
      // Also declared somewhere in this module, yet imported: which one the use means is unknown.
      if (imports.has(u.text) && !unshadowed(u.text)) return undefined;
      const init = constInits.get(u.text);
      if (init !== undefined) return constString(init, depth + 1);
      return unshadowed(u.text) ? importer?.(u.text)?.value : undefined;
    }
    return undefined;
  };

  /** A string property of an object literal, constant-resolved (`toolId: LLM_X`). */
  const constProp = (obj: ts.ObjectLiteralExpression, name: string): string | undefined => {
    // JS takes the LAST duplicate key, and a spread AFTER the key may override it: neither is
    // authoritative, so the property is unresolved (a spread BEFORE the key is fine).
    let found: string | undefined;
    let count = 0;
    let spreadAfter = false;
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        if (count > 0) spreadAfter = true;
        continue;
      }
      if (ts.isPropertyAssignment(p) && propName(p.name) === name) {
        count++;
        found = constString(p.initializer);
      } else if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) {
        count++;
        found = constString(p.name);
      }
    }
    return count === 1 && !spreadAfter ? found : undefined;
  };

  /**
   * L37 - a step-producing call: the shape-based `anything$({ toolId })` first, then a factory
   * (same-module function, imported function, or a first-party one in {@link KNOWN_STEP_FACTORIES})
   * whose effect id is fixed or one of its arguments. The step ID may be templated (`tool:${i}`):
   * verify needs the EFFECT id.
   */
  const resolveCall = (call: ts.CallExpression): RunnerStepRef | undefined => {
    const first = call.arguments[0];
    if (first !== undefined && ts.isObjectLiteralExpression(first)) {
      const toolId = constProp(first, "toolId");
      if (toolId !== undefined) {
        const stepId = constProp(first, "id");
        return { toolId, ...(stepId !== undefined && { stepId }) };
      }
    }
    const callee = unwrap(call.expression);
    // A step with NO `toolId` dispatches its own id: the runtime resolves `step.toolId ?? step.id`
    // (WorkflowRuntime). Followed only for `step$` itself (an unshadowed import from @loom/core or
    // @loom/sdk, any alias) whose object has no `toolId` key and no spread: a wrapper might add one.
    if (
      first !== undefined &&
      ts.isObjectLiteralExpression(first) &&
      ts.isIdentifier(callee) &&
      unshadowed(callee.text) &&
      first.properties.every(
        (p) =>
          !ts.isSpreadAssignment(p) &&
          !ts.isMethodDeclaration(p) &&
          !(p.name !== undefined && propName(p.name) === "toolId") &&
          !(p.name !== undefined && ts.isComputedPropertyName(p.name))
      )
    ) {
      const imp = imports.get(callee.text);
      if (imp?.imported === "step$" && (imp.spec === "@loom/core" || imp.spec === "@loom/sdk")) {
        const id = constProp(first, "id");
        return id === undefined ? undefined : { toolId: id, stepId: id };
      }
    }
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name === undefined || call.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
    let shape: StepFactoryShape | undefined;
    const local = ts.isIdentifier(callee) ? functions.get(name) : undefined;
    if (local !== undefined) shape = inferStepFactory(local, constString);
    else if (!ts.isIdentifier(callee) || !unshadowed(name)) shape = undefined;
    else {
      // A bare, undeclared name: the import binding. A relative wrapper is followed through the
      // importer; a first-party factory only when imported from its own package (or the SDK).
      const imp = imports.get(name);
      shape = importer?.(name)?.factory;
      if (
        shape === undefined &&
        imp !== undefined &&
        Object.hasOwn(KNOWN_STEP_FACTORIES, imp.imported) &&
        KNOWN_FACTORY_SOURCES[imp.imported]?.includes(imp.spec) === true
      ) {
        shape = KNOWN_STEP_FACTORIES[imp.imported];
      }
    }
    if (shape === undefined) return undefined;
    if ("fixed" in shape) return { toolId: shape.fixed };
    const arg = call.arguments[shape.argIndex];
    const toolId = arg === undefined ? shape.default : constString(arg);
    return toolId === undefined ? undefined : { toolId };
  };

  /**
   * Resolve a `ctx.run` / `ctx.parallel` / hand-off step target to a tool, or `undefined` when it
   * cannot be (reported unresolved by the caller - never silently dropped).
   */
  const isLoomFlowBuilder = (callee: ts.Expression): boolean => {
    const c = unwrap(callee);
    if (!ts.isIdentifier(c) || !unshadowed(c.text)) return false;
    const imp = imports.get(c.text);
    return imp?.imported === "flow$" && (imp.spec === "@loom/core" || imp.spec === "@loom/sdk");
  };
  const escapeCache = new Map<string, boolean>();
  const resolveTarget = (target: ts.Expression, depth = 0): RunnerStepRef | undefined => {
    const t = unwrap(target);
    if (ts.isIdentifier(t)) {
      // A step object that is mutated, aliased or handed to another function may no longer be what
      // its declaration says (ADR 0086 amendment 2026-10-10): not followed, never guessed.
      let escapes = escapeCache.get(t.text);
      if (escapes === undefined) {
        escapes = stepBindingEscapes(sourceFile, t.text, ctxNames, isLoomFlowBuilder);
        escapeCache.set(t.text, escapes);
      }
      if (escapes) return undefined;
      const bound = bindings.get(t.text);
      if (bound !== undefined) return bound;
      const init = constInits.get(t.text);
      return init !== undefined && depth < 4 ? resolveTarget(init, depth + 1) : undefined;
    }
    if (ts.isObjectLiteralExpression(t)) {
      const toolId = constProp(t, "toolId");
      if (toolId === undefined) return undefined;
      const stepId = constProp(t, "id");
      return { toolId, ...(stepId !== undefined && { stepId }) };
    }
    if (ts.isCallExpression(t)) return resolveCall(t);
    return undefined;
  };

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
   * L34 - the hand-off's arguments (at most the first 8) that resolve to a step.
   */
  function escapeArgs(site: ts.CallExpression | ts.NewExpression): ReachEscapeArg[] {
    const out: ReachEscapeArg[] = [];
    (site.arguments ?? []).slice(0, 8).forEach((a, index) => {
      const step = resolveTarget(a);
      if (step !== undefined) out.push({ index, step });
    });
    return out;
  }

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
    // L34 - the other arguments, for a whole-ctx hand-off made directly (not through a
    // pass-through, whose arguments are not the callee's).
    const args =
      via === "ctx" && member === undefined && !PASS_THROUGH.has(direct)
        ? escapeArgs(site)
        : undefined;
    const key = `${via}:${member ?? ""}:${text}:${args === undefined ? "" : JSON.stringify(args)}`;
    if (escapeSeen.has(key)) return;
    escapeSeen.add(key);
    escapes.push({
      callee: text,
      ...(rootName !== undefined && { root: rootName }),
      via,
      ...(member !== undefined && { member }),
      ...(args !== undefined && args.length > 0 && { args }),
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
        else if (member === "parallel") visitParallel(parent);
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
        else if (op === "call" && member === "parallel") visitParallel(gp, 1);
        else if (op === "call" && member === "suspend") visitSuspend(gp, 1);
        else if (
          op === "apply" &&
          (member === "run" || member === "suspend" || member === "parallel")
        ) {
          unresolved.push({
            expr: `ctx.${member}.apply(…)`,
            kind: member === "suspend" ? "suspend" : "step",
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
        else if (member === "parallel") visitParallel(parent);
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
    const ref = resolveTarget(target);
    if (ref !== undefined) {
      steps.push(ref);
      return;
    }
    // An element access, a parameter, a factory whose effect id is not constant - all real and
    // all unresolvable from this region alone.
    unresolved.push({ expr: exprText(target), kind: "step", ...at });
  }

  /**
   * L35 - `ctx.parallel([[step, input], …])`. Each tuple's first element is a `ctx.run` target,
   * resolved the same way. A branch written as a callback is already walked (its `b.run(...)` is
   * found like any `run`). A pair list that is not an array literal (or a const bound to one), a
   * spread, or a branch that is neither a tuple nor a function is reported unresolved: the steps
   * it holds cannot be seen, and an empty answer would read as "reaches nothing".
   */
  function listUsedBeyondParallel(name: string): boolean {
    let used = false;
    const walk = (n: ts.Node): void => {
      if (used) return;
      if (ts.isIdentifier(n) && n.text === name) {
        let top: ts.Node = n;
        while (
          top.parent !== undefined &&
          (ts.isParenthesizedExpression(top.parent) ||
            ts.isAsExpression(top.parent) ||
            ts.isNonNullExpression(top.parent) ||
            ts.isSatisfiesExpression(top.parent))
        )
          top = top.parent;
        const p = n.parent;
        const isDecl = ts.isVariableDeclaration(p) && p.name === n;
        const isMemberName = ts.isPropertyAccessExpression(p) && p.name === n;
        const isKey = (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === n;
        const isParallelArg =
          top.parent !== undefined &&
          ts.isCallExpression(top.parent) &&
          methodCall(top.parent, "parallel") !== undefined &&
          top.parent.arguments.includes(top as ts.Expression);
        if (!isDecl && !isMemberName && !isKey && !isParallelArg) used = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(sourceFile);
    return used;
  }

  function visitParallel(call: ts.CallExpression, argOffset = 0): void {
    const arg = call.arguments[argOffset];
    if (arg === undefined) return;
    let list = unwrap(arg);
    if (ts.isIdentifier(list)) {
      const init = constInits.get(list.text);
      if (init !== undefined) {
        // A list that is also pushed to / passed on / iterated is not the literal it was bound to.
        if (listUsedBeyondParallel(list.text)) {
          unresolved.push({ expr: `parallel(${exprText(arg)})`, kind: "step", ...at });
          return;
        }
        list = unwrap(init);
      }
    }
    if (!ts.isArrayLiteralExpression(list)) {
      unresolved.push({ expr: `parallel(${exprText(arg)})`, kind: "step", ...at });
      return;
    }
    for (const el of list.elements) {
      if (ts.isSpreadElement(el)) {
        unresolved.push({ expr: `parallel(...${exprText(el.expression)})`, kind: "step", ...at });
        continue;
      }
      const u = unwrap(el);
      if (ts.isArrayLiteralExpression(u)) {
        const first = u.elements[0];
        if (first === undefined || ts.isSpreadElement(first)) {
          unresolved.push({ expr: `parallel branch ${exprText(u)}`, kind: "step", ...at });
          continue;
        }
        const ref = resolveTarget(first);
        if (ref !== undefined) steps.push(ref);
        else unresolved.push({ expr: exprText(first), kind: "step", ...at });
      } else if (isFn(u) || (ts.isIdentifier(u) && functions.has(u.text))) {
        // A callback branch: its body is part of this walk.
      } else {
        unresolved.push({ expr: `parallel branch ${exprText(u)}`, kind: "step", ...at });
      }
    }
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
      const first = c.arguments[0];
      const id = first === undefined ? undefined : constString(first);
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
    const parallel = methodCall(node, "parallel");
    if (parallel !== undefined) visitParallel(parallel);
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
  return {
    reach: { steps, unresolved, suspends, ...(escapes.length > 0 && { escapes }) },
    runners: ctx.runners,
  };
}

/**
 * Analyze a source string (a flow runner / orchestration body). Feed the result
 * to `@loom/verify` via `resolveVerifyInput({ runnerReachByFlow })`.
 */
export function analyzeRunnerReach(source: string, location?: string): RunnerReach {
  const sf = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.ESNext, true);
  return analyzeReachNode(sf, location);
}
