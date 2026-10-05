// ── Policy enforcement (policy$ → the K2 protection ring) ─────────────────────
//
// A `PolicyAuthorizer` turns declarative `policy$` definitions into per-effect
// authorization decisions, so a `PolicyDefinition` attached to a flow/agent (or
// declared app-globally) is actually ENFORCED at the one boundary every side
// effect flows through (`EffectRuntime.execute`). It composes UNDER an existing
// authorizer (e.g. a `GrantTable`): an effect runs only if BOTH allow — policy
// can tighten, never widen, a grant (defense in depth). Pure + synchronous like
// every authorizer, so the decision is deterministic and replay-safe.

import type { PolicyDefinition } from "@loom/core";
import { capabilityId } from "./authz";
import type { CapabilityAuthorizer, CapabilityDecision, CapabilityRequest } from "./authz";

/**
 * A single matcher rule (the "rich" form). Every present field must match the
 * request (an omitted field is a wildcard); `deny` flips a match from allow to deny.
 * `effect`/`tenant`/`step` are globs (`*` matches any run of characters).
 */
export interface PolicyMatchRule {
  /** Glob on the effect (tool) id, e.g. `"external-*"`. */
  effect?: string;
  /** Glob on `principal.tenant`. */
  tenant?: string;
  /** Glob on the step id. */
  step?: string;
  /** When true, a match DENIES (default: a match ALLOWS). */
  deny?: boolean;
}

/**
 * The interpreted shape of `PolicyDefinition.rules`. Both forms may be combined:
 * the simple `allow`/`deny` effect lists AND the richer `match` rules. Semantics
 * are deny-wins — see {@link PolicyAuthorizer}.
 */
export interface PolicyRules {
  /** Effect ids / globs that are permitted (an allow-list restricts to these). */
  allow?: readonly string[];
  /** Effect ids / globs that are forbidden (deny wins over allow). */
  deny?: readonly string[];
  /** Richer matchers, evaluated in order; deny matches win. */
  match?: readonly PolicyMatchRule[];
}

/** Compile a glob (`*` → `.*`) to an anchored RegExp, escaping every other regex metachar. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * A compiled allow/deny list, split so an **exact** id is an O(1) `Set` membership test and
 * only genuine globs fall back to a linear RegExp scan (the common case — a list of concrete
 * effect ids — never touches the glob path). Compiled once at construction; matched per effect.
 */
interface PatternSet {
  exact: Set<string>;
  globs: RegExp[];
  /**
   * R12 — entries of the form `<effect>:<resource…>`, keyed by the EXACT effect before the first
   * `:`. Only these may match a request's qualified id when the pattern is an ALLOW: a bare glob
   * (`*.search`) must never widen onto a model/MCP-chosen resource name.
   */
  qualified: Map<string, PatternSet>;
}
function compilePatterns(entries: readonly string[]): PatternSet {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  const qualified = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.includes("*")) globs.push(globToRegExp(entry));
    else exact.add(entry);
    const colon = entry.indexOf(":");
    if (colon > 0) {
      const prefix = entry.slice(0, colon);
      const list = qualified.get(prefix) ?? [];
      list.push(entry);
      qualified.set(prefix, list);
    }
  }
  const q = new Map<string, PatternSet>();
  for (const [prefix, list] of qualified) {
    const e = new Set<string>();
    const g: RegExp[] = [];
    for (const entry of list) {
      if (entry.includes("*")) g.push(globToRegExp(entry));
      else e.add(entry);
    }
    q.set(prefix, { exact: e, globs: g, qualified: new Map() });
  }
  return { exact, globs, qualified: q };
}
function patternSetMatches(set: PatternSet, value: string): boolean {
  return set.exact.has(value) || set.globs.some((g) => g.test(value));
}
/** DENY: stricter is safe — the bare effect id OR the qualified id may trigger it. */
function denyMatches(set: PatternSet, req: CapabilityRequest): boolean {
  if (patternSetMatches(set, req.toolId)) return true;
  return req.resource !== undefined && patternSetMatches(set, capabilityId(req));
}
/** ALLOW: the bare effect id; the qualified id only through a pattern naming this effect exactly. */
function allowMatches(set: PatternSet, req: CapabilityRequest): boolean {
  if (patternSetMatches(set, req.toolId)) return true;
  if (req.resource === undefined) return false;
  const q = set.qualified.get(req.toolId);
  return q !== undefined && patternSetMatches(q, capabilityId(req));
}
function patternSetEmpty(set: PatternSet): boolean {
  return set.exact.size === 0 && set.globs.length === 0;
}

