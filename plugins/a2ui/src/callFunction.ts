// ── Grain B — callFunction as a delegated Loom effect ───────────────────────────
//
// Register an `a2ui.callFunction` effect so a flow can invoke a client-side
// function with a synchronous-looking `await ctx.execute(callFn, input)` and
// have the client's answer recorded as the step's `STEP_COMPLETED` output. This
// is the `A2APeerClient.registerInto` pattern (a remote actor exposed as a Loom
// tool) applied to a UI client — see ADR 0070.
//
// Determinism/delivery: the request's `callId` is `ctx.idempotencyKey`
// (`executionId:stepId`), so a crash-recovered re-issue reuses it and the client
// can dedup. The effect is declared `idempotent: false`, so if a crash leaves an
// attempt in an unknown state the kernel parks the execution at EFFECT_INDOUBT
// for an operator verdict instead of blindly re-invoking the client function —
// the exact "did the client function actually run?" resolution.
//
// At-least-once (K9.1): effects are at-least-once, steps are exactly-once only
// w.r.t. the log. A configured retry-middleware — or crash recovery — may invoke
// `transport.call` more than once within a logical attempt, always with the SAME
// `callId`. So a genuinely side-effecting client function (submit/charge/write)
// MUST dedup on `callId` on the client side; the deterministic key is what makes
// that possible. A pure read needs no dedup.
//
// The plugin stays transport-agnostic: the caller injects the
// `A2UICallFunctionTransport` that actually carries the request to the client
// and correlates the `functionResponse` back by `callId` (a WebSocket, an SSE +
// POST pair, an in-process bus in tests — the plugin does not care).

import type { Effect, EffectContext, EffectRuntime } from "@loom/effect-runtime";
import type { CallFunctionPayload, FunctionResponsePayload } from "./messages";

/** The default effect id under which the client-callFunction effect registers. */
export const A2UI_CALL_FUNCTION_TOOL_ID = "a2ui.callFunction";

/** Input a flow passes to the `a2ui.callFunction` effect via `ctx.execute`. */
export interface A2UICallFunctionInput {
  /** The A2UI surface to route the request to (the bridge's `surfaceId`). */
  surfaceId: string;
  /** The catalog function name to invoke on the client. */
  name: string;
  /** Arguments passed to the client function. */
  args?: unknown;
  /** Catalog `callableFrom` boundary, if scoped. */
  callableFrom?: string;
}

/**
 * The transport boundary. An implementation sends the `callFunction` request to
 * the client and resolves with the matching `functionResponse` (correlated by
 * `request.callId`). It should forward `signal` so a cancelled execution aborts
 * the in-flight call, and reject on transport failure/timeout. It does NOT
 * interpret the `error` leg — that is mapped to a thrown effect error here.
 */
export interface A2UICallFunctionTransport {
  call(request: CallFunctionPayload, signal?: AbortSignal): Promise<FunctionResponsePayload>;
}

/**
 * Register the `a2ui.callFunction` effect on an `EffectRuntime`, backed by an
 * injected transport. Returns the tool id it registered under (so a flow/tool
 * definition can reference it). Mirrors `A2APeerClient.registerInto`.
 *
 * Hardening:
 * - The response is **correlation-checked** — a reply whose `callId`/`surfaceId`
 *   doesn't match the request is rejected, so a mis-wiring transport can't feed
 *   one step another step's result.
 * - `requestTimeoutMs` **bounds the wait**: the call is raced against a timeout
 *   (and `ctx.signal` is aborted), so a transport that never resolves fails the
 *   step instead of pinning the effect for the execution's lifetime. Omit for the
 *   unbounded default.
 *
 * The client's `result` is still external, untrusted input — validate it against
 * the catalog's declared `returns` schema before acting on anything sensitive.
 */
export function registerA2UICallFunction(
  effectRuntime: EffectRuntime,
  transport: A2UICallFunctionTransport,
  opts: { toolId?: string; requestTimeoutMs?: number } = {}
): string {
  const toolId = opts.toolId ?? A2UI_CALL_FUNCTION_TOOL_ID;

  const effect: Effect<A2UICallFunctionInput, unknown> = {
    kind: "a2a",
    // K9.3 — a client function is a mutating external call in the general case;
    // refuse silent re-run on recovery and park at EFFECT_INDOUBT instead.
    idempotent: false,
    async execute(input: A2UICallFunctionInput, ctx: EffectContext): Promise<unknown> {
      // Deterministic callId = the K9 idempotency key (`executionId:stepId`).
      // Fall back to the same derivation if a hand-built context omits it.
      const callId = ctx.idempotencyKey ?? `${ctx.executionId}:${ctx.stepId}`;
      const request: CallFunctionPayload = {
        surfaceId: input.surfaceId,
        callId,
        name: input.name,
        ...(input.args !== undefined && { args: input.args }),
        ...(input.callableFrom !== undefined && { callableFrom: input.callableFrom }),
      };

      const response = await callWithTimeout(transport, request, ctx.signal, opts.requestTimeoutMs);
      // Defense-in-depth: adopt only a reply that correlates to THIS request.
      if (response.callId !== callId || response.surfaceId !== request.surfaceId) {
        throw new Error(
          `a2ui callFunction "${input.name}" response mis-correlated (expected callId=${callId})`
        );
      }
      if (response.error !== undefined) {
        throw new Error(
          `a2ui callFunction "${input.name}" failed: ${describeError(response.error)}`
        );
      }
      return response.result;
    },
  };

  effectRuntime.register(toolId, effect);
  return toolId;
}

// Await `transport.call`, bounded by `timeoutMs` when set. Races the call against
// a rejecting timer AND aborts a linked signal (best-effort cooperative cancel),
// so even a transport that ignores the signal cannot pin the effect forever.
function callWithTimeout(
  transport: A2UICallFunctionTransport,
  request: CallFunctionPayload,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): Promise<FunctionResponsePayload> {
  if (timeoutMs === undefined) return transport.call(request, parentSignal);

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`a2ui callFunction "${request.name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([transport.call(request, controller.signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  });
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
