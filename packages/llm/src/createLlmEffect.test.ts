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

  // K8.1 — the effect's cancellation signal reaches the provider so a
  // cancelled/timed-out execution severs the in-flight HTTP call.
  it("forwards ctx.signal to the provider request (K8.1)", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const provider: LlmProvider = {
      complete: async (request) => {
        seen.push(request.signal);
        return { content: "", stopReason: "end_turn" };
      },
    };
    const effect = createLlmEffect<string, string>({
      provider,
      buildRequest: (input) => ({ messages: [{ role: "user", content: input }] }),
    });

    const controller = new AbortController();
    await effect.execute("hi", { ...makeCtx(), signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });

  it("wires the effect's warm() to the provider's warm hook (pre-warm)", async () => {
    const providerWarm = vi.fn();
    const provider: LlmProvider = {
      complete: async () => ({ content: "", stopReason: "end_turn" }),
      warm: providerWarm,
    };
    const effect = createLlmEffect({ provider, buildRequest: () => ({ messages: [] }) });
    expect(effect.warm).toBeDefined();
    await effect.warm?.();
    expect(providerWarm).toHaveBeenCalledTimes(1);
  });

  it("has no warm() when the provider does not implement one", () => {
    const provider: LlmProvider = { complete: async () => ({ content: "", stopReason: "end_turn" }) };
    const effect = createLlmEffect({ provider, buildRequest: () => ({ messages: [] }) });
    expect(effect.warm).toBeUndefined();
  });

  it("a signal set by buildRequest wins over ctx.signal", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const provider: LlmProvider = {
      complete: async (request) => {
        seen.push(request.signal);
        return { content: "", stopReason: "end_turn" };
      },
    };
    const explicit = new AbortController();
    const effect = createLlmEffect<string, string>({
      provider,
      buildRequest: (input) => ({
        messages: [{ role: "user", content: input }],
        signal: explicit.signal,
      }),
    });

    const ctxController = new AbortController();
    await effect.execute("hi", { ...makeCtx(), signal: ctxController.signal });
    expect(seen[0]).toBe(explicit.signal);
  });
});
