import { flowHashMatches } from "@loom/core";
import type { ExecutionState, FlowDefinition } from "@loom/core";
import type { VersionPin } from "./types";

// ── IX-5 — version-pinned reconstruction ──────────────────────────────────────
//
// Replaying an old execution against current code produces a plausible-looking wrong
// answer, which is worse than an error. Under version skew — the normal condition for
// long-lived executions — that is the difference between a trustworthy tool and a
// misleading one.
//
// The pin is read from the FOLD, not from a second store round-trip: `EXECUTION_STARTED`
// folds `payload.flowHash` into the reserved key `variables._flowHash`
// (`@loom/replay-vm` eventHandlers.ts:72-93). Any reconstruction the inspector has
// already performed therefore carries its own pin, at zero additional read cost.
//
// The reserved key is read with `Object.hasOwn` and a typeof guard rather than a bare
// property access: `variables` is arbitrary folded data, so an inherited or
// wrongly-typed `_flowHash` must not be mistaken for a pin.

const FLOW_HASH_KEY = "_flowHash";

/**
 * The pin a reconstructed state carries. Total — every execution resolves to exactly
 * one of the two statuses, and neither is an error condition.
 *
 * `unpinned-legacy` is the third case the original requirement missed:
 * `EXECUTION_STARTED.flowHash` is optional, additive at EVENT_SCHEMA 1.4.0, and folds
 * treat its absence as legacy. Such an execution has no pin to display. Reporting that
 * as a blank, or inferring the current version, is precisely the silent fallback this
 * requirement exists to prevent.
 */
export function pinOf(state: ExecutionState): VersionPin {
  const vars = state.variables as Record<string, unknown>;
  const raw = Object.hasOwn(vars, FLOW_HASH_KEY) ? vars[FLOW_HASH_KEY] : undefined;
  const flowHash = typeof raw === "string" && raw.length > 0 ? raw : undefined;

  if (flowHash === undefined) {
    return {
      status: "unpinned-legacy",
      workflowId: state.workflowId,
      workflowVersion: state.workflowVersion,
    };
  }
  return {
    status: "pinned",
    workflowId: state.workflowId,
    workflowVersion: state.workflowVersion,
    flowHash,
  };
}

/**
 * Operator-facing rendering of a pin. Never renders an empty or inferred version as if
 * it were real: an unrecorded `workflowVersion` reads `version unrecorded`, and a
 * legacy execution reads `unpinned (legacy)`.
 */
export function describePin(pin: VersionPin): string {
  const version = pin.workflowVersion.length > 0 ? pin.workflowVersion : "version unrecorded";
  return pin.status === "pinned"
    ? `${pin.workflowId}@${version} [flowHash ${pin.flowHash}]`
    : `${pin.workflowId}@${version} [unpinned (legacy)]`;
}

/**
 * Whether a set of artifacts available to the inspector can serve this pin.
 *
 * Returns `false` for a pinned execution whose hash is not among `availableFlowHashes`.
 * Callers MUST treat that as "cannot reconstruct" and say so — never fall back to the
 * current version. An `unpinned-legacy` execution returns `true`: there is no pin to
 * violate, and refusing it would make every pre-1.4.0 log uninspectable.
 *
 * @deprecated A raw string lookup cannot know that a legacy `fnv1a:` pin and a `sha256:` hash name the
 * same structure (ADR 0113 D1). Use {@link canServePinFrom}, which compares through `flowHashMatches`.
 */
export function canServePin(pin: VersionPin, availableFlowHashes: ReadonlySet<string>): boolean {
  if (pin.status === "unpinned-legacy") return true;
  return pin.flowHash !== undefined && availableFlowHashes.has(pin.flowHash);
}

/**
 * ADR 0113 D1 — {@link canServePin} over DEFINITIONS rather than a set of hash strings. A pin
 * recorded as the legacy 32-bit `fnv1a:` form and a definition whose current hash is `sha256:` are
 * the same structure, and a raw string lookup cannot know that; this recomputes the comparison
 * with `flowHashMatches`, which accepts either generation. Same rule otherwise: a pinned execution
 * no available definition matches cannot be reconstructed, and the caller must say so.
 */
export function canServePinFrom(
  pin: VersionPin,
  definitions: Iterable<FlowDefinition<never, never> | FlowDefinition>
): boolean {
  if (pin.status === "unpinned-legacy") return true;
  if (pin.flowHash === undefined) return false;
  for (const def of definitions) {
    if (flowHashMatches(pin.flowHash, def as FlowDefinition)) return true;
  }
  return false;
}
