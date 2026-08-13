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

export interface RunnerReach {
  steps: RunnerStepRef[];
  unresolved: UnresolvedReach[];
  suspends: RunnerSuspend[];
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

/** Analyze a parsed node (a flow runner body) for reachable steps and suspend points. */
export function analyzeReachNode(root: ts.Node, location?: string): RunnerReach {
  const bindings = collectBindings(root);
  const steps: RunnerStepRef[] = [];
  const unresolved: UnresolvedReach[] = [];
  const suspends: RunnerSuspend[] = [];
  const at = location !== undefined ? { location } : {};

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

  function visit(node: ts.Node): void {
    const run = methodCall(node, "run");
    if (run !== undefined) visitRun(run);
    const suspend = methodCall(node, "suspend");
    if (suspend !== undefined) visitSuspend(suspend);
    // `ctx.sleep`/`sleepUntil` are deliberately NOT recorded. The kernel authors
    // their condition (`on: TIMER_FIRED`, `wakeAt` always set), so treating them
    // as user-authored suspend points would manufacture findings about code the
    // developer never wrote.
    ts.forEachChild(node, visit);
  }

  visit(root);
  return { steps, unresolved, suspends };
}

/**
 * Analyze a source string (a flow runner / orchestration body). Feed the result
 * to `@loom/verify` via `resolveVerifyInput({ runnerReachByFlow })`.
 */
export function analyzeRunnerReach(source: string, location?: string): RunnerReach {
  const sf = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.ESNext, true);
  return analyzeReachNode(sf, location);
}
