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
 */
export function registerA2UICallFunction(
  effectRuntime: EffectRuntime,
  transport: A2UICallFunctionTransport,
  opts: { toolId?: string } = {}
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

      const response = await transport.call(request, ctx.signal);
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

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
