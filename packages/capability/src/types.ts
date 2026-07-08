import type { RegisteredFlow } from "@loom/workflow-runtime";
import type { ZodSchema } from "zod";

// A capability is the proposal's unit of application composition: a runnable
// flow wrapped with intent-facing metadata so it can be exposed uniformly as an
// API, a UI action, an A2A endpoint, or a workflow node. Examples:
// "investigate-incident", "scale-cluster", "issue-refund".
export interface CapabilityDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "CapabilityDefinition";
  id: string;
  name: string;
  // Natural-language description of the goal this capability fulfils. Used by
  // the Intent and Planner runtimes to match user intent to a capability.
  intent: string;
  tags: string[];
  inputSchema: ZodSchema<TIn>;
  flow: RegisteredFlow<TIn, TOut>;
  /** Semver of this capability (M7). Advisory metadata for discovery/compat. */
  version?: string;
  /** Ids of capabilities this one depends on (M7); resolved by CapabilityCatalog. */
  dependencies?: string[];
}

// ── Capability invoke authorization (M7) ─────────────────────────────────────
//
// Distinct from the K2 *effect* protection ring: this governs who may INVOKE a
// capability (an intent-addressable flow). Optional and additive — no authorizer ⇒
// every invoke is allowed (unchanged).
export interface CapabilityInvokeRequest {
  capabilityId: string;
  principal?: string;
  input?: unknown;
}

export interface CapabilityInvokeDecision {
  allowed: boolean;
  reason?: string;
}

export interface CapabilityInvokeAuthorizer {
  authorize(req: CapabilityInvokeRequest): CapabilityInvokeDecision;
}

export class CapabilityInvokeDeniedError extends Error {
  readonly capabilityId: string;
  readonly reason: string;
  constructor(capabilityId: string, reason: string) {
    super(`Capability invoke denied: "${capabilityId}" — ${reason}`);
    this.name = "CapabilityInvokeDeniedError";
    this.capabilityId = capabilityId;
    this.reason = reason;
  }
}
