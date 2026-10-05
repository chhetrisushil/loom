import { guardRequest } from "@loom/llm";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import type { SkillRegistry } from "./SkillRegistry";
import type { AgentInput } from "./types";

// Chooses which skills are relevant to an agent turn. Returns skill ids (order
// is not significant — AgentRunner composes them in registry order).
export interface SkillSelector {
  select(
    input: AgentInput,
    registry: SkillRegistry,
    context?: SkillSelectorContext
  ): Promise<string[]>;
  /**
   * R9 — `true` for a selector that calls a model THROUGH THE EFFECT RING (see
   * {@link llmSkillSelector}). Such a selector needs a {@link SkillSelectorContext}, which only
   * `agentLoop$` can provide (it holds an `ExecutionContext`); `agentLoop$` also journals the
   * call as a durable frame instead of wrapping the selection in `ctx.decide`, so the model's
   * spend is charged to the execution and a replay serves the recorded response.
   */
  readonly effectBacked?: boolean;
}

/** What `agentLoop$` hands an effect-backed selector: the model call, resolved as an effect. */
export interface SkillSelectorContext {
  /**
   * Run the registered effect `toolId` on `request` as a durable frame of the calling
   * execution: authorized (K2), metered, kill-switched, `guardRequest`-checked, journaled.
   */
  invoke(toolId: string, request: SkillSelectionRequest): Promise<LlmResponse>;
}

/** The request an effect-backed selector issues (the `createAgentModelEffect` payload shape). */
export interface SkillSelectionRequest {
  system: string;
  messages: { role: "user"; content: string }[];
}

function queryOf(input: AgentInput): string {
  return input.context != null ? `${input.prompt}\n${JSON.stringify(input.context)}` : input.prompt;
}

// Default selector: top-N by the registry's deterministic keyword score. Same
// input → same skills, so a replayed execution reconstructs the same prompt.
export function deterministicSkillSelector(maxSkills = 3): SkillSelector {
  return {
    async select(input, registry) {
      return registry
        .find(queryOf(input))
        .slice(0, maxSkills)
        .map((m) => m.skill.id);
    },
  };
}

// Opt-in model-driven selector: the model picks relevant skill ids from a menu
// of id: description.
//
// TWO forms, because the first one is outside the effect ring:
//
//  - `llmSkillSelector(provider, max)` calls `provider.complete` DIRECTLY. No authorizer sees
//    it, no metering or quota, no kill switch (`guardRequest` does run). It remains for back-compat; under
//    `@loom/app`'s strict profile prefer the form below.
//
//  - `llmSkillSelector({ toolId, maxSkills })` resolves the call through the EffectRuntime by
//    `toolId` (register `createAgentModelEffect(provider)` under it), so every one of those
//    applies. It is `effectBacked`: only `agentLoop$` can run it (it needs an execution to
//    journal the call in), and `AgentRunner` rejects it at construction rather than silently
//    falling back to an unguarded call.
export function llmSkillSelector(provider: LlmProvider, maxSkills?: number): SkillSelector;
export function llmSkillSelector(options: {
  toolId: string;
  maxSkills?: number;
}): SkillSelector;
export function llmSkillSelector(
  providerOrOptions: LlmProvider | { toolId: string; maxSkills?: number },
  maxSkillsArg = 3
): SkillSelector {
  const system = (max: number): string =>
    `You select the skills relevant to a request. Reply with a comma-separated list of at most ${max} skill ids from the list, or the word NONE if none fit. Reply with ids only — no prose.`;
  const userMessage = (input: AgentInput, registry: SkillRegistry): string => {
    const menu = registry
      .all()
      .map((s) => `- ${s.id}: ${s.description}`)
      .join("\n");
    return `Skills:\n${menu}\n\nRequest: ${queryOf(input)}`;
  };
  const parse = (content: string, registry: SkillRegistry, max: number): string[] => {
    const known = new Set(registry.ids());
    return content
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((id) => known.has(id))
      .slice(0, max);
  };

  if ("toolId" in providerOrOptions) {
    const { toolId } = providerOrOptions;
    const max = providerOrOptions.maxSkills ?? 3;
    return {
      effectBacked: true,
      async select(input, registry, context) {
        if (registry.all().length === 0) return [];
        if (context === undefined) {
          throw new Error(
            "llmSkillSelector({ toolId }) is effect-backed and needs the execution context agentLoop$ provides; it cannot run from AgentRunner or a bare select() call. Use agentLoop$, or the provider form llmSkillSelector(provider)."
          );
        }
        const response = await context.invoke(toolId, {
          system: system(max),
          messages: [{ role: "user", content: userMessage(input, registry) }],
        });
        return parse(response.content, registry, max);
      },
    };
  }

  const provider = providerOrOptions;
  return {
    async select(input, registry) {
      if (registry.all().length === 0) return [];
      // The prompt boundary still applies on this form (a skill description is third-party
      // text); it is the authorizer/metering/kill switch that this form cannot reach.
      const response = await provider.complete(
        guardRequest({
          system: system(maxSkillsArg),
          messages: [{ role: "user", content: userMessage(input, registry) }],
        })
      );
      return parse(response.content, registry, maxSkillsArg);
    },
  };
}
