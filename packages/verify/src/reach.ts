// L32 — declared reach. Code that a flow hands its `ctx` to (a planner, a retriever, an agent
// loop) runs effects the flow's own source never names, so the compiler's runner-body analysis
// cannot see them. The code DECLARES what it reaches; the verifier reads the declaration from the
// real object the app wires (`verify.reach`), then checks the named tools against the real grants
// and registry like any other reached effect.
//
// The declaration is a plain value under a `Symbol.for` key, so a third-party library can attach it
// with ZERO dependency on loom: `Object.defineProperty(x, Symbol.for("loom.verify.reach"), { value })`.
// `declareReach` is the convenience for code that already imports `@loom/verify`.

/** The well-known key a declaration lives under. Equal to `Symbol.for("loom.verify.reach")`. */
export const REACH_DECLARATION: unique symbol = Symbol.for("loom.verify.reach") as never;

/**
 * What code run with a flow's `ctx` reaches. A declaration is a CLAIM about the code: the
 * verifier checks the named tools against grants and the registry, not that the code calls only
 * those. Suspends inside the library are not expressible (the library cannot suspend the flow
 * without a `ctx.suspend` the flow's own region would show).
 */
export interface ReachDeclaration {
  /** toolIds the code runs through `ctx.run` / `ctx.execute` (journaled steps). */
  readonly run?: readonly string[];
  /** toolIds the code calls through `scope.invokeTransient` inside a `ctx.decide` decider. */
  readonly transient?: readonly string[];
  /**
   * L34 — zero-based argument positions of STEP DEFINITIONS the code runs with the ctx it is handed
   * (`fanout$(ctx, step, items)` -> `[1]`). The tool is its CALLER's, so it cannot be a fixed list:
   * the compiler reads the argument at each hand-off site and the verifier counts the step it
   * resolves to (and reports one it cannot resolve). Nothing else about the call is claimed.
   */
  readonly stepArgs?: readonly number[];
}

/** Attach a reach declaration to `target` (non-enumerable, so it never leaks into serialization). */
export function declareReach<T extends object>(target: T, declaration: ReachDeclaration): T {
  Object.defineProperty(target, REACH_DECLARATION, {
    value: declaration,
    enumerable: false,
    configurable: true,
  });
  return target;
}

function isToolList(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isDeclaration(v: unknown): v is ReachDeclaration {
  if (typeof v !== "object" || v === null) return false;
  const d = v as { run?: unknown; transient?: unknown; stepArgs?: unknown };
  if (d.run !== undefined && !isToolList(d.run)) return false;
  if (d.transient !== undefined && !isToolList(d.transient)) return false;
  if (
    d.stepArgs !== undefined &&
    !(Array.isArray(d.stepArgs) && d.stepArgs.every((x) => Number.isInteger(x) && x >= 0))
  )
    return false;
  return d.run !== undefined || d.transient !== undefined || d.stepArgs !== undefined;
}

/**
 * The declaration a `verify.reach` value carries: one attached under {@link REACH_DECLARATION},
 * else the value itself when it IS a plain `{ run?, transient? }` literal (an app-level
 * declaration for a library that has not adopted the symbol). `undefined` means undeclared —
 * a malformed declaration is treated the same, never half-read.
 */
export function readReachDeclaration(value: unknown): ReachDeclaration | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  const attached = (value as { [REACH_DECLARATION]?: unknown })[REACH_DECLARATION];
  if (attached !== undefined) return isDeclaration(attached) ? attached : undefined;
  return typeof value === "object" && isDeclaration(value) ? value : undefined;
}

// ── Claim vs reality ─────────────────────────────────────────────────────────
// A declaration is a CLAIM about code the verifier cannot see. This is the test-side half: run the
// library against a recording wrapper of a ctx (or scope) and compare what it ACTUALLY ran with
// what it declared. A library author (the loom-ui planner conformance suite, a retriever) calls
// this in their own tests so the declaration cannot drift from the code unnoticed.

/** What a recording wrapper saw. */
export interface RecordedReach {
  /** toolIds passed to `ctx.run` / `ctx.execute` / `ctx.parallel` pairs. */
  readonly run: readonly string[];
  /** toolIds passed to `scope.invokeTransient` (directly, or inside a `ctx.decide` decider). */
  readonly transient: readonly string[];
}