interface CompiledMatch {
  effect?: RegExp;
  /** The exact effect id a qualified (`<effect>:<resource>`) allow pattern names. */
  effectQualifiedFor?: string[];
  tenant?: RegExp;
  step?: RegExp;
  deny: boolean;
}
interface CompiledPolicy {
  allow: PatternSet;
  deny: PatternSet;
  match: CompiledMatch[];
}

function asRules(rules: Record<string, unknown>): PolicyRules {
  // `PolicyDefinition.rules` is a freeform bag; read the fields we interpret and
  // ignore the rest (forward-compatible). Non-array fields degrade to empty.
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    allow: arr(rules.allow).filter((x): x is string => typeof x === "string"),
    deny: arr(rules.deny).filter((x): x is string => typeof x === "string"),
    match: arr(rules.match).filter(
      (x): x is PolicyMatchRule => typeof x === "object" && x !== null
    ),
  };
}

function compile(policy: PolicyDefinition): CompiledPolicy {
  const rules = asRules(policy.rules);
  return {
    allow: compilePatterns(rules.allow ?? []),
    deny: compilePatterns(rules.deny ?? []),
    match: (rules.match ?? []).map((m) => ({
      deny: m.deny === true,
      ...(m.effect !== undefined && {
        effect: globToRegExp(m.effect),
        ...(m.effect.indexOf(":") > 0 && {
          effectQualifiedFor: [m.effect.slice(0, m.effect.indexOf(":"))],
        }),
      }),
      ...(m.tenant !== undefined && { tenant: globToRegExp(m.tenant) }),
      ...(m.step !== undefined && { step: globToRegExp(m.step) }),
    })),
  };
}

/**
 * R12 — a DENY rule fires on the bare or qualified id; an ALLOW rule on the qualified id only
 * when its own pattern names this effect exactly before the first `:`.
 */
function effectMatches(rule: CompiledMatch, req: CapabilityRequest): boolean {
  if (rule.effect === undefined) return true;
  if (rule.effect.test(req.toolId)) return true;
  if (req.resource === undefined) return false;
  if (!rule.deny && !rule.effectQualifiedFor?.includes(req.toolId)) return false;
  return rule.effect.test(capabilityId(req));
}

/** A compiled match rule fires when every present field matches the request. */
function matchFires(rule: CompiledMatch, req: CapabilityRequest): boolean {
  if (rule.effect && !effectMatches(rule, req)) return false;
  if (rule.tenant && !rule.tenant.test(req.principal?.tenant ?? "")) return false;
  if (rule.step && !rule.step.test(req.stepId)) return false;
  return true;
}

export interface PolicyAuthorizerOptions {
  /**
   * App-global policies applied to EVERY request, on top of the per-principal set.
   * (From `defineConfig({ policies })`.)
   */
  global?: readonly PolicyDefinition[];
  /**
   * The authorizer this one composes UNDER — an effect is allowed only if the base
   * ALSO allows (defense in depth). If the base denies, that denial is returned
   * verbatim and the policy rules are never consulted.
   */
  base?: CapabilityAuthorizer;
  /**
   * Which request field identifies the principal whose policies apply. Default: the
   * `workflowId` (a flow is the unit of authority, matching `GrantTable`).
   */
  principal?: (req: CapabilityRequest) => string;
}

