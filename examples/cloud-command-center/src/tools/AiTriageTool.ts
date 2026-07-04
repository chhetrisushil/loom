import { z } from "zod";
import { step$, tool$ } from "@loom/core";

// The AI triage step is an "llm"-kind effect. Its handler is registered in
// setup.ts (registerAiTriageEffect) because it needs the configured LlmProvider
// injected — this keeps the model choice a runtime configuration concern, not a
// hard-coded dependency of the flow.
export const AiTriageTool = tool$({
  id: "ai-triage-tool",
  name: "AI Incident Triage",
  description: "Uses the configured LLM to analyze metrics + logs and recommend a remediation",
  kind: "llm",
  inputSchema: z.object({
    metrics: z.unknown(),
    logs: z.unknown(),
  }),
  outputSchema: z.object({ analysis: z.string() }),
});

export const AiTriageStep = step$({
  id: "ai-triage",
  name: "AI Incident Triage",
  toolId: "ai-triage-tool",
  inputSchema: z.object({
    metrics: z.unknown(),
    logs: z.unknown(),
  }),
  outputSchema: z.object({ analysis: z.string() }),
});
