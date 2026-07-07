import type { LlmProvider } from "@loom/llm";
import { SwarmLlmProvider } from "./SwarmLlmProvider";

// The single, swappable model dependency. Deterministic + offline by default;
// swap in `new AnthropicProvider({ model: "claude-opus-4-8" })` to go live.
export const llm: LlmProvider = new SwarmLlmProvider();
