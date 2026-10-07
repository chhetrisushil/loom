import type { LlmEffect } from "@loom/effect-runtime";
import { createLlmEffect } from "@loom/llm";
import type { ContentResolver, LlmProvider, LlmResponse } from "@loom/llm";
import type { AgentModelCall } from "./agentLoop$";

/**
 * The model effect an {@link agentLoop$} resolves `modelToolId` to.
 *
 * Register it and the agent's model call runs INSIDE the protection ring, which
 * is the half of R2 the direct-guard fix could not reach: K2 authorization,
 * metering and quotas, retry, `idempotencyKey`, K9 in-doubt — plus `guardRequest`,
 * which `createLlmEffect` runs unconditionally.
 *
 * ```ts
 * effects.register("model", createAgentModelEffect(provider, { stream: true, onDelta }));
 * ```
 *
 * It is a thin wrapper on purpose: the request arrives already assembled by the
 * loop, and the response is returned whole because the loop branches on
 * `toolCalls` and `stopReason`. Anything cleverer in here would be a second place
 * for the two to disagree about the turn's shape.
 */
export function createAgentModelEffect(
  provider: LlmProvider,
  options: {
    stream?: boolean;
    onDelta?: (delta: string) => void;
    /** R5 — fetch the bytes behind a media `ref` at call time (e.g. from the ContentStore). */
    resolveContent?: ContentResolver;
    onToolDelta?: (delta: { id: string; name?: string; inputDelta: string }) => void;
    /** R5 — discard the tool-input fragments delivered so far; a retried attempt is starting. */
    onToolReset?: (attempt: number) => void;
  } = {}
): LlmEffect<AgentModelCall, LlmResponse> {
  return createLlmEffect<AgentModelCall, LlmResponse>({
    provider,
    buildRequest: (call) => call,
    parseResponse: (response) => response,
    ...(options.stream !== undefined && { stream: options.stream }),
    ...(options.resolveContent !== undefined && { resolveContent: options.resolveContent }),
    ...(options.onToolDelta !== undefined && {
      onToolDelta: (delta: { id: string; name?: string; inputDelta: string }) =>
        options.onToolDelta?.(delta),
    }),
    ...(options.onToolReset !== undefined && {
      onToolReset: (attempt: number) => options.onToolReset?.(attempt),
    }),
    ...(options.onDelta !== undefined && { onDelta: (delta: string) => options.onDelta?.(delta) }),
  });
}
