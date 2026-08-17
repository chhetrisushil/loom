import { handler$, step$ } from "@loom/core";
import type { AgentDefinition, StepDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import { z } from "zod";
import { AgentRunner } from "./AgentRunner";
import type { AgentInput, AgentOutput } from "./types";

export interface AgentStepConfig {
  id: string;
  name?: string;
  agent: AgentDefinition;
  provider: LlmProvider;
  effectRuntime: EffectRuntime;
  maxIterations?: number;
  systemPrompt?: string;
}

export function agentStep$(config: AgentStepConfig): StepDefinition<AgentInput, AgentOutput> {
  const runner = new AgentRunner({
    definition: config.agent,
    provider: config.provider,
    effectRuntime: config.effectRuntime,
    ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
    ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
  });

  return step$({
    id: config.id,
    name: config.name ?? config.id,
    // R3 — the agent's declared tool menu IS this step's reachable effect set. One
    // step, and a model picks from `tools` at run time, so without this the flow
    // contributes NO effects and every static check over it passes vacuously.
    // `@loom/verify` reads this; the runtime still authorizes each call at the K2
    // floor, which is the half that was never in question.
    reachableTools: config.agent.tools.map((t) => ({ id: t.id, kind: t.kind })),
    inputSchema: z.object({
      prompt: z.string(),
      context: z.unknown().optional(),
    }) as z.ZodType<AgentInput>,
    outputSchema: z.object({
      content: z.string(),
      toolCallLog: z.array(
        z.object({
          iteration: z.number(),
          toolName: z.string(),
          toolInput: z.unknown(),
          toolOutput: z.unknown(),
        })
      ),
      iterations: z.number(),
    }) as z.ZodType<AgentOutput>,
    handler: handler$((input: AgentInput, ctx) => runner.run(input, ctx)),
  });
}
