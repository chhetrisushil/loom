import { agent$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import { ReasoningRuntime } from "@loom/reasoning";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./AgentRunner";

function ctx(emit = vi.fn()): EffectContext {
  return { executionId: "e", stepId: "s", workflowId: "wf", attempt: 1, emit };
}

const bareAgent = agent$({ id: "a", name: "A", tools: [] });

describe("AgentRunner — reasoning re-base (M8)", () => {
  it("routes the model call through the Reasoning Runtime, elevating and logging the route", async () => {
    // Cheap model is low-confidence (truncated) → reasoning elevates to the strong one.
    const weak: LlmProvider = { complete: async () => ({ content: "weak", stopReason: "max_tokens" }) };
    const strong: LlmProvider = {
      complete: async () => ({ content: "strong answer", stopReason: "end_turn" }),
    };
    const reasoning = new ReasoningRuntime({
      routes: [
        { id: "gemma", provider: weak, tier: 0 },
        { id: "opus", provider: strong, tier: 1 },
      ],
    });
    const emit = vi.fn();
    const runner = new AgentRunner({
      definition: bareAgent,
      reasoning,
      effectRuntime: new EffectRuntime(),
    });

    const out = await runner.run({ prompt: "hi" }, ctx(emit));

    // The runtime routed/elevated and returned the strong model's answer.
    expect(out.content).toBe("strong answer");
    // The route was recorded as a durable decision fact (P9), tagged source: "agent".
    const decisions = emit.mock.calls.filter((c) => c[0] === "DECISION_RECORDED");
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0]?.[1]).toMatchObject({ source: "agent" });
    expect(decisions.some((c) => (c[1] as { choice: unknown }).choice === "opus")).toBe(true);
  });

  it("still works with a bare provider (unchanged path)", async () => {
    const provider: LlmProvider = {
      complete: async () => ({ content: "hello", stopReason: "end_turn" }),
    };
    const runner = new AgentRunner({ definition: bareAgent, provider, effectRuntime: new EffectRuntime() });
    const out = await runner.run({ prompt: "hi" }, ctx());
    expect(out.content).toBe("hello");
  });

  it("throws when neither a provider nor a reasoning runtime is given", () => {
    expect(
      () => new AgentRunner({ definition: bareAgent, effectRuntime: new EffectRuntime() })
    ).toThrow(/provider.*reasoning/);
  });
});
