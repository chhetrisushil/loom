import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { AgentRunner } from "./AgentRunner";

function makeEffectContext(): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "agent-step",
    workflowId: "wf-1",
    attempt: 1,
    emit: vi.fn(),
  };
}

const weatherTool = tool$({
  id: "get-weather",
  name: "Get Weather",
  description: "Returns the weather for a city",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ tempC: z.number() }),
});

const weatherAgent = agent$({
  id: "weather-agent",
  name: "Weather Agent",
  tools: [weatherTool],
});

describe("AgentRunner", () => {
  it("runs a ReAct loop: tool_use then end_turn", async () => {
    const responses: LlmResponse[] = [
      {
        content: "Let me check the weather.",
        toolCalls: [{ id: "call-1", name: "get-weather", input: { city: "Paris" } }],
        stopReason: "tool_use",
      },
      { content: "It is 18°C in Paris.", stopReason: "end_turn" },
    ];
    let call = 0;
    const provider: LlmProvider = {
      complete: vi.fn(async () => responses[call++] as LlmResponse),
    };

    const effectRuntime = new EffectRuntime();
    effectRuntime.register("get-weather", new ToolEffect(async () => ({ tempC: 18 })));

    const ctx = makeEffectContext();
    const runner = new AgentRunner({ definition: weatherAgent, provider, effectRuntime });
    const output = await runner.run({ prompt: "What is the weather in Paris?" }, ctx);

    expect(output.content).toBe("It is 18°C in Paris.");
    expect(output.iterations).toBe(2);
    expect(output.toolCallLog).toHaveLength(1);
    expect(output.toolCallLog[0]?.toolName).toBe("get-weather");
    expect(output.toolCallLog[0]?.toolOutput).toEqual({ tempC: 18 });
  });

  it("emits AGENT_TOOL_CALL and AGENT_COMPLETED events", async () => {
    const responses: LlmResponse[] = [
      {
        content: "",
        toolCalls: [{ id: "c1", name: "get-weather", input: { city: "Berlin" } }],
        stopReason: "tool_use",
      },
      { content: "Done.", stopReason: "end_turn" },
    ];
    let call = 0;
    const provider: LlmProvider = {
      complete: async () => responses[call++] as LlmResponse,
    };
    const effectRuntime = new EffectRuntime();
    effectRuntime.register("get-weather", new ToolEffect(async () => ({ tempC: 5 })));

    const ctx = makeEffectContext();
    const runner = new AgentRunner({ definition: weatherAgent, provider, effectRuntime });
    await runner.run({ prompt: "Weather in Berlin?" }, ctx);

    const emit = ctx.emit as ReturnType<typeof vi.fn>;
    const eventTypes = emit.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain("AGENT_TOOL_CALL");
    expect(eventTypes).toContain("AGENT_COMPLETED");
  });

  it("stops at maxIterations to avoid infinite tool loops", async () => {
    const provider: LlmProvider = {
      complete: async () => ({
        content: "thinking",
        toolCalls: [{ id: "c", name: "get-weather", input: {} }],
        stopReason: "tool_use",
      }),
    };
    const effectRuntime = new EffectRuntime();
    effectRuntime.register("get-weather", new ToolEffect(async () => ({ tempC: 0 })));

    const runner = new AgentRunner({
      definition: weatherAgent,
      provider,
      effectRuntime,
      maxIterations: 3,
    });
    const output = await runner.run({ prompt: "loop" }, makeEffectContext());
    expect(output.iterations).toBe(3);
  });

  it("recalls and writes memory when the agent has a memoryId", async () => {
    const { MemoryRuntime } = await import("@loom/memory");
    const { memory$, agent$ } = await import("@loom/core");

    const memory = new MemoryRuntime();
    memory.register(memory$({ id: "chat", name: "Chat" }));

    const rememberingAgent = agent$({
      id: "chat-agent",
      name: "Chat Agent",
      tools: [],
      memoryId: "chat",
    });

    const seenPrompts: string[] = [];
    const provider: LlmProvider = {
      complete: async (req) => {
        seenPrompts.push(req.messages.map((m) => `${m.role}:${m.content}`).join("|"));
        return { content: "noted", stopReason: "end_turn" };
      },
    };
    const effectRuntime = new EffectRuntime();
    const runner = new AgentRunner({ definition: rememberingAgent, provider, effectRuntime, memory });

    // First turn — no prior memory.
    await runner.run({ prompt: "my name is Ada", memoryScope: "user-1" }, makeEffectContext());
    // Second turn — should recall the first turn.
    await runner.run({ prompt: "what is my name?", memoryScope: "user-1" }, makeEffectContext());

    expect(seenPrompts[0]).toBe("user:my name is Ada");
    expect(seenPrompts[1]).toContain("user:my name is Ada");
    expect(seenPrompts[1]).toContain("assistant:noted");
    expect(seenPrompts[1]).toContain("user:what is my name?");

    // A different scope does not see user-1's memory.
    seenPrompts.length = 0;
    await runner.run({ prompt: "hello", memoryScope: "user-2" }, makeEffectContext());
    expect(seenPrompts[0]).toBe("user:hello");
  });

  it("captures tool errors instead of throwing", async () => {
    const responses: LlmResponse[] = [
      {
        content: "",
        toolCalls: [{ id: "c1", name: "get-weather", input: {} }],
        stopReason: "tool_use",
      },
      { content: "handled", stopReason: "end_turn" },
    ];
    let call = 0;
    const provider: LlmProvider = { complete: async () => responses[call++] as LlmResponse };
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "get-weather",
      new ToolEffect(async () => {
        throw new Error("boom");
      })
    );

    const runner = new AgentRunner({ definition: weatherAgent, provider, effectRuntime });
    const output = await runner.run({ prompt: "x" }, makeEffectContext());
    expect(output.toolCallLog[0]?.toolOutput).toEqual({ error: "Error: boom" });
  });
});