export interface ReachRecorder {
  /** Wrap a ctx (real or fake); the wrapper records and forwards. */
  ctx<T extends object>(ctx: T): T;
  /** Wrap a decide scope directly (for code that is handed only a scope). */
  scope<T extends object>(scope: T): T;
  /** Everything seen so far, sorted, de-duplicated. */
  readonly recorded: RecordedReach;
}

function toolIdOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as { toolId?: unknown; id?: unknown };
  // The runtime resolves a task's effect as `task.toolId ?? task.id` (WorkflowContext.execute).
  if (typeof o.toolId === "string") return o.toolId;
  if (o.toolId === undefined && typeof o.id === "string") return o.id;
  return undefined;
}

/** Create a recorder. See {@link assertReachMatches}. */
export function recordReach(): ReachRecorder {
  const run = new Set<string>();
  const transient = new Set<string>();
  const method = (
    target: object,
    key: string | symbol,
    wrap: (f: (...a: unknown[]) => unknown) => unknown
  ): unknown => {
    const v = Reflect.get(target, key, target);
    return typeof v === "function" ? wrap(v.bind(target)) : v;
  };
  const wrapScope = <T extends object>(scope: T): T =>
    new Proxy(scope, {
      get: (t, k) =>
        method(t, k, (f) =>
          k === "invokeTransient"
            ? (toolId: unknown, ...rest: unknown[]) => {
                if (typeof toolId === "string") transient.add(toolId);
                return f(toolId, ...rest);
              }
            : f
        ),
    });
  const wrapCtx = <T extends object>(ctx: T): T =>
    new Proxy(ctx, {
      get: (t, k) =>
        method(t, k, (f) => {
          if (k === "run" || k === "execute") {
            return (task: unknown, ...rest: unknown[]) => {
              const id = toolIdOf(task);
              if (id !== undefined) run.add(id);
              return f(task, ...rest);
            };
          }
          if (k === "parallel") {
            return (pairs: unknown, ...rest: unknown[]) => {
              if (Array.isArray(pairs)) {
                for (const pair of pairs) {
                  const id = Array.isArray(pair) ? toolIdOf(pair[0]) : undefined;
                  if (id !== undefined) run.add(id);
                }
              }
              return f(pairs, ...rest);
            };
          }
          if (k === "decide") {
            return (id: unknown, decider: unknown, ...rest: unknown[]) =>
              f(
                id,
                typeof decider === "function"
                  ? (scope: unknown) =>
                      (decider as (s: unknown) => unknown)(
                        typeof scope === "object" && scope !== null ? wrapScope(scope) : scope
                      )
                  : decider,
                ...rest
              );
          }
          return f;
        }),
    });
  return {
    ctx: wrapCtx,
    scope: wrapScope,
    get recorded(): RecordedReach {
      return { run: [...run].sort(), transient: [...transient].sort() };
    },
  };
}

/**
 * Throw unless everything `recorded` is covered by `declaration` (per kind: a `run` tool recorded
 * under `transient` or the reverse is a mismatch). Declared-but-unexercised tools are allowed
 * unless `exact` is set: a declaration is an upper bound, and a test that does not hit every
 * branch must not fail for it. Under-declaring is the dangerous direction and is always an error.
 */
export function assertReachMatches(
  declaration: ReachDeclaration,
  recorded: RecordedReach,
  opts: {
    exact?: boolean;
    /**
     * Tools the TEST handed the code as step arguments (for a `stepArgs` declaration, e.g.
     * `fanout$`): a recorded `run` tool in this list is covered by `stepArgs`, one that is not is
     * still a mismatch.
     */
    passedSteps?: readonly string[];
  } = {}
): void {
  const problems: string[] = [];
  const diff = (kind: "run" | "transient"): void => {
    const declared = new Set(declaration[kind] ?? []);
    if (kind === "run" && (declaration.stepArgs?.length ?? 0) > 0) {
      for (const t of opts.passedSteps ?? []) declared.add(t);
    }
    const seen = new Set(recorded[kind]);
    for (const t of seen)
      if (!declared.has(t)) problems.push(`${kind} tool "${t}" ran but is not declared`);
    if (opts.exact === true) {
      for (const t of declared)
        if (!seen.has(t)) problems.push(`${kind} tool "${t}" is declared but never ran`);
    }
  };
  diff("run");
  diff("transient");
  if (problems.length > 0) {
    throw new Error(`reach declaration does not match what ran: ${problems.join("; ")}`);
  }
}
