import type { SkillDefinition } from "@loom/core";

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
}

// A registry of Skills. Only the cheap metadata (id/name/description/tags) is
// held here for selection; the instructions body stays lazy until a skill is
// chosen. Mirrors CapabilityCatalog — a deterministic keyword scorer backs the
// offline, replay-safe selection path.
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): this {
    this.skills.set(skill.id, skill);
    return this;
  }

  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  all(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  ids(): string[] {
    return [...this.skills.keys()];
  }

  // Deterministic keyword scoring over id/name/description/tags. Ties break by
  // id so the ordering is stable for the same query — the property the default
  // selector relies on for replay-safety.
  find(query: string): SkillMatch[] {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);
    const matches: SkillMatch[] = [];
    for (const skill of this.skills.values()) {
      const haystack = [skill.id, skill.name, skill.description, ...(skill.tags ?? [])]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > 0) matches.push({ skill, score });
    }
    return matches.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  }
}
