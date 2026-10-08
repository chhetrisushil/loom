import { SuspendError } from "@loom/core";
import { CapabilityDeniedError, EffectModeViolationError } from "@loom/effect-runtime";
import {
  DecideScopeClosedError,
  ExecutionCancelledError,
  FlowDivergenceError,
} from "@loom/workflow-runtime";

/**
 * Error classes matched by `name`, which each sets explicitly: the kernel's control flow of a
 * `parallel` scope or a continuation (not exported as values), and the middleware's safety / budget
 * stops (`@loom/middleware` is a dev-only dependency here; `KillSwitchEngagedError` inherits the
 * `SafetyViolationError` name). None is a tool's own failure; all must reach the runtime untouched.
 */
const KERNEL_CONTROL_NAMES: ReadonlySet<string> = new Set([
  "ScopeAbortedError",
  "ScopeServedError",
  "ContinueAsNewSignal",
  "SafetyViolationError",
  "QuotaExceededError",
]);

/**
 * R10 — may a tool's failure be handed back to the model as an `isError` result, or must it
 * reach the runtime?
 *
 * A failing tool is FEEDBACK by default: a timing-out API or a malformed argument is information
 * the model can act on. Five things are not tool failures and must never be swallowed:
 *
 * - **a park** (`SuspendError`: a `human` effect, an in-doubt verdict) — swallowing it loses the
 *   suspension;
 * - **an authority error** (`CapabilityDeniedError`, `EffectModeViolationError`, R4) — fed back,
 *   the model reads "not authorized" and probes a neighbouring tool;
 * - **a safety / budget stop** (`SafetyViolationError` incl. the kill switch, `QuotaExceededError`)
 *   — not something the model can fix, and feeding it back lets it spin to `maxIterations`;
 * - **a cancellation** (`ExecutionCancelledError`, a parallel scope's abort, a closed decide
 *   scope) — the run is being stopped;
 * - **a divergence** (`FlowDivergenceError`) — a body that no longer matches its log.
 */
export function isTerminalToolError(err: unknown): boolean {
  if (
    err instanceof SuspendError ||
    err instanceof CapabilityDeniedError ||
    err instanceof EffectModeViolationError ||
    err instanceof ExecutionCancelledError ||
    err instanceof DecideScopeClosedError ||
    err instanceof FlowDivergenceError
  ) {
    return true;
  }
  return err instanceof Error && KERNEL_CONTROL_NAMES.has(err.name);
}
