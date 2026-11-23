import {
  type CapabilityAuthorizer,
  type CapabilityDecision,
  type CapabilityRequest,
  capabilityIds,
  principalBlocked,
} from "@loomwork/effect-runtime";
import { type TaskGrant, validateGrantShape, verifyTaskGrant } from "./grant";

/** Stable machine prefixes of a denial reason, one per cause (a later task classifies `expired` as renewable). */
export const TASK_GRANT_DENIAL = {
  blocked: "task-grant:blocked",
  shape: "task-grant:shape",
  signature: "task-grant:signature",
  expired: "task-grant:expired",
  holder: "task-grant:holder",
  scope: "task-grant:scope",
  base: "task-grant:base",
  error: "task-grant:error",
} as const;

export interface TaskGrantAuthorizerOptions {
  /** Shared secret that verifies grants. SYMMETRIC: a verifier can also mint, which is why `base` is required. */
  secret: string;
  /**
   * The callee's OWN authority, REQUIRED and load-bearing: the secret is symmetric, so a callee can sign
   * itself a grant for any effect. Only the intersection with `base` bounds it (same reasoning as
   * `DelegationAuthorizer`, ADR 0024). A grant narrows what `base` allows; it never widens it.
   */
  base: CapabilityAuthorizer;
  /** Clock (epoch ms) for expiry; injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const MAX_LIVE = 256;
/** Bound a live (caller- or base-supplied) value before it lands in a durable denial reason. */
function clip(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : String(v);
    return s.length > MAX_LIVE ? `${s.slice(0, MAX_LIVE)}…` : s;
  } catch {
    return "(unprintable)";
  }
}

const deny = (prefix: string, detail: string): CapabilityDecision => ({
  allowed: false,
  reason: `${prefix}: ${detail}`,
});

/**
 * ADR 0150 D2 — authorizes an effect against the signed task grant in `req.principal.taskGrant`.
 * Order: blocked principal, no grant (`base` decides), shape, signature, expiry, holder, scope, `base`.
 * A grant that is present but malformed is a denial, never a fall-through to `base`. Pure, synchronous,
 * and never throws.
 */
export class TaskGrantAuthorizer implements CapabilityAuthorizer {
  private readonly secret: string;
  private readonly base: CapabilityAuthorizer;
  private readonly now: () => number;

  constructor(options: TaskGrantAuthorizerOptions) {
    if (options.base === undefined || options.base === null) {
      throw new Error(
        "TaskGrantAuthorizer: `base` is required — the grant secret is symmetric, so a verified grant " +
          "cannot bound a callee's authority on its own (see ADR 0024, ADR 0150 D2)."
      );
    }
    if (typeof options.secret !== "string" || options.secret.length === 0) {
      throw new Error("TaskGrantAuthorizer: `secret` must be a non-empty string.");
    }
    // Copy: a later mutation of the caller's options object must not swap the secret or `base`.
    this.secret = options.secret;
    this.base = options.base;
    this.now = options.now ?? Date.now;
  }

  authorize(req: CapabilityRequest): CapabilityDecision {
    try {
      return this.decide(req);
    } catch {
      // Fixed detail: never the error message (unbounded, possibly caller-influenced, and durable).
      return deny(TASK_GRANT_DENIAL.error, "authorization failed internally");
    }
  }

  /** The verified snapshot, `"shape"` when malformed, `undefined` when the signature fails. */
  private verified(raw: unknown): TaskGrant | "shape" | undefined {
    const snap = verifyTaskGrant(this.secret, raw as TaskGrant);
    if (snap !== undefined) return snap;
    // Verification failed: tell a malformed grant from a bad signature. `validateGrantShape`
    // takes the UNSIGNED shape, so drop `sig`. Only the label depends on this; never the decision.
    try {
      const { sig: _sig, ...unsigned } = structuredClone(raw) as TaskGrant;
      validateGrantShape(unsigned);
    } catch {
      return "shape";
    }
    return undefined;
  }

  private decide(req: CapabilityRequest): CapabilityDecision {
    const blocked = principalBlocked(req.principal);
    if (blocked !== undefined) return deny(TASK_GRANT_DENIAL.blocked, clip(blocked));
    const raw = req.principal?.taskGrant;
    if (raw === undefined) return this.base.authorize(req);

    // The DECISION comes from the verified
    // snapshot alone: after this step nothing reads `req.principal.taskGrant` again, so a getter or
    // proxy cannot show the verifier one value and the scope check another (ADR 0150 R4).
    const g = this.verified(raw);
    if (g === "shape") return deny(TASK_GRANT_DENIAL.shape, "malformed grant");
    if (g === undefined) {
      return deny(TASK_GRANT_DENIAL.signature, "grant signature invalid (forged or tampered)");
    }
    const t = this.now();
    // A NaN or non-numeric clock must not skip expiry: only a finite time below `exp` passes.
    if (!(typeof t === "number" && Number.isFinite(t) && t < g.exp)) {
      return deny(
        TASK_GRANT_DENIAL.expired,
        `grant for task "${g.taskId}" epoch ${g.epoch} expired at ${g.exp}`
      );
    }
    // Read the actor ONCE: the holder check and everything after it see the same value.
    const actor = req.principal?.actor;
    if (actor !== g.issuedTo) {
      return deny(
        TASK_GRANT_DENIAL.holder,
        `grant issued to "${g.issuedTo}" but presented by "${actor === undefined ? "(none)" : clip(actor)}"`
      );
    }
    const scope = new Set(g.effects);
    if (!capabilityIds(req).some((id) => scope.has(id))) {
      return deny(
        TASK_GRANT_DENIAL.scope,
        `effect "${req.resource === undefined ? req.toolId : `${req.toolId}:${req.resource}`}" not in the task grant`
      );
    }
    // Hand `base` the pinned actor, so it cannot be shown a different one than the holder check saw.
    const pinned: CapabilityRequest = { ...req, principal: { ...req.principal, actor } };
    const b = this.base.authorize(pinned);
    if (b?.allowed !== true) {
      return deny(
        TASK_GRANT_DENIAL.base,
        `granted, but the callee itself lacks "${clip(req.toolId)}": ${clip(b?.reason ?? "")}`
      );
    }
    return { allowed: true };
  }
}
