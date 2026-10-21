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
  // AgentRunner refused an idempotent:false tool (K9.3): a configuration error, not tool feedback
  "IdempotentToolRefusedError",
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
  // a lifecycle op could not read the execution's sequence 0 (a store fault): infrastructure, retry is the caller's, not the model's
  "ExecutionStoreUnavailableError",
  // a deployment mismatch (this node cannot write per-topic inbox streams after the fleet switch): no retry helps
  "InboxTopicStreamsRequiredError",
  // a sealed inbox payload this node cannot open: retrying on the same node cannot help (ADR 0130)
  "SealedPayloadUnreadableError",
  // a waited inbox topic is HELD (quarantined) and this node will not lift it: retrying here cannot help (ADR 0130 residuals D9)
  "QuarantineHeldError",
  // a stream this node cannot open (a seal marker it cannot open, a key it does not hold), refused
  // DENIAL-SHAPED (it is an ExecutionDeniedError to the caller); and the store error behind the key
  // case. No retry on this node helps (ADR 0130 residuals D7)
  "SealedStreamUnreadableError",
  "KeyUnavailableError",
  // shards disagree about sealing: a misconfiguration, no retry helps (ADR 0130 residuals D7/D8)
  "ShardSealingMismatchError",
  // a checkpoint into a snapshot store that does not seal the whole state while the event store seals:
  // a configuration error, retrying cannot help (ADR 0130 D8)
  "PlaintextCheckpointError",
  // heartbeat lease lost (taken over / past its self-fencing deadline / keeper closed): this driver
  // must stop; and the node's lease store is in its quiet period: no tool-level retry helps (ADR 0130 D11)
  "LeaseLostError",
  "LeaseHeldError",
  "LeaseStoreQuietError",
  "LeaseStoreTimeoutError",
  "StartLeaseHeldError",
  // a lease-store read failed while judging abandonment: the re-drive did NOT happen (fail closed, ADR 0130 D11 S7d)
  "LeaseEvidenceError",
  // the environment cannot host the runtime's scopes (no AsyncLocalStorage): no retry helps
  "AsyncContextUnavailableError",
  // fencing / supersession: this execution no longer owns its log; a leaked egress or spawn bound
  "StaleFenceError",
  "ExecutionSupersededError",
  "DuplicateEnvelopeIdError",
  "DuplicateSequenceError",
  "EgressDeniedError",
  "SpawnLimitExceededError",
  // a provider reported an error inside a 200 stream (overloaded, server error): transient
  // infrastructure, left to the step retry policy, not the model
  "LlmStreamError",
  // a provider response over the configured size cap: a misbehaving endpoint, not the model's to fix
  "LlmResponseLimitError",
  // a 2xx whose body is not JSON: the same misbehaving endpoint
  "LlmResponseInvalidError",
]);

const MAX_CAUSE_DEPTH = 5;

/** The brand `@loom/workflow-runtime` puts on both sealed refusals (`isSealedUnreadable`). */
const SEALED_UNREADABLE = Symbol.for("loom.sealedUnreadable");

/**
 * `LlmHttpError` (`@loom/llm`) is classified by STATUS, matched by name and a numeric `status` so
 * this file needs no import. TERMINAL: 3xx (a redirect, never followed: the base URL is wrong or intercepted; not retryable), 401/403 (configuration), 429 (rate limit: the same stop as
 * `RateLimitExceededError`) and 5xx/529 (transient: the step retry policy's to handle, not the
 * model's). FEEDBACK: every other status (400/404/408/409/413/422 ...): a request the model can
 * adapt. A bare instance with no status is feedback.
 */
function isTerminalLlmHttp(err: object): boolean {
  if ((err as { name?: unknown }).name !== "LlmHttpError") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number") return false;
  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    (status >= 300 && status <= 399) ||
    (status >= 500 && status <= 599)
  );
}

/**
 * A provider failure, matched like the rest of this file (by name, so a second copy of `@loom/llm`
 * or an adapter's own class of that name counts): `LlmHttpError` with a numeric `status` (any
 * status), `LlmResponseLimitError`, `LlmResponseInvalidError`, `LlmStreamError` by its name or any constructor name on its prototype chain.
 */
function isProviderOne(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const o = err as { name?: unknown; status?: unknown };
  if (o.name === "LlmHttpError") return typeof o.status === "number";
  if (
    o.name === "LlmStreamError" ||
    o.name === "LlmResponseLimitError" ||
    o.name === "LlmResponseInvalidError"
  )
    return true;
  for (let p = Object.getPrototypeOf(err); p !== null; p = Object.getPrototypeOf(p)) {
    const n = (p as { constructor?: { name?: string } }).constructor?.name;
    if (n === "LlmStreamError" || n === "LlmResponseLimitError" || n === "LlmResponseInvalidError")
      return true;
  }
  return false;
}

function isTerminalOne(err: unknown): boolean {
  // ADR 0130 residuals D7 - checked BEFORE any generic ExecutionDeniedError handling: a sealed
  // refusal is an ExecutionDeniedError to its caller, but it is a node-level fact, never feedback.
  if (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[SEALED_UNREADABLE] === true
  ) {
    return true;
  }
  if (
    err instanceof SuspendError ||
    err instanceof CapabilityDeniedError ||
    err instanceof EffectModeViolationError
  ) {
    return true;
  }
  if (typeof err !== "object" || err === null) return false;
  if (isTerminalLlmHttp(err)) return true;
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

/**
 * How the conversation's OWN model call classifies a failure (not a tool loop's; `isTerminalToolError`
 * stays the tool-loop rule). Walks the same bounded `cause` chain.
 *  - "terminal": some level is a terminal error that is NOT a provider failure (a park, a denial, a
 *    cancel, a divergence ...): it reaches the runtime, and wins over a provider error anywhere in the chain;
 *  - "provider": otherwise, some level is a provider failure (`LlmHttpError` of any status,
 *    `LlmStreamError`, `LlmResponseLimitError`, `LlmResponseInvalidError`): the turn fails with the fixed model-error reason;
 *  - "other": anything else (also a failed turn, as before).
 */
export function classifyModelCallError(err: unknown): "terminal" | "provider" | "other" {
  let provider = false;
  let e: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (isProviderOne(e)) provider = true;
    else if (isTerminalOne(e)) return "terminal";
    if (typeof e !== "object" || e === null) break;
    e = (e as { cause?: unknown }).cause;
    if (e === undefined) break;
  }
  return provider ? "provider" : "other";
}
