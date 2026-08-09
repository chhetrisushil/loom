// ── Capability protection (Loom 2.0 K2) — the kernel's authority ring ─────────
//
// Every side effect flows through EffectRuntime.execute, so that is the one boundary
// a library CAN enforce (unlike hardware memory protection). A CapabilityAuthorizer
// decides, per invocation, whether the calling execution holds the authority to run
// the effect. Grants are unforgeable: an execution cannot grant itself a capability —
// grants live only in the authorizer, wired statically at boot (P5). A denied effect
// never runs; the denial is emitted as a durable EFFECT_DENIED fact (P9) and fails
// the step. Enforcement is opt-in: no authorizer ⇒ today's permissive behaviour.

/**
 * K12.1 — an authenticated principal chain, populated at the trust boundary
 * (A2A server / resume API) and propagated immutably through dispatch. The
 * KERNEL CARRIES IT OPAQUELY and never interprets it — authorizers, budget
 * scopes, and stores do. Keeping the kernel free of a tenant model is what keeps
 * Loom a generic execution kernel (P10). Extra fields are allowed; a
 * `delegation` (K12.4) rides here.
 */
export interface PrincipalChain {
  /** The tenant boundary — an opaque, pseudonymous id (never human PII; see K10). */
  tenant?: string;
  /** The acting identity. */
  actor?: string;
  /** The identity this action is performed on behalf of (delegation origin). */
  onBehalfOf?: string;
  /** K12.4 — a verifiable attenuated-delegation token, checked at the callee. */
  delegation?: DelegatedGrant;
  [key: string]: unknown;
}

export interface CapabilityRequest {
  toolId: string;
  executionId: string;
  workflowId: string;
  stepId: string;
  /** K12.1 — the authenticated principal chain, if one was established. */
  principal?: PrincipalChain;
}

export interface CapabilityDecision {
  allowed: boolean;
  reason?: string;
}

// The protection ring. Pure and synchronous so the check is deterministic and
// replay-safe (the same request always yields the same decision).
export interface CapabilityAuthorizer {
  authorize(req: CapabilityRequest): CapabilityDecision;
}

export class CapabilityDeniedError extends Error {
  readonly toolId: string;
  readonly reason: string;
  constructor(toolId: string, reason: string) {
    super(`Capability denied: effect "${toolId}" — ${reason}`);
    this.name = "CapabilityDeniedError";
    this.toolId = toolId;
    this.reason = reason;
  }
}

export interface GrantTableOptions {
  /**
   * Which field identifies the "principal" whose grants apply. Default: the
   * workflowId (a flow is the unit of authority). Return `executionId` for
   * per-execution grants, or read a grant-set id from the request.
   */
  principal?: (req: CapabilityRequest) => string;
}

/**
 * The least-privilege authorizer: a static table mapping a principal to the set of
 * effect ids it may invoke (`"*"` grants all). Anything not explicitly granted is
 * denied. Grants are declared at boot and cannot be mutated at runtime, so authority
 * is fixed and auditable.
 */
export class GrantTable implements CapabilityAuthorizer {
  private readonly grants: Map<string, Set<string>>;
  private readonly principalOf: (req: CapabilityRequest) => string;

  constructor(grants: Record<string, readonly string[]>, options: GrantTableOptions = {}) {
    this.grants = new Map(Object.entries(grants).map(([k, v]) => [k, new Set(v)]));
    this.principalOf = options.principal ?? ((req) => req.workflowId);
  }

  authorize(req: CapabilityRequest): CapabilityDecision {
    const principal = this.principalOf(req);
    const granted = this.grants.get(principal);
    if (granted === undefined) {
      return { allowed: false, reason: `principal "${principal}" has no grants` };
    }
    if (granted.has("*") || granted.has(req.toolId)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `effect "${req.toolId}" not granted to "${principal}"` };
  }

