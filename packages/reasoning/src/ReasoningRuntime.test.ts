import type { LlmProvider, LlmResponse } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { ReasoningRuntime } from "./ReasoningRuntime";
import { validatorConfidence } from "./confidence";

// A deterministic offline provider: returns a fixed response and counts calls.
class FakeProvider implements LlmProvider {
  calls = 0;
  constructor(private readonly res: LlmResponse) {}
  async complete(): Promise<LlmResponse> {
    this.calls += 1;
    return this.res;
  }
}

const weakRes: LlmResponse = { content: "weak", stopReason: "max_tokens" }; // low confidence
const strongRes: LlmResponse = { content: "strong", stopReason: "end_turn" }; // high confidence

function makeRuntime() {
  const gemma = new FakeProvider(weakRes);
  const opus = new FakeProvider(strongRes);
  const runtime = new ReasoningRuntime({
    routes: [
      { id: "gemma", provider: gemma, tier: 0 },
      { id: "opus", provider: opus, tier: 2 },
    ],
  });
  return { runtime, gemma, opus };
}

describe("ReasoningRuntime — routing + elevation", () => {
  it("routes cheap-first, then elevates on low confidence", async () => {
    const { runtime, gemma, opus } = makeRuntime();
    const r = await runtime.reason({ messages: [{ role: "user", content: "hi" }] });

    expect(r.trace.map((t) => t.modelId)).toEqual(["gemma", "opus"]);
    expect(r.modelId).toBe("opus");
    expect(r.elevated).toBe(true);
    expect(r.content).toBe("strong");
    expect(gemma.calls).toBe(1);
    expect(opus.calls).toBe(1);
  });

  it("does not elevate when the cheap model is already confident", async () => {
    const gemma = new FakeProvider(strongRes);
    const opus = new FakeProvider(strongRes);
    const runtime = new ReasoningRuntime({
      routes: [
        { id: "gemma", provider: gemma, tier: 0 },
        { id: "opus", provider: opus, tier: 2 },
      ],
    });
    const r = await runtime.reason({ messages: [{ role: "user", content: "hi" }] });

    expect(r.modelId).toBe("gemma");
    expect(r.elevated).toBe(false);
    expect(opus.calls).toBe(0);
  });

  it("respects maxTier as a budget cap (no elevation above it)", async () => {
    const { runtime, opus } = makeRuntime();
    const r = await runtime.reason({ messages: [{ role: "user", content: "hi" }], maxTier: 0 });

    expect(r.modelId).toBe("gemma");
    expect(r.elevated).toBe(false);
    expect(opus.calls).toBe(0);
  });

  it("routes by strategy tag", async () => {
    const gemma = new FakeProvider(strongRes);
    const coder = new FakeProvider(strongRes);
    const runtime = new ReasoningRuntime({
      routes: [
        { id: "gemma", provider: gemma, tier: 0 },
        { id: "coder", provider: coder, tier: 1, tags: ["coding"] },
      ],
    });
    const r = await runtime.reason({ messages: [{ role: "user", content: "x" }], strategy: "coding" });

    expect(r.modelId).toBe("coder");
    expect(coder.calls).toBe(1);
    expect(gemma.calls).toBe(0);
  });

  it("elevates until the output validates (validatorConfidence)", async () => {
    const badJson = new FakeProvider({ content: "not json", stopReason: "end_turn" });
    const goodJson = new FakeProvider({ content: '{"ok":true}', stopReason: "end_turn" });
    const runtime = new ReasoningRuntime({
      routes: [
        { id: "gemma", provider: badJson, tier: 0 },
        { id: "opus", provider: goodJson, tier: 1 },
      ],
      confidence: validatorConfidence((c) => c.trim().startsWith("{")),
    });
    const r = await runtime.reason({ messages: [{ role: "user", content: "x" }] });

    expect(r.modelId).toBe("opus");
    expect(r.content).toBe('{"ok":true}');
  });
});

describe("ReasoningRuntime — decision logging (P9)", () => {
  it("records route and elevation choices through the decide sink", async () => {
    const { runtime } = makeRuntime();
    const decisions: Array<{ id: string; choice: unknown }> = [];
    const decide = async <T,>(id: string, decider: () => T | Promise<T>): Promise<T> => {
      const choice = await decider();
      decisions.push({ id, choice });
      return choice;
    };

    const r = await runtime.reason(
      { messages: [{ role: "user", content: "hi" }], strategy: "plan" },
      { decide }
    );

    expect(r.elevated).toBe(true);
    expect(decisions.map((d) => d.id)).toEqual(["reason:plan:route", "reason:plan:elevate:1"]);
    expect(decisions[0]?.choice).toBe("gemma");
    expect(decisions[1]?.choice).toBe("opus");
  });

  it("serves a recorded route on replay without re-invoking the router", async () => {
    const { runtime, gemma, opus } = makeRuntime();
    // Simulate replay: the log already recorded that this decision chose "opus".
    const recorded: Record<string, unknown> = { "reason:default:route": "opus" };
    const decide = async <T,>(id: string, decider: () => T | Promise<T>): Promise<T> => {
      if (id in recorded) return recorded[id] as T;
      return decider();
    };

    const r = await runtime.reason({ messages: [{ role: "user", content: "hi" }] }, { decide });

    // Routed straight to opus (the recorded choice); the weak model was never called,
    // and opus is already confident so no elevation happens.
    expect(r.modelId).toBe("opus");
    expect(gemma.calls).toBe(0);
    expect(opus.calls).toBe(1);
    expect(r.elevated).toBe(false);
  });
});
