import type { AgentDefinition } from "@loom/core";
import type { EffectContext, EffectRuntime } from "@loom/effect-runtime";
import { LlmEffect } from "@loom/effect-runtime";
import type { LlmMessage, LlmProvider, LlmToolSpec } from "@loom/llm";
import type { MemoryRuntime } from "@loom/memory";
import type { AgentInput, AgentOutput, AgentStep } from "./types";

export interface AgentConfig {
  definition: AgentDefinition;
  provider: LlmProvider;
  effectRuntime: EffectRuntime;
  maxIterations?: number;
  systemPrompt?: string;
  // Optional Agent Runtime memory. When the agent's definition has a memoryId
  // and a MemoryRuntime is provided, prior turns are recalled into the prompt
  // and this turn's answer is remembered — scoped by input.memoryScope.
  memory?: MemoryRuntime;
}

export class AgentRunner {
  private readonly maxIterations: number;

  constructor(private readonly config: AgentConfig) {
    this.maxIterations = config.maxIterations ?? 10;
  }

  async run(input: AgentInput, ctx: EffectContext): Promise<AgentOutput> {
    const { definition, provider, effectRuntime, systemPrompt, memory } = this.config;

    const toolSpecs: LlmToolSpec[] = definition.tools.map((t: AgentDefinition["tools"][number]) => ({
      name: t.id,
      description: t.description,
      inputSchema: {},
    }));

    const memoryId = definition.memoryId;
    const memoryScope = input.memoryScope ?? ctx.executionId;

    const messages: LlmMessage[] = [];

    // Recall prior memory for this agent+scope, if configured.
    if (memory !== undefined && memoryId !== undefined) {
      for (const entry of memory.read(memoryId, memoryScope)) {
        const role = entry.role === "assistant" ? "assistant" : "user";
        messages.push({ role, content: String(entry.content) });
      }
    }

    messages.push({
      role: "user",
      content:
        input.context != null
          ? `Context: ${JSON.stringify(input.context)}\n\n${input.prompt}`
          : input.prompt,
    });

    const toolCallLog: AgentStep[] = [];
    let iterations = 0;
    let lastContent = "";

    while (iterations < this.maxIterations) {
      iterations++;

      const response = await provider.complete({
        messages,
        ...(toolSpecs.length > 0 && { tools: toolSpecs }),
        ...(systemPrompt !== undefined && { system: systemPrompt }),
      });

      lastContent = response.content;

      if (response.stopReason === "end_turn" || !response.toolCalls?.length) {
        break;
      }

      messages.push({ role: "assistant", content: response.content || "(tool calls)" });

      for (const toolCall of response.toolCalls) {
        let toolOutput: unknown;
        try {
          toolOutput = await effectRuntime.execute(toolCall.name, toolCall.input, ctx);
        } catch (err) {
          toolOutput = { error: String(err) };
        }

        toolCallLog.push({
          iteration: iterations,
          toolName: toolCall.name,
          toolInput: toolCall.input,
          toolOutput,
        });

        ctx.emit("AGENT_TOOL_CALL", {
          iteration: iterations,
          toolName: toolCall.name,
          toolInput: toolCall.input,
          toolOutput,
        });

        messages.push({
          role: "user",
          content: JSON.stringify({ tool: toolCall.name, result: toolOutput }),
        });
      }
    }

    // Remember this turn (the user's prompt and the agent's answer).
    if (memory !== undefined && memoryId !== undefined) {
      memory.append(memoryId, memoryScope, { role: "user", content: input.prompt });
      memory.append(memoryId, memoryScope, { role: "assistant", content: lastContent });
    }

    ctx.emit("AGENT_COMPLETED", { content: lastContent, iterations, toolCallCount: toolCallLog.length });

    return { content: lastContent, toolCallLog, iterations };
  }

  asEffect(): LlmEffect<AgentInput, AgentOutput> {
    return new LlmEffect<AgentInput, AgentOutput>((input: AgentInput, ctx: EffectContext) =>
      this.run(input, ctx)
    );
  }
}
