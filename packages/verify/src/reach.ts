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
  const d = v as { run?: unknown; transient?: unknown };
  if (d.run !== undefined && !isToolList(d.run)) return false;
  if (d.transient !== undefined && !isToolList(d.transient)) return false;
  return d.run !== undefined || d.transient !== undefined;
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
