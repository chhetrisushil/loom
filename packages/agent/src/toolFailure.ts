import { SuspendError } from "@loom/core";
import { CapabilityDeniedError, EffectModeViolationError } from "@loom/effect-runtime";

/**
 * Error classes that are NOT a tool's own failure and must reach the runtime untouched, matched by
 * name along the whole prototype chain (so `KillSwitchEngagedError`, which sets its own `name`, is
 * caught through its `SafetyViolationError` parent and also listed itself).
 *
 * This is a DENYLIST on purpose: a failing tool is feedback by default, and a class that is not
 * listed is fed back. The fitness test (`toolFailure.test.ts`) enumerates every exported error class
 * of the 1P packages a tool can surface one from and pins its classification, so a NEW class fails
 * that test until someone decides which side it is on.
 */
export const TERMINAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  // a park, and the kernel's control flow (several are not exported as values)
  "SuspendError",
  "ScopeAbortedError",
  "ScopeServedError",
  "ContinueAsNewSignal",
  "ContinueAsNewRefusedError",
  "ContinueAsNewUnavailableError",
  // authority: fed back, the model reads "not allowed" and probes a neighbouring tool
  "CapabilityDeniedError",
  "CapabilityInvokeDeniedError",
  "EffectModeViolationError",
  "ExecutionDeniedError",
  "ApprovalRejectedError",
  // safety and budget: not something the model can fix; fed back it spins to maxIterations
  "SafetyViolationError",
  "KillSwitchEngagedError",
  "QuotaExceededError",
  "RateLimitExceededError",
  // the run is being stopped, or no longer matches its log
  "ExecutionCancelledError",
  "DecideScopeClosedError",
  "ParallelScopeFailedError",
  "FlowDivergenceError",
  "FlowReplayDivergenceError",
  "FlowCodeMismatchError",
  "StartFencedOutError",
  "PrincipalUnrestorableError",
  "StorageWriteError",
  // the environment cannot host the runtime's scopes (no AsyncLocalStorage): no retry helps
  "AsyncContextUnavailableError",
  // fencing / supersession: this execution no longer owns its log; a leaked egress or spawn bound
  "StaleFenceError",
  "ExecutionSupersededError",
  "DuplicateEnvelopeIdError",
  "DuplicateSequenceError",
  "EgressDeniedError",
  "SpawnLimitExceededError",
]);

const MAX_CAUSE_DEPTH = 5;

function isTerminalOne(err: unknown): boolean {
  if (
    err instanceof SuspendError ||
    err instanceof CapabilityDeniedError ||
    err instanceof EffectModeViolationError
  ) {
    return true;
  }
  if (typeof err !== "object" || err === null) return false;
  // A class that declares itself non-retryable is a decision, not a fault (the middleware's own rule).
  if ((err as { retryable?: unknown }).retryable === false) return true;
  if (TERMINAL_ERROR_NAMES.has((err as { name?: string }).name ?? "")) return true;
  for (let p = Object.getPrototypeOf(err); p !== null; p = Object.getPrototypeOf(p)) {
    const ctor = (p as { constructor?: { name?: string } }).constructor;
    if (ctor?.name !== undefined && TERMINAL_ERROR_NAMES.has(ctor.name)) return true;
  }
  return false;
}

/**
 * R10 — may a tool's failure be handed back to the model as an `isError` result, or must it reach
 * the runtime?
 *
 * A failing tool is FEEDBACK by default: a timing-out API or a malformed argument is information the
 * model can act on. These are not tool failures: a park, an authority error, a safety or budget stop
 * (kill switch, quota, rate limit, anything declaring `retryable === false`), a cancellation, a
 * divergence, a continuation. The `cause` chain is walked (bounded), so a wrapper that re-throws
 * `new Error("tool failed", { cause: denial })` is still the denial.
 *
 * FOR THIRD-PARTY TOOLS: a tool whose failure means "stop, do not let the model retry" (a policy
 * refusal, an exhausted budget of your own) declares it by setting `retryable = false` on the error it
 * throws; that is the only hook, and it needs no import. The `cause` chain is walked to depth 5: an
 * authority error wrapped more than five layers deep is treated as an ordinary failure.
 */
export function isTerminalToolError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (isTerminalOne(e)) return true;
    if (typeof e !== "object" || e === null) return false;
    e = (e as { cause?: unknown }).cause;
    if (e === undefined) return false;
  }
  return false;
}
