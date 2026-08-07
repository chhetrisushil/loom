import type { ExecutionState } from "@loom/core";
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
 */
export function canServePin(pin: VersionPin, availableFlowHashes: ReadonlySet<string>): boolean {
  if (pin.status === "unpinned-legacy") return true;
  return pin.flowHash !== undefined && availableFlowHashes.has(pin.flowHash);
}
