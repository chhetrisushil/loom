import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

// A deterministic provider that returns a fixed queue of responses, so the
// ReAct loop is reproducible offline. In production you would use:
//
//   import { AnthropicProvider } from "@loom/llm";
//   const provider = new AnthropicProvider({ model: "claude-opus-4-8" });
//
// or OpenAiProvider, or any object implementing LlmProvider — the choice of
// model is pure configuration.
export class ScriptedLlmProvider implements LlmProvider {
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {}

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    const response = this.responses[this.index] ?? { content: "(done)", stopReason: "end_turn" };
    this.index = Math.min(this.index + 1, this.responses.length);
    return response;
  }
}
