import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { createLlmEffect } from "./createLlmEffect";
import type { LlmProvider, LlmResponse } from "./types";

function makeCtx(): EffectContext {
  return {
    executionId: "e",
    stepId: "s",
    workflowId: "w",
    attempt: 1,
    emit: vi.fn(),
  };
}

describe("createLlmEffect", () => {
  it("builds a request, calls the provider, and returns content by default", async () => {
    const response: LlmResponse = { content: "hello world", stopReason: "end_turn" };
    const provider: LlmProvider = { complete: vi.fn(async () => response) };

    const effect = createLlmEffect<string, string>({
      provider,
      buildRequest: (input) => ({ messages: [{ role: "user", content: input }] }),
    });

    const result = await effect.execute("say hi", makeCtx());
    expect(result).toBe("hello world");
    expect(provider.complete).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "say hi" }],
    });
  });

  it("applies a custom parseResponse", async () => {
    const provider: LlmProvider = {
      complete: async () => ({ content: "42", stopReason: "end_turn" }),
    };
    const effect = createLlmEffect<string, number>({
      provider,
      buildRequest: (input) => ({ messages: [{ role: "user", content: input }] }),
      parseResponse: (r) => Number(r.content),
    });
    const result = await effect.execute("number please", makeCtx());
    expect(result).toBe(42);
  });

  it("has kind 'llm'", () => {
    const provider: LlmProvider = {
      complete: async () => ({ content: "", stopReason: "end_turn" }),
    };
    const effect = createLlmEffect({
      provider,
      buildRequest: () => ({ messages: [] }),
    });
    expect(effect.kind).toBe("llm");
  });
});
