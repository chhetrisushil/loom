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
 * events when you need them apart. Ids are what was RECORDED: `upfront` is what the selector NAMED, which
 * can include ids the registry did not have (the loop skipped those at run time), so it is not "which
 * skills ran" for an unknown id. `activated` lists accepted activations only.
 *
 * A decision with NO `source` whose id ends in `#skills` is treated as `agentLoop$`'s up-front selection
 * (that is how the loop records it). A decision recorded with any other `source`, including one an app
 * made itself with `ctx.decide`, is never read as a selection. `byLoop` is an ordinary object.
 */
export function selectedSkillsOf(
  events: readonly EventEnvelope[],
  options: { loopId?: string } = {}
): SelectedSkills {
  // A Map while collecting, so a loop id such as `__proto__` is just a key; `Object.fromEntries` then
  // makes them own properties of an ordinary object (no null prototype to surprise `hasOwnProperty`).
  const loops = new Map<string, LoopSkills>();
  const loop = (id: string): LoopSkills => {
    let l = loops.get(id);
    if (l === undefined) {
      l = { upfront: [], activated: [] };
      loops.set(id, l);
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
  const out: SelectedSkills = { upfront: [], activated: [], byLoop: Object.fromEntries(loops) };
  for (const l of loops.values()) {
    for (const s of l.upfront) push(out.upfront, s);
    for (const s of l.activated) push(out.activated, s);
  }
  return out;
}