  /**
   * A read-only projection of the static grants — principal → granted effect ids,
   * or `"*"` when all effects are granted. For pre-flight tooling (e.g. `@loom/verify`)
   * that needs to inspect authority without a live {@link CapabilityRequest}.
   */
  view(): Record<string, readonly string[] | "*"> {
    const out: Record<string, readonly string[] | "*"> = {};
    for (const [principal, set] of this.grants) {
      out[principal] = set.has("*") ? "*" : [...set];
    }
    return out;
  }
}

export interface DelegationAuthorizerOptions {
  /** Shared secret used to verify delegation signatures at this trust boundary. */
  secret: string;
  /**
   * The callee's OWN authority — an effect is allowed only if it is in BOTH the
   * verified delegated set AND the callee's own grants (never ambient
   * escalation). Omit to allow the full verified delegated set (the callee
   * delegates all of its authority decisions upstream).
   */
  base?: CapabilityAuthorizer;
  /** Clock for token-expiry checks (epoch ms). Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * K12.4 — authorizes an effect against a VERIFIED attenuated delegation carried
 * in `req.principal.delegation`. The token's signature is checked first (a
 * forged or tampered delegation is denied outright), then the effect must be in
 * the **intersection** of the delegated grants and the callee's own authority
 * (`base`) — a delegate can never invoke an effect the delegator lacked, nor one
 * the callee itself lacks. No delegation present ⇒ falls through to `base`
 * (or denied when there is no base).
 */
export class DelegationAuthorizer implements CapabilityAuthorizer {
  constructor(private readonly options: DelegationAuthorizerOptions) {}

