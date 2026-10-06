import { LlmEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { collectStream } from "./assembleStream";
import type { StreamProgress } from "./assembleStream";
import type {
  LlmProvider,
  LlmRequest,
  LlmRequestInput,
  LlmResponse,
  LlmStreamChunk,
} from "./types";
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
   * A per-call sink (`EffectContext.onDelta`, ADR 0119 — what `DecideScope.invokeTransient`
   * `{ onDelta }` sets) is called IN ADDITION to this one, with `{ delta }` per delta and a
   * final `{ delta: "", done: true, usage }`. That is true of every
   * effect, but streaming is where authors expect otherwise.
   */
  onDelta?: (delta: string, ctx: EffectContext) => void;
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
      const request = guardRequest(options.buildRequest(input, ctx));
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
            // ADR 0119 — the configured sink AND the per-call sink (ctx.onDelta, set by a
            // decider's scope) both fire; neither replaces the other. The runtime's
            // wrapper around ctx.onDelta never throws, so it is called unguarded.
            ...((options.onDelta !== undefined || ctx.onDelta !== undefined) && {
              onDelta: (delta: string) => {
                options.onDelta?.(delta, ctx);
                ctx.onDelta?.({ delta });
              },
            }),
            ...(options.guard !== undefined && { guard: options.guard(ctx) }),
          })
        : options.provider.complete(request));
      // ADR 0119 — the terminal chunk carries usage, so a per-call sink learns the
      // spend (the charge itself is dropped by a transient call's no-op emit).
      // Streamed path only: a `complete` fallback delivered no deltas to terminate.
      if (options.stream === true && options.provider.stream !== undefined) {
        ctx.onDelta?.({
          delta: "",
          done: true,
          ...(response.usage !== undefined && { usage: response.usage }),
        });
      }

      return parse(response, input);
    },
    // Wire pre-warm to the provider's own warm hook (connection/model cache),
    // only when the provider implements one.
    options.provider.warm !== undefined ? { warm: () => options.provider.warm?.() } : {}
  );
}