/**
 * Enforces `policy$` definitions as a {@link CapabilityAuthorizer}. Evaluation over
 * the applicable policies (global ∪ the principal's) is **deny-wins**:
 *
 * 1. any `deny` entry or `deny` match that fires → **denied**;
 * 2. else if an allow-constraint exists (a non-empty `allow` list, or any allow
 *    `match` rule) and nothing allows the effect → **denied**;
 * 3. else → **allowed**.
 *
 * A principal with no policies (and no global policies) is allowed — policies are
 * purely additive tightening, so wiring the authorizer never denies an effect that
 * has no policy governing it (the composed `base`, if any, still applies).
 */
export class PolicyAuthorizer implements CapabilityAuthorizer {
  private readonly byPrincipal: Map<string, CompiledPolicy[]>;
  private readonly global: CompiledPolicy[];
  private readonly base: CapabilityAuthorizer | undefined;
  private readonly principalOf: (req: CapabilityRequest) => string;

  constructor(
    policiesByPrincipal: Record<string, readonly PolicyDefinition[]>,
    options: PolicyAuthorizerOptions = {}
  ) {
    this.byPrincipal = new Map(
      Object.entries(policiesByPrincipal).map(([k, v]) => [k, v.map(compile)])
    );
    this.global = (options.global ?? []).map(compile);
    this.base = options.base;
    this.principalOf = options.principal ?? ((req) => req.workflowId);
  }

  authorize(req: CapabilityRequest): CapabilityDecision {
    // Defense in depth: the base authorizer must allow first; its denial is final.
    if (this.base !== undefined) {
      const baseDecision = this.base.authorize(req);
      if (!baseDecision.allowed) return baseDecision;
    }
    return this.evaluate(req);
  }

  private evaluate(req: CapabilityRequest): CapabilityDecision {
    // Scan the global group then the principal's group directly — no merged-array allocation on
    // this per-effect hot path. `state` accumulates the allow-list constraint across both groups.
    const state: AllowState = { constrained: false, allowed: false };
    const denial =
      this.scan(this.global, req, state) ??
      this.scan(this.byPrincipal.get(this.principalOf(req)), req, state);
    if (denial !== undefined) return denial;

    if (state.constrained && !state.allowed) {
      return {
        allowed: false,
        reason: `effect "${capabilityId(req)}" not permitted by policy allow-list`,
      };
    }
    return { allowed: true };
  }

  /**
   * Scan one policy group. Returns a denial (deny-wins → final) or `undefined`, mutating `state`
   * with any allow-list constraint seen. `undefined` policies (no group for the principal) no-op.
   */
  private scan(
    policies: CompiledPolicy[] | undefined,
    req: CapabilityRequest,
    state: AllowState
  ): CapabilityDecision | undefined {
    if (policies === undefined) return undefined;
    const deny: CapabilityDecision = {
      allowed: false,
      reason: `effect "${capabilityId(req)}" denied by policy`,
    };
    for (const policy of policies) {
      // (1) deny-wins — an explicit deny list entry.
      if (denyMatches(policy.deny, req)) return deny;
      // (2) allow-list — its presence restricts to matching effects.
      if (!patternSetEmpty(policy.allow)) {
        state.constrained = true;
        if (allowMatches(policy.allow, req)) state.allowed = true;
      }
      // (3) rich match rules — deny fires immediately; allow contributes.
      for (const rule of policy.match) {
        const fires = matchFires(rule, req);
        if (rule.deny) {
          if (fires) return deny;
        } else {
          state.constrained = true;
          if (fires) state.allowed = true;
        }
      }
    }
    return undefined;
  }
}

/** Mutable allow-list accumulator threaded across policy groups in one authorization. */
interface AllowState {
  constrained: boolean;
  allowed: boolean;
}
