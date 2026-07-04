import { EffectRuntime, LlmEffect } from "@loom/effect-runtime";
import { createA2UIEmitter } from "@loom/a2ui";
import type { LlmProvider } from "@loom/llm";
import { MockLlmProvider } from "./MockLlmProvider";

// Browser-safe AI-triage wiring — no SQLite / Node-only imports, so both the
// browser entry (main.tsx) and the Node setup (setup.ts) can share it.

// The LLM is a swappable, configured dependency. Replace this single line with
//   import { AnthropicProvider } from "@loom/llm";
//   export const llmProvider = new AnthropicProvider({ model: "claude-opus-4-8" });
// to run the exact same flow against a real model — no other code changes.
export const llmProvider: LlmProvider = new MockLlmProvider();

// Registers the AI triage effect with a concrete LlmProvider. The effect streams
// tokens to the UI through the A2UI protocol — createA2UIEmitter turns ctx.emit
// into patch operations — and returns the final analysis text so the step is
// durably memoized on resume.
export function registerAiTriageEffect(
  effectRuntime: EffectRuntime,
  provider: LlmProvider = llmProvider
): void {
  effectRuntime.register(
    "ai-triage-tool",
    new LlmEffect(async (input: unknown, ctx) => {
      const { metrics, logs } = input as { metrics: unknown; logs: unknown };

      // Any effect that can emit events can drive the UI. Here the LLM effect
      // pushes A2UI patches into the "ui" surface as tokens arrive.
      const ui = createA2UIEmitter((eventType, payload) => ctx.emit(eventType, payload));

      const request = {
        system:
          "You are an SRE incident-triage assistant. Given database metrics and logs, " +
          "explain the likely root cause and recommend a remediation in 2-3 sentences.",
        messages: [
          {
            role: "user" as const,
            content: `Metrics: ${JSON.stringify(metrics)}\nLogs: ${JSON.stringify(logs)}`,
          },
        ],
      };

      let analysis = "";

      ui.set("aiAnalysis", "");
      ui.set("aiStreaming", true);

      // Prefer streaming so the UI fills in live; fall back to complete().
      if (provider.stream) {
        for await (const chunk of provider.stream(request)) {
          if (chunk.delta) {
            analysis += chunk.delta;
            // grow the surface string — the StreamingText widget re-renders live
            ui.set("aiAnalysis", analysis);
          }
        }
      } else {
        const response = await provider.complete(request);
        analysis = response.content;
        ui.set("aiAnalysis", analysis);
      }

      ui.set("aiStreaming", false);

      return { analysis };
    })
  );
}
