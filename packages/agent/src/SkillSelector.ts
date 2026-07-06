import type { LlmProvider } from "@loom/llm";
import type { SkillRegistry } from "./SkillRegistry";
import type { AgentInput } from "./types";

// Chooses which skills are relevant to an agent turn. Returns skill ids (order
// is not significant — AgentRunner composes them in registry order).
export interface SkillSelector {
  select(input: AgentInput, registry: SkillRegistry): Promise<string[]>;
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
// of id: description. Carries the same replay caveat as the ReAct loop (the LLM
// decision is not recorded); the SKILLS_SELECTED event AgentRunner emits is the
// audit trail and the hook for a future record/replay path.
export function llmSkillSelector(provider: LlmProvider, maxSkills = 3): SkillSelector {
  return {
    async select(input, registry) {
      const skills = registry.all();
      if (skills.length === 0) return [];
      const menu = skills.map((s) => `- ${s.id}: ${s.description}`).join("\n");
      const response = await provider.complete({
        system: `You select the skills relevant to a request. Reply with a comma-separated list of at most ${maxSkills} skill ids from the list, or the word NONE if none fit. Reply with ids only — no prose.`,
        messages: [{ role: "user", content: `Skills:\n${menu}\n\nRequest: ${queryOf(input)}` }],
      });
      const known = new Set(registry.ids());
      return response.content
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((id) => known.has(id))
        .slice(0, maxSkills);
    },
  };
}
