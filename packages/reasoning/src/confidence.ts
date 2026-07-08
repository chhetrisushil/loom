import type { LlmResponse } from "@loom/llm";
import type { ConfidenceSignal, ReasoningRequest } from "./types";

// Honest, pluggable confidence — NOT a magic self-reported number. The default uses
// the model's stop reason, the one signal every provider emits: a truncated answer
// (max_tokens) is low-confidence and should elevate; a clean finish is high.
export const stopReasonConfidence: ConfidenceSignal = {
  score(_req: ReasoningRequest, res: LlmResponse): number {
    switch (res.stopReason) {
      case "end_turn":
        return 0.9;
      case "tool_use":
        return 0.9;
      case "max_tokens":
        return 0.3;
      default:
        return 0.5;
    }
  },
};

// Confidence from a caller-supplied validator: pass → 1, fail → 0. Use for structured
// outputs ("did it parse as the expected JSON / a known capability id?"). This turns
// elevation into "retry on a stronger model until the output validates."
export function validatorConfidence(validate: (content: string) => boolean): ConfidenceSignal {
  return {
    score(_req: ReasoningRequest, res: LlmResponse): number {
      return validate(res.content) ? 1 : 0;
    },
  };
}

// Agreement across a fixed constant — always returns the given value. Useful to force
// (never elevate → 1) or always-elevate (→ 0) in tests and pins.
export function constantConfidence(value: number): ConfidenceSignal {
  return { score: () => value };
}
