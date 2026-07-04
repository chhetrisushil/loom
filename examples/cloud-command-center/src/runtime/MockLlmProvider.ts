import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "@loom/llm";

// A deterministic, offline LlmProvider so the example runs with no API key.
//
// Because the framework's LlmProvider contract is provider-agnostic, swapping
// this for a real model is a one-line change in setup.ts:
//
//   import { AnthropicProvider } from "@loom/llm";
//   export const llmProvider = new AnthropicProvider({ model: "claude-opus-4-8" });
//
// Everything downstream (streaming step, projection, StreamingText widget)
// stays exactly the same.
export class MockLlmProvider implements LlmProvider {
  private readonly script: string;

  constructor(script?: string) {
    this.script =
      script ??
      "Root cause: the database pod breached its CPU threshold (87% vs 80%) after the " +
        "connection pool was exhausted, triggering the OOM killer. Recommended remediation: " +
        "restart the affected pod to reclaim memory and let the pool re-initialize. " +
        "Confidence: high. This is a known signature for connection-pool starvation under load.";
  }

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    return { content: this.script, stopReason: "end_turn" };
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    // Emit token-by-token with a small delay so the UI visibly streams.
    const tokens = this.script.split(/(\s+)/);
    for (const token of tokens) {
      await delay(28);
      yield { delta: token, done: false };
    }
    yield { delta: "", done: true };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
