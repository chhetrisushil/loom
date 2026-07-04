import { LlmEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

export interface CreateLlmEffectOptions<TIn, TOut> {
  provider: LlmProvider;
  buildRequest: (input: TIn, ctx: EffectContext) => LlmRequest;
  parseResponse?: (response: LlmResponse, input: TIn) => TOut;
}

export function createLlmEffect<TIn = string, TOut = string>(
  options: CreateLlmEffectOptions<TIn, TOut>
): LlmEffect<TIn, TOut> {
  const parse = options.parseResponse ?? ((r: LlmResponse) => r.content as unknown as TOut);
  return new LlmEffect<TIn, TOut>(async (input: TIn, ctx: EffectContext) => {
    const request = options.buildRequest(input, ctx);
    const response = await options.provider.complete(request);
    return parse(response, input);
  });
}
