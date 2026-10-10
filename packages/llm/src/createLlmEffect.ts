import { tainted, unwrapTainted } from "@loom/classify";
import { LlmEffect } from "@loom/effect-runtime";
import type { EffectContext, EffectDelta } from "@loom/effect-runtime";
import { collectStream } from "./assembleStream";
import type { StreamProgress } from "./assembleStream";
import { assertRequestSupported } from "./capabilities";
import { type ContentResolver, resolveRequestContent } from "./resolveContent";
import type { LlmProvider, LlmRequest, LlmRequestInput, LlmResponse } from "./types";
import { guardRequest } from "./untrusted";

export interface CreateLlmEffectOptions<TIn, TOut> {
  provider: LlmProvider;
  buildRequest: (input: TIn, ctx: EffectContext) => LlmRequestInput;
  parseResponse?: (response: LlmResponse, input: TIn) => TOut;
  /**
   * Consume the provider's `stream` instead of `complete` (R9). OPT-IN: the two
   * paths return the same outcome by the R8 parity contract, but they are
   * different wire calls, and an effect that silently changed which one it makes
   * would be a surprise for anyone already running this.
   *
   * Falls back to `complete` when the provider implements no `stream`, so a
   * provider swap cannot turn this into a runtime failure.
   *
   * What streaming buys, given the outcome is identical: deltas reach
   * {@link onDelta} as they arrive, and an interrupted generation keeps its
   * partial text ({@link LLM_INTERRUPTED}).
   */
  stream?: boolean;
  /**
   * R5 — fetch the bytes behind a `{ kind: "ref" }` media source, at call time. The
   * journaled request carries only the address; this is the one place bytes appear, and
   * only on a LIVE call (a replay is served from the log and never reaches it). Typically
   * `(ref) => contentStore.get({ __loomContent: ref.address })`. Without it, a request
   * with a ref is refused (`UnresolvedContentError`) before any network call.
   */
  resolveContent?: ContentResolver;
  /** R5 — cap on one inline media part, decoded. Default 64 KiB (`MAX_INLINE_BYTES`). */
  maxInlineBytes?: number;
  /** R5 — cap on ALL inline media in one request. Default 256 KiB (`MAX_INLINE_TOTAL_BYTES`). */
  maxInlineTotalBytes?: number;
  /** R5 — cap on the total bytes `resolveContent` may return for one request. Default 32 MiB. */
  maxResolvedBytes?: number;
  /**
   * R5 — a sink for streamed tool-call INPUT fragments (`id`, `name` on the first, then
   * partial JSON). Transient and bare: it is NOT routed through the governed `ctx.onDelta`
   * channel (ADR 0119), because middleware delta guards inspect text. Streaming only.
   */
  onToolDelta?: (
    delta: { id: string; name?: string; inputDelta: string },
    ctx: EffectContext
  ) => void;
  /**
   * R5 — a retried attempt `attempt` (> 1) is about to stream: discard the fragments
   * {@link onToolDelta} delivered so far (the same contract as {@link onReset} for text). Called
   * once per retry, via the same runtime reset chunk as `onReset`. Like `onToolDelta`, it sits OUTSIDE the governed
   * channel: no middleware delta guard or output validator sees tool-input fragments, and
   * `streamTokenBudget` meters the text only.
   */
  onToolReset?: (attempt: number, ctx: EffectContext) => void;
  /**
   * Where deltas go. TRANSIENT by construction — this effect never journals them,
   * and must not: chunks-as-events is the fold-economics problem ST-R rejected,
   * and `ctx.stream` is durable PER DELTA (one permanent event each), so routing
   * a token stream through it is a choice an author makes deliberately, at a
   * granularity they pick.
   *
   * The natural sink is `progressHub` (or the app's own `onDelta` handler). `@loom/live-query`
   * is NOT such a sink: it has no delta-push API — `subscribe` re-folds DURABLE events
   * (`snapshot` + `EventStore.subscribe`), so there is nothing there to push a per-token
   * delta into (2026-09-27 audit).
   *
   * Not called on replay: a completed effect is served from the log and never
   * re-invoked, so a tail attached to a replay sees silence.
   *
   * ADR 0119 — under an `EffectRuntime` this sink is GOVERNED: it receives a delta only
   * after every middleware delta guard accepted it (a PII/output validator severs the
   * stream before the breaching delta), on durable and transient calls alike, and it
   * receives NOTHING when a middleware `inspectsOutput` without a delta form (the call
   * completes non-streamed). Used bare (no runtime) it is called directly.
   *
   * A per-call sink (`EffectContext.onDelta` — what `DecideScope.invokeTransient`
   * `{ onDelta }` sets) is called IN ADDITION to this one, with `{ delta }` per delta and a
   * final `{ delta: "", done: true, usage }`.
   */
  onDelta?: (delta: string, ctx: EffectContext) => void;
  /**
   * ADR 0119 — called when a retried attempt `attempt` (> 1) begins: discard what
   * {@link onDelta} delivered so far. Same governed delivery as `onDelta`.
   */
  onReset?: (attempt: number, ctx: EffectContext) => void;
  /**
   * K8.4 — a mid-flight guard, called after every delta; THROW to sever the
   * generation. Curried over the effect context so it can read `ctx.resources`
   * and emit a durable fact before throwing.
   *
   * `@loom/middleware`'s `streamTokenBudget(budget)` is the budget-shaped one.
   * Streaming-only by nature: `complete` produces nothing to observe until it is
   * already finished, which is the whole reason K8.4 waited on streaming effects.
   */
  guard?: (ctx: EffectContext) => (progress: StreamProgress) => void;
}

