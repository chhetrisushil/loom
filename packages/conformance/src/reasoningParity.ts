import type { LlmProvider, LlmReasoning, LlmRequest, LlmStreamChunk } from "@loom/llm";
import { assembleStream } from "@loom/llm";
import { expect } from "vitest";

/**
 * The ADR 0133 D2 reasoning rule from {@link runLlmProviderConformance} (`./index.ts`), in its own
 * module for the same reason as `toolCallParity.ts`: the negative cases that prove it FIRES are unit
 * tests against this function, not assertions about the kit's own generated suite.
 *
 * Reasoning is OPTIONAL: a provider that reports none, on either path, passes. But when it reports
 * any, honesty is required:
 *  - `stream` and `complete` report EQUAL reasoning for the same request (an omission on one path is
 *    a mismatch, not "not reported");
 *  - the concatenated `reasoningDelta`s equal the terminal chunk's readable text (the `text` of every
 *    non-`redacted` part, in order), so a live view and the durable record say the same thing.
 */
export async function checkReasoningParity(
  provider: LlmProvider,
  request: LlmRequest
): Promise<void> {
  if (provider.stream === undefined) return;
  const completed = await provider.complete(request);
  const chunks: LlmStreamChunk[] = [];
  for await (const c of provider.stream(request)) chunks.push(c);
  const streamed = assembleStream(chunks);
  const deltas = chunks.map((c) => c.reasoningDelta ?? "").join("");

  if (completed.reasoning === undefined && streamed.reasoning === undefined && deltas === "") {
    return; // reports none: allowed
  }
  expect(streamed.reasoning, "stream and complete must report equal reasoning").toEqual(
    completed.reasoning
  );
  expect(deltas, "concatenated reasoningDeltas must equal the terminal readable text").toBe(
    readableText(streamed.reasoning)
  );
}

function readableText(reasoning: readonly LlmReasoning[] | undefined): string {
  return (reasoning ?? []).map((r) => (r.kind === "redacted" ? "" : (r.text ?? ""))).join("");
}
