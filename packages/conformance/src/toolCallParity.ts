import type { LlmProvider, LlmRequest, LlmStreamChunk } from "@loom/llm";
import { assembleStream } from "@loom/llm";
import { expect } from "vitest";

/**
 * The `toolRequest` rule from {@link runLlmProviderConformance} (`./index.ts`), kept in
 * its own module — NOT re-exported from the package's single public entry point
 * (`src/index.ts`) — so it can be exercised directly by this package's own tests without
 * growing `@loom/conformance`'s public surface (ADR 0083: no second consumer has named a
 * standalone need for it). A provider factory can only be driven through vitest's `it`,
 * and vitest refuses to collect a nested `describe`/`it` once a test has started running,
 * so the negative cases that prove this rule FIRES are unit tests against this function
 * (imported by its own module path) rather than against the kit's own generated suite.
 *
 * Resolves when the rule is satisfied, including every legitimate skip (no `stream`,
 * or an explicit `toolRequest: null` opt-out). Rejects, naming the violation, otherwise.
 */
export async function checkToolCallStreamParity(
  provider: LlmProvider,
  toolRequest: LlmRequest | null | undefined
): Promise<void> {
  if (provider.stream === undefined) return; // nothing to keep in parity
  if (toolRequest === null) return; // explicit opt-out: this provider cannot call tools
  if (toolRequest === undefined) {
    throw new Error(
      "stream parity for tool calls is unproven — pass `toolRequest` (a request this " +
        "provider answers with a tool call) to runLlmProviderConformance, or " +
        "`{ toolRequest: null }` to opt out for a provider that cannot call tools."
    );
  }

  const completed = await provider.complete(toolRequest);
  if (completed.toolCalls === undefined || completed.toolCalls.length === 0) {
    throw new Error(
      "toolRequest fixture is a refusal, not a pass — complete(toolRequest) returned no " +
        "tool call, so there is nothing to check the stream against. Fix the fixture (or " +
        "the request) so complete(toolRequest) actually calls a tool."
    );
  }

  const chunks: LlmStreamChunk[] = [];
  for await (const c of provider.stream(toolRequest)) chunks.push(c);
  const streamed = assembleStream(chunks);

  expect(streamed.toolCalls).toEqual(completed.toolCalls);
  if (completed.stopReason === "tool_use") {
    expect(streamed.stopReason).toBe(completed.stopReason);
  }
}
