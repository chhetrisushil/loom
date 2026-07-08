// ── Capability protection (Loom 2.0 K2) — the kernel's authority ring ─────────
//
// Every side effect flows through EffectRuntime.execute, so that is the one boundary
// a library CAN enforce (unlike hardware memory protection). A CapabilityAuthorizer
// decides, per invocation, whether the calling execution holds the authority to run
// the effect. Grants are unforgeable: an execution cannot grant itself a capability —
// grants live only in the authorizer, wired statically at boot (P5). A denied effect
// never runs; the denial is emitted as a durable EFFECT_DENIED fact (P9) and fails
// the step. Enforcement is opt-in: no authorizer ⇒ today's permissive behaviour.

export interface CapabilityRequest {
  toolId: string;
  executionId: string;
  workflowId: string;
  stepId: string;
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
}

export interface EffectRuntimeOptions {
  /** When set, every effect is authorized against it; ungranted effects are denied. */
  authorizer?: CapabilityAuthorizer;
}
