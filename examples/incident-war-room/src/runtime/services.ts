import { DemoLlmProvider } from "./DemoLlmProvider";

// The single, swappable model dependency for the whole app (planner, intent
// routing, and agent narration). Swap for AnthropicProvider/OpenAiProvider to go
// live — nothing else changes.
export const llm = new DemoLlmProvider();
