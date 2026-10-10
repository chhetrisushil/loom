import type { SkillDefinition } from "@loom/core";
import { lexicalTerms } from "./lexicalTerms";

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
}

// A registry of Skills. Only the cheap metadata (id/name/description/tags) is
// held here for selection; the instructions body stays lazy until a skill is
// chosen. Mirrors CapabilityCatalog — a deterministic keyword scorer backs the
// offline, replay-safe selection path.
/**
 * How many distinct query terms the keyword scorer counts.
 *
 * Scoring is O(entries x terms) of substring searches, so the query is the multiplier;
 * past a few dozen terms the extra ones are noise rather than signal. Mirrors
 * `@loom/memory`'s `MAX_QUERY_TERMS` in intent — a query is an input, and an input has a
 * bound — without sharing a constant across packages that do not otherwise depend on each
 * other.
 */
const MAX_SCORED_TERMS = 64;

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
    // Deduplicated and capped: the score counts terms the haystack CONTAINS, so repeating
    // a term inflates nothing and only costs another substring search per skill, and an
    // unbounded question is O(skills x terms) of it. Scoring beyond a few dozen terms is
    // noise anyway. First-seen order is preserved; the cap only decides what is dropped.
    const terms = [...new Set(lexicalTerms(query))].slice(0, MAX_SCORED_TERMS);
    const matches: SkillMatch[] = [];
    for (const skill of this.skills.values()) {
      const haystack = [skill.id, skill.name, skill.description, ...(skill.tags ?? [])]
        .join(" ")
        .normalize("NFKC")
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
