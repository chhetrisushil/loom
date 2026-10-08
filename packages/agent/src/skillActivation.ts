import { isTainted } from "@loom/classify";
import { type SkillDefinition, type ToolDefinition, loadInstructions } from "@loom/core";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { z } from "zod";
import type { SkillRegistry } from "./SkillRegistry";
import { toolSpecFor, validateToolInput } from "./toolSchema";

// ── R22 (ADR 0125 D11) — mid-loop skill activation ──────────────────────────────
//
// `agentLoop$` selects skills ONCE, up front. With `skillActivation` the model also sees a cheap,
// bounded index of the skills that were NOT selected and can activate one mid-loop through the
// `activate_skill` meta-tool. The skill's instructions are DELIVERED AS THE RESULT of that call (the
// Agent Skills pattern): the turn-0 system prompt is never rewritten (prompt-cache prefix stays
// stable) and no mid-conversation system message is needed. Its tools join the menu from the next
// step. Like `ToolSearchSession`, this class is ignorant of the transcript and of frames.

/** The `DECISION_RECORDED.source` of an activation. */
export const SOURCE_SKILL_ACTIVATION = "agent-skill-activation";

export const DEFAULT_ACTIVATION_TOOL_NAME = "activate_skill";
export const DEFAULT_MAX_ACTIVE = 5;
export const DEFAULT_MAX_INDEX = 50;
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32 * 1024;
/** Hard ceilings: a host cannot configure its way into an unbounded index, run or result. */
export const MAX_ACTIVE_CEILING = 50;
export const MAX_INDEX_CEILING = 500;
export const MAX_INSTRUCTION_BYTES_CEILING = 1024 * 1024;
/** Characters of a description shown in the index (first line only). */
const MAX_INDEX_DESCRIPTION = 200;
const MAX_INDEX_TAGS = 8;

/** Opt-in mid-loop skill activation for `agentLoop$`. Absent: the run is byte-identical to one without it. */
export interface SkillActivationConfig {
  /**
   * The skills the HOST offers for activation. `"registry"` (default) is the loop's `skills`
   * registry. Skills are HOST-registered author text: never build this from a remote/untrusted
   * declaration. A skill selected up front is not offered again.
   */
  catalog?: "registry" | readonly SkillDefinition[];
  /** Skills the model may activate over the run. Default 5, at most 50. */
  maxActive?: number;
  /** Skills listed in the index (the first N by id; only those can be activated). Default 50, at most 500. */
  maxIndex?: number;
  /** UTF-8 bytes of one skill's instructions; a larger one is refused. Default 32 KiB, at most 1 MiB. */
  maxInstructionBytes?: number;
  /** The meta-tool's name. Default `"activate_skill"`; it must not collide with any tool. */
  toolName?: string;
}

export class SkillActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillActivationError";
    Object.setPrototypeOf(this, SkillActivationError.prototype);
  }
}

const activateInput = z.object({ name: z.string() });

interface Recorded {
  skill: string;
}

function positiveInt(name: string, v: number | undefined, def: number, ceiling: number): number {
  const n = v ?? def;
  if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) {
    throw new SkillActivationError(
      `skillActivation.${name} must be an integer in [1, ${ceiling}] (got ${String(v)})`
    );
  }
  return n;
}

const firstLine = (s: string): string => {
  const line = s.split("\n", 1)[0] as string;
  return line.length > MAX_INDEX_DESCRIPTION ? `${line.slice(0, MAX_INDEX_DESCRIPTION)}…` : line;
};
const UTF8 = new TextEncoder();
const byId = (a: SkillDefinition, b: SkillDefinition): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const error = (code: string, message: string) => ({
  output: { error: { code, message } },
  isError: true as const,
  newlyLoaded: [] as ToolDefinition[],
});

export class SkillActivationSession {
  readonly name: string;
  /** The meta-tool's definition, as the model is offered it. */
  readonly definition: ToolDefinition;
  /** The offered skills, by id, in index (id) order. Only these can be activated. */
  private readonly offered = new Map<string, SkillDefinition>();
  private readonly active = new Set<string>();
  private readonly maxActive: number;
  private readonly maxInstructionBytes: number;