export function createLlmEffect<TIn = string, TOut = string>(
  options: CreateLlmEffectOptions<TIn, TOut>
): LlmEffect<TIn, TOut> {
  const parse = options.parseResponse ?? ((r: LlmResponse) => r.content as unknown as TOut);
  return new LlmEffect<TIn, TOut>(
    async (input: TIn, ctx: EffectContext) => {
      // The integrity check at the prompt boundary: tainted content is refused
      // outside a `user` message and fenced inside one, and what comes back is
      // plain strings — so no provider has to know taint exists.
      const guarded = guardRequest(options.buildRequest(input, ctx), {
        ...(options.maxInlineBytes !== undefined && { maxInlineBytes: options.maxInlineBytes }),
        ...(options.maxInlineTotalBytes !== undefined && {
          maxInlineTotalBytes: options.maxInlineTotalBytes,
        }),
      });
      // R5 — fail closed on an undeclared modality BEFORE fetching any content or touching the
      // network, then turn claim-check refs into bytes (live calls only).
      assertRequestSupported(guarded, options.provider.capabilities);
      const request = await resolveRequestContent(guarded, options.resolveContent, {
        ...(options.maxResolvedBytes !== undefined && { maxBytes: options.maxResolvedBytes }),
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
        context: {
          executionId: ctx.executionId,
          stepId: ctx.stepId,
          ...(ctx.principal !== undefined && { principal: ctx.principal }),
        },
      });
      // K8.1 — forward the effect's cooperative-cancellation signal to the
      // provider (unless buildRequest already set one), so a cancelled/timed-out
      // execution severs the in-flight HTTP call instead of orphaning it.
      if (request.signal === undefined && ctx.signal !== undefined) {
        request.signal = ctx.signal;
      }

      // ONE durable outcome either way. The streamed path returns the assembled
      // response, which the R8 conformance contract pins equal to what `complete`
      // would have returned — so the journal shape does not depend on which path
      // ran, and switching `stream` on cannot change what replay serves.
      const response = await (options.stream === true && options.provider.stream !== undefined
        ? collectStream(options.provider.stream(request as LlmRequest), {
            ...(ctx.signal !== undefined && { signal: ctx.signal }),
            // ADR 0119 — the per-call sink (ctx.onDelta, set by a decider's scope) AND the
            // configured one both fire; neither replaces the other. The per-call sink goes
            // FIRST: it is the governed one, and a middleware delta guard severs the stream
            // by THROWING from it — which must happen before any other tail sees the delta.
            // Do not catch around it. The text is wrapped as untrusted content (ADR 0085).
            // The configured sink is NOT called here under a runtime: ctx.onDelta is the
            // guarded channel and the runtime forwards to `deltaSink` after the guards.
            ...((options.onDelta !== undefined || ctx.onDelta !== undefined) && {
              onDelta: (delta: string) => {
                if (ctx.onDelta !== undefined) {
                  ctx.onDelta({ delta: tainted(delta, `llm:${ctx.stepId}`) });
                } else options.onDelta?.(delta, ctx);
              },
            }),
            ...(options.onToolDelta !== undefined && {
              onToolDelta: (d: { id: string; name?: string; inputDelta: string }) =>
                options.onToolDelta?.(d, ctx),
            }),
            ...(options.guard !== undefined && { guard: options.guard(ctx) }),
          })
        : options.provider.complete(request));
      // ADR 0119 — hand the runtime the stream's end + usage. The runtime HOLDS this and
      // sends the caller's terminal chunk only once the whole call has succeeded
      // (middleware output phase and parse included), so `done` never precedes a failure.
      // Streamed path only: a `complete` fallback delivered no deltas to terminate.
      if (options.stream === true && options.provider.stream !== undefined) {
        ctx.onDelta?.({
          delta: tainted("", `llm:${ctx.stepId}`),
          done: true,
          ...(response.usage !== undefined && { usage: response.usage }),
        });
      }

      return parse(response, input);
    },
    // Wire pre-warm to the provider's own warm hook (connection/model cache),
    // only when the provider implements one.
    {
      ...(options.provider.warm !== undefined && { warm: () => options.provider.warm?.() }),
      ...((options.onDelta !== undefined ||
        options.onReset !== undefined ||
        options.onToolReset !== undefined) && {
        deltaSink: (chunk: EffectDelta, ctx: EffectContext) => {
          if (chunk.reset === true) {
            options.onReset?.(chunk.attempt ?? 2, ctx);
            options.onToolReset?.(chunk.attempt ?? 2, ctx);
          } else if (chunk.done !== true) options.onDelta?.(unwrapTainted(chunk.delta), ctx);
        },
      }),
    }
  );
}
