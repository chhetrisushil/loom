import { LlmEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider, LlmRequestInput, LlmResponse } from "./types";
import { guardRequest } from "./untrusted";

export interface CreateLlmEffectOptions<TIn, TOut> {
  provider: LlmProvider;
  buildRequest: (input: TIn, ctx: EffectContext) => LlmRequestInput;
  parseResponse?: (response: LlmResponse, input: TIn) => TOut;
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
      const response = await options.provider.complete(request);
      return parse(response, input);
    },
    // Wire pre-warm to the provider's own warm hook (connection/model cache),
    // only when the provider implements one.
    options.provider.warm !== undefined ? { warm: () => options.provider.warm?.() } : {}
  );
}