  constructor(
    cfg: SkillActivationConfig,
    opts: {
      /** The loop's `skills` registry (the `"registry"` catalog). */
      registry: SkillRegistry | undefined;
      /** Skills already selected up front: never offered. */
      selected: ReadonlySet<string>;
      /** Every tool name that must not equal the meta-tool's name. */
      reservedNames: Iterable<string>;
    }
  ) {
    this.name = cfg.toolName ?? DEFAULT_ACTIVATION_TOOL_NAME;
    this.maxActive = positiveInt(
      "maxActive",
      cfg.maxActive,
      DEFAULT_MAX_ACTIVE,
      MAX_ACTIVE_CEILING
    );
    const maxIndex = positiveInt("maxIndex", cfg.maxIndex, DEFAULT_MAX_INDEX, MAX_INDEX_CEILING);
    this.maxInstructionBytes = positiveInt(
      "maxInstructionBytes",
      cfg.maxInstructionBytes,
      DEFAULT_MAX_INSTRUCTION_BYTES,
      MAX_INSTRUCTION_BYTES_CEILING
    );
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(this.name)) {
      throw new SkillActivationError("skillActivation.toolName must match [A-Za-z0-9_.:-]{1,64}");
    }
    const catalog = cfg.catalog ?? "registry";
    let source: readonly SkillDefinition[];
    if (catalog === "registry") {
      if (opts.registry === undefined) {
        throw new SkillActivationError(
          'skillActivation.catalog "registry" needs the loop\'s `skills` registry'
        );
      }
      source = opts.registry.all();
    } else {
      source = catalog;
    }
    const seen = new Set<string>();
    const candidates: SkillDefinition[] = [];
    for (const s of source) {
      if (seen.has(s.id)) continue; // first wins
      seen.add(s.id);
      if (!opts.selected.has(s.id)) candidates.push(s);
    }
    candidates.sort(byId);
    for (const s of candidates.slice(0, maxIndex)) this.offered.set(s.id, s);
    const reserved = new Set(opts.reservedNames);
    for (const s of this.offered.values()) for (const t of s.tools ?? []) reserved.add(t.id);
    if (reserved.has(this.name)) {
      throw new SkillActivationError(
        `skillActivation.toolName "${this.name}" collides with another tool`
      );
    }
    this.definition = {
      _tag: "ToolDefinition",
      id: this.name,
      name: this.name,
      description:
        "Activate one of the listed skills by `name`. The result is the skill's instructions, and the tools it brings can be called from the next step on.",
      kind: "tool",
      inputSchema: activateInput.describe("activate_skill input"),
      outputSchema: z.unknown(),
    } as unknown as ToolDefinition;
  }

  /** Whether there is anything to activate (otherwise the meta-tool and index are omitted). */
  get hasOffers(): boolean {
    return this.offered.size > 0;
  }

  get metaSpec(): ReturnType<typeof toolSpecFor> {
    return toolSpecFor(this.definition);
  }

  isActivationCall(toolName: string): boolean {
    return toolName === this.name;
  }

  /** Ids of the skills activated so far, in activation order. */
  activeIds(): string[] {
    return [...this.active];
  }

  /** The index, as appended to the turn-0 system prompt. Deterministic: id order, bounded. */
  indexText(): string {
    const lines = [...this.offered.values()].map((s) => {
      const tags = (s.tags ?? []).slice(0, MAX_INDEX_TAGS);
      return `- ${s.id}: ${firstLine(s.description)}${tags.length > 0 ? ` [${tags.join(", ")}]` : ""}`;
    });
    return `Skills you can activate with the \`${this.name}\` tool (pass the id as \`name\`; the result is the skill's instructions):\n${lines.join("\n")}`;
  }

  /**
   * Run one `activate_skill` call. Returns the tool_result `output`, whether it is an error, and the
   * skill's tools (the caller appends them to the menu, deduped). A refusal records nothing.
   */
  async run(
    ctx: Pick<ExecutionContext, "decide">,
    decisionKey: string,
    input: unknown
  ): Promise<{ output: unknown; isError: boolean; newlyLoaded: ToolDefinition[] }> {
    const v = validateToolInput(activateInput, input);
    if (!v.ok) {
      return error("invalid_tool_input", `Input for tool "${this.name}" must be { name: string }.`);
    }
    const { name } = input as z.infer<typeof activateInput>;
    const skill = this.offered.get(name);
    if (skill === undefined) {
      return error("unknown_skill", `"${name}" is not a skill you can activate.`);
    }
    if (this.active.has(name)) {
      return error("already_active", `Skill "${name}" is already active.`);
    }
    if (this.active.size >= this.maxActive) {
      return error(
        "skill_limit_reached",
        `At most ${this.maxActive} skills can be activated per run.`
      );
    }
    // Loaded BEFORE the decision, so a refusal records nothing. Host-registry author text is
    // trusted, but a value that arrives tainted (ADR 0085) must never become instructions.
    const text: unknown = await loadInstructions(skill.instructions);
    if (typeof text !== "string" || isTainted(text)) {
      return error(
        "instructions_refused",
        `Skill "${name}" has instructions that cannot be delivered.`
      );
    }
    if (UTF8.encode(text).length > this.maxInstructionBytes) {
      return error(
        "instructions_too_large",
        `Skill "${name}" has instructions over the ${this.maxInstructionBytes}-byte limit.`
      );
    }
    const recorded = await ctx.decide<Recorded>(decisionKey, async () => ({ skill: name }), {
      source: SOURCE_SKILL_ACTIVATION,
    });
    // Live and replayed alike the record is re-intersected with what THIS run may activate: a stale
    // or tampered record can refuse, and can never activate anything but the offered skill asked for.
    if (recorded === null || typeof recorded !== "object" || recorded.skill !== name) {
      return error("unknown_skill", `"${name}" is not a skill you can activate.`);
    }
    this.active.add(name);
    return {
      output: {
        skill: name,
        instructions: text,
        ...(skill.tools !== undefined &&
          skill.tools.length > 0 && { tools: skill.tools.map((t) => t.id) }),
      },
      isError: false,
      newlyLoaded: skill.tools ?? [],
    };
  }
}
