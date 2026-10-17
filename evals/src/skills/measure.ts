import {
  Bm25ToolRanker,
  type SkillSearchHit,
  type ToolRankerFactory,
  ToolSearchSession,
} from "@loom/agent";
import { type SkillDefinition, instructions$, skill$ } from "@loom/core";
import { type Scores, type Thresholds, toRows } from "../gate";
import { hitAtK, mean } from "../metrics";
import type { MetricRow } from "../scoreboard";
import { INTENTS } from "./intents";
import { SKILLS, type SkillSpec } from "./skills";

// ── The skill-discovery subject ───────────────────────────────────────────────
//
// `skillActivation.discovery: "search"` makes skills findable through `search_tools` (ADR 0125 D12/D13).
// The activation SESSION is internal, so this drives the part that does the ranking and needs no model:
// a `ToolSearchSession` with the activation catalog attached through its public `attachSkills`. With no
// tools in the catalog every hit is a skill, found under `output.skills`.

export type SkillRankFn = (intent: string) => Promise<string[]>;

export const skillDefinitions = (specs: readonly SkillSpec[] = SKILLS): SkillDefinition[] =>
  specs.map((s) =>
    skill$({
      id: s.id,
      name: s.name,
      description: s.description,
      instructions: instructions$(`Instructions for ${s.id}.`),
      ...(s.tags !== undefined && { tags: [...s.tags] }),
    })
  );

const passThrough = {
  decide: async <T>(_key: string, fn: () => Promise<T> | T): Promise<T> => fn(),
};

/** The two modes ADR 0125 D13 defines: one combined index, or two rankers (a host `skillRanker`). */
export type SkillMode = "combined" | "two-ranker";

/** A host skill ranker factory that is the real BM25F over the sanitized skill docs. */
export const bm25SkillRanker: ToolRankerFactory = (docs) => new Bm25ToolRanker(docs);

export function skillSearchWith(skills: readonly SkillDefinition[], mode: SkillMode): SkillRankFn {
  return async (intent) => {
    const session = new ToolSearchSession({ catalog: [], maxPerSearch: 10 }, []);
    session.attachSkills({
      discoverable: () => skills,
      isActive: () => false,
      activeCount: 0,
      activationName: "activate_skill",
      ...(mode === "two-ranker" && { skillRanker: bm25SkillRanker }),
    });
    const res = await session.run(passThrough as never, "eval", { query: intent, limit: 10 });
    if (res.isError)
      throw new Error(`skill search failed for "${intent}": ${JSON.stringify(res.output)}`);
    return ((res.output as { skills?: SkillSearchHit[] }).skills ?? []).map((s) => s.id);
  };
}

/** Score a skill search over the labelled intents. */
export async function scoreSkills(search: SkillRankFn): Promise<Scores> {
  const hits1: number[] = [];
  const hits3: number[] = [];
  for (const i of INTENTS) {
    const ranked = await search(i.intent);
    hits1.push(hitAtK(ranked, [i.expected], 1));
    hits3.push(hitAtK(ranked, i.acceptable, 3));
  }
  return { "hit@1": mean(hits1), "hit@3": mean(hits3) };
}

/** Deterministically shuffle which description belongs to which skill (a rotation by `by`), keeping ids and tags. */
export function withRotatedDescriptions(by = 1): SkillDefinition[] {
  return SKILLS.map((s, i) => ({
    ...skillDefinitions([s])[0],
    description: (SKILLS[(i + by) % SKILLS.length] as SkillSpec).description,
  })) as SkillDefinition[];
}

export async function measureSkills(thresholds: Thresholds): Promise<MetricRow[]> {
  const out: MetricRow[] = [];
  for (const mode of ["combined", "two-ranker"] as const) {
    out.push(
      ...toRows(
        `skills/${mode}`,
        await scoreSkills(skillSearchWith(skillDefinitions(), mode)),
        thresholds
      )
    );
  }
  return out;
}
