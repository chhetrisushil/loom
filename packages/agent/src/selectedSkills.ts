import type { EventEnvelope } from "@loom/core";
import { SOURCE_SKILL_ACTIVATION } from "./skillActivation";

// Which skills did `agentLoop$` run with? The loop records both choices as DECISIONS (there is no
// SKILLS_SELECTED event): the up-front selection as `<loopId>#skills`, each mid-loop activation as
// `<loopId>#turn:<i>:tool:<j>:skill` stamped `source: SOURCE_SKILL_ACTIVATION`. Those decision ids are
// internal naming; this reader is the supported way to see them. It is a pure function over events, so
// it works on a live log, a replay, or an audit export.

const UPFRONT_SUFFIX = "#skills";
const ACTIVATION_ID = /^(.*)#turn:\d+:tool:\d+:skill$/s;

/** The skills one loop ran with. */
export interface LoopSkills {
  /** Selected before turn 0 (their instructions are in the system prompt), in recorded order. */
  upfront: string[];
  /** Activated mid-loop with `activate_skill` and ACCEPTED (a refused activation is not listed), in activation order. */
  activated: string[];
}

/** {@link LoopSkills} over every loop considered, plus the same split per loop id. */
export interface SelectedSkills extends LoopSkills {
  /** Keyed by the loop id (`AgentLoopConfig.loopId`, default the agent definition id). */
  byLoop: Record<string, LoopSkills>;
}

/**
 * The skills `agentLoop$` selected, read from the recorded decisions in `events`.
 *
 * `events` may hold one execution's log or several; pass `{ loopId }` to read one loop. The top-level
 * `upfront` / `activated` are the (deduplicated, order-preserving) union over the loops considered;
 * `byLoop` keeps them apart. Two executions that share a loop id are merged, so pass one execution's
 * events when you need them apart. Ids are what was RECORDED: a selector may name a skill the registry
 * has since dropped, and the loop skipped it at run time.
 */
export function selectedSkillsOf(
  events: readonly EventEnvelope[],
  options: { loopId?: string } = {}
): SelectedSkills {
  const byLoop: Record<string, LoopSkills> = Object.create(null) as Record<string, LoopSkills>;
  const loop = (id: string): LoopSkills => {
    let l = byLoop[id];
    if (l === undefined) {
      l = { upfront: [], activated: [] };
      byLoop[id] = l;
    }
    return l;
  };
  const push = (to: string[], id: string): void => {
    if (!to.includes(id)) to.push(id);
  };
  for (const e of events) {
    if (e.eventType !== "DECISION_RECORDED") continue;
    const p = e.payload as { decisionId?: unknown; source?: unknown; choice?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.decisionId !== "string") continue;
    const id = p.decisionId;
    if (p.source === SOURCE_SKILL_ACTIVATION) {
      const m = ACTIVATION_ID.exec(id);
      const c = p.choice as { skill?: unknown; refused?: unknown } | null;
      if (m?.[1] === undefined || c === null || typeof c !== "object") continue;
      if (options.loopId !== undefined && m[1] !== options.loopId) continue;
      if (typeof c.skill !== "string" || c.refused !== undefined) continue;
      push(loop(m[1]).activated, c.skill);
    } else if (p.source === undefined && id.endsWith(UPFRONT_SUFFIX) && Array.isArray(p.choice)) {
      const loopId = id.slice(0, -UPFRONT_SUFFIX.length);
      if (options.loopId !== undefined && loopId !== options.loopId) continue;
      for (const s of p.choice) if (typeof s === "string") push(loop(loopId).upfront, s);
    }
  }
  const out: SelectedSkills = { upfront: [], activated: [], byLoop };
  for (const l of Object.values(byLoop)) {
    for (const s of l.upfront) push(out.upfront, s);
    for (const s of l.activated) push(out.activated, s);
  }
  return out;
}