  authorize(req: CapabilityRequest): CapabilityDecision {
    const token = req.principal?.delegation;
    if (token === undefined) {
      return (
        this.options.base?.authorize(req) ?? {
          allowed: false,
          reason: "no delegation and no base authority",
        }
      );
    }
    if (!verifyDelegation(this.options.secret, token)) {
      return { allowed: false, reason: "delegation signature invalid (forged or tampered)" };
    }
    // Reject expired tokens (exp is signature-bound, so it can't be extended). A token
    // without exp never expires — the same as before this field existed.
    if (token.exp !== undefined && (this.options.now?.() ?? Date.now()) >= token.exp) {
      return { allowed: false, reason: `delegation expired at ${token.exp}` };
    }
    // K12.4 — bind the token to its intended holder. A delegation minted for
    // `issuedTo` may only be presented BY that principal (`req.principal.actor`).
    // The signature proves authenticity, not that the bearer is the intended
    // holder — without this check a captured/misrouted token is a confused deputy,
    // usable by whoever holds it.
    if (req.principal?.actor !== token.issuedTo) {
      return {
        allowed: false,
        reason: `delegation issued to "${token.issuedTo}" but presented by "${req.principal?.actor ?? "(none)"}"`,
      };
    }
    const delegated = new Set(token.grants);
    const inDelegated = delegated.has("*") || delegated.has(req.toolId);
    if (!inDelegated) {
      return { allowed: false, reason: `effect "${req.toolId}" not in the delegated grant set` };
    }
    // Intersection: the callee must ALSO hold the authority (no ambient escalation).
    if (this.options.base !== undefined) {
      const baseDecision = this.options.base.authorize(req);
      if (!baseDecision.allowed) {
        return {
          allowed: false,
          reason: `delegated, but the callee itself lacks "${req.toolId}": ${baseDecision.reason ?? ""}`,
        };
      }
    }
    return { allowed: true };
  }
}

// ── K12.4 — verifiable attenuated delegation (macaroon-lite) ─────────────────
//
// The evaluation's amendment: "an attenuated grant set carried as a plain
// request field is forgeable by any caller or middlebox." So a delegation is
// SIGNED (HMAC) by the delegator and VERIFIED at the callee's trust boundary
// before its grants are honored. Attenuation can only NARROW: a holder derives
// a more-restricted token, never a broader one, because the delegated grant set
// is bound into the signature. The intersection is computed from the VERIFIED
// set, never a forgeable field.

import { createHmac, timingSafeEqual } from "node:crypto";

/** A signed delegation: the grant subset a delegator conferred, HMAC-bound. */
export interface DelegatedGrant {
  /** The delegated capability ids (effect ids the callee may invoke on the caller's behalf). */
  grants: string[];
  /** The principal this token was issued to (bound into the signature). */
  issuedTo: string;
  /** Optional absolute expiry (epoch ms), bound into the signature; rejected once past. */
  exp?: number;
  /** HMAC-SHA256 over `${issuedTo}\n${sorted grants}[\nexp=…]` with the shared delegation secret. */
  sig: string;
}

// `exp` is appended only when present, so tokens without it sign the exact prior payload
// (backward-compatible), while a tampered `exp` breaks the signature.
function delegationPayload(issuedTo: string, grants: readonly string[], exp?: number): string {
  const base = `${issuedTo}\n${[...grants].sort().join(",")}`;
  return exp !== undefined ? `${base}\nexp=${exp}` : base;
}

/** Mint a delegation token: the delegator signs the subset it confers on `issuedTo`. */
export function signDelegation(
  secret: string,
  issuedTo: string,
  grants: string[],
  exp?: number
): DelegatedGrant {
  const sig = createHmac("sha256", secret)
    .update(delegationPayload(issuedTo, grants, exp))
    .digest("hex");
  return { grants: [...grants], issuedTo, ...(exp !== undefined && { exp }), sig };
}

/** Verify a delegation's signature (constant-time). A forged/tampered token fails. */
export function verifyDelegation(secret: string, token: DelegatedGrant): boolean {
  const expected = createHmac("sha256", secret)
    .update(delegationPayload(token.issuedTo, token.grants, token.exp))
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token.sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Attenuate a delegation to a narrower subset, re-signed for a new holder — only
 * capabilities already in the token survive, and the parent's expiry is inherited.
 * Requires the shared secret (the delegator/mint authority performs it); a
 * pure-holder chained-HMAC variant is a future option.
 *
 * "Never broadening" is enforced on BOTH axes:
 *
 *  - **Grants.** A capability absent from the parent cannot appear in the child. A parent
 *    holding `"*"` may attenuate to any concrete subset (that is narrowing) — previously
 *    such a subset was filtered against the literal `["*"]` array and came back EMPTY, so a
 *    wildcard delegator could not attenuate at all.
 *  - **Expiry.** The parent's `exp` is inherited, and `exp` may only be brought EARLIER.
 *    This was the important one: `exp` used not to be propagated, so attenuating a token
 *    that expired in an hour produced a child that **never expired** — narrowing the grant
 *    set while silently making the token immortal.
 *
 * Throws on an unverifiable parent. The signature is what makes the grant set trustworthy,
 * and this function holds the secret — so attenuating an unchecked token would launder a
 * forged one into a validly signed child. The old contract merely *documented* that the
 * caller must pass a verified token; a security primitive should not depend on that.
 */
export function attenuateDelegation(
  secret: string,
  token: DelegatedGrant,
  issuedTo: string,
  subset: string[],
  exp?: number
): DelegatedGrant {
  if (!verifyDelegation(secret, token)) {
    throw new Error(
      "attenuateDelegation: parent delegation failed verification — refusing to sign a child from an unverified token"
    );
  }
  const parentIsWildcard = token.grants.includes("*");
  const narrowed = parentIsWildcard ? [...subset] : subset.filter((g) => token.grants.includes(g));
  // Inherit the parent's expiry; an explicit `exp` may only tighten it.
  const inherited = token.exp;
  const nextExp =
    inherited === undefined ? exp : exp === undefined ? inherited : Math.min(inherited, exp);
  return signDelegation(secret, issuedTo, narrowed, nextExp);
}

import type { Scheduler } from "@loom/scheduler";
import type { Warmer } from "./types";

export interface EffectRuntimeOptions {
  /** When set, every effect is authorized against it; ungranted effects are denied (K2). */
  authorizer?: CapabilityAuthorizer;
  /**
   * When set, effects run through this scheduler (M6) — bounded concurrency + priority
   * ordering across all of a runtime's effects (admission control). Omit for the
   * zero-overhead direct path.
   */
  scheduler?: Scheduler;
  /** Advisory pre-warm hook, invoked off-log before each effect (M6). */
  warmer?: Warmer;
}
