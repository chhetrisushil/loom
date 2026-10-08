import { isTainted } from "@loom/classify";
import { type SkillDefinition, type ToolDefinition, loadInstructions } from "@loom/core";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { z } from "zod";
import type { SkillRegistry } from "./SkillRegistry";
import { isTerminalToolError } from "./toolFailure";
import { cap, toolSpecFor, validateToolInput } from "./toolSchema";
import { firstLineOf } from "./toolSearch";

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
/** Characters of a skill id / one tag shown in the index. A longer or unprintable id is not offered at all. */
const MAX_INDEX_ID_CHARS = 64;
const MAX_INDEX_TAG_CHARS = 32;
export const DEFAULT_MAX_INDEX_BYTES = 8 * 1024;
export const MAX_INDEX_BYTES_CEILING = 128 * 1024;
/** An id that could break the one-skill-per-line index (control, format or line-separator characters). */
const UNLISTABLE_ID = /[\p{C}\u2028\u2029]/u;

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
  /**
   * UTF-8 bytes of the whole index in the system prompt. Skills past it (in id order) are summarised
   * as "+N more" and cannot be activated. Default 8 KiB, at most 128 KiB.
   */
  maxIndexBytes?: number;
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
  /**
   * Set when the live attempt was REFUSED on the skill's instructions (`instructions_refused` /
   * `instructions_too_large`). The verdict is recorded, so a replay reproduces it whatever the
   * registry holds now (ADR 0125 D11, review round 1).
   */
  refused?: string;
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

/** Thrown inside the decider when the instructions could not be LOADED live: nothing is recorded. */
class InstructionsUnavailable extends Error {}

const REFUSAL_CODES = new Set(["instructions_refused", "instructions_too_large"]);
const UTF8 = new TextEncoder();
/** Bytes held back for the "+N more" line. */
const MORE_RESERVE = 48;
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
  /** The index lines (one per offered skill, id order) and how many skills the byte cap left out. */
  private readonly lines: string[] = [];
  private omitted = 0;
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
    const maxIndexBytes = positiveInt(
      "maxIndexBytes",
      cfg.maxIndexBytes,
      DEFAULT_MAX_INDEX_BYTES,
      MAX_INDEX_BYTES_CEILING
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
      if (opts.selected.has(s.id)) continue;
      // An id the index cannot show whole and on one line cannot be named by the model: not offered.
      if (s.id.length > MAX_INDEX_ID_CHARS || UNLISTABLE_ID.test(s.id)) continue;
      candidates.push(s);
    }
    candidates.sort(byId);
    // The index is bounded three ways: skills (maxIndex), characters per field, total bytes. What
    // does not fit is not offered (so it cannot be activated blind) and is counted in a "+N more" line.
    const listed = candidates.slice(0, maxIndex);
    let bytes = UTF8.encode(this.header()).length + MORE_RESERVE;
    for (const s of listed) {
      const line = this.lineFor(s);
      const n = UTF8.encode(line).length + 1;
      if (bytes + n > maxIndexBytes) break;
      bytes += n;
      this.offered.set(s.id, s);
      this.lines.push(line);
    }
    this.omitted = candidates.length - this.offered.size;
    if (candidates.length > 0 && this.offered.size === 0) {
      throw new SkillActivationError(
        `skillActivation.maxIndexBytes (${maxIndexBytes}) is too small: not even one skill fits the index (the header alone needs ${bytes} bytes)`
      );
    }
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
        "Activate one of the listed skills by `name`. The result is the skill's instructions, and the tools it brings can be called from the next step on. Activating an already-active skill returns its instructions again.",
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

  /** Ids of every tool the offered skills bring (the meta-tools' names must not collide with them). */
  offeredToolIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.offered.values()) for (const t of s.tools ?? []) ids.add(t.id);
    return ids;
  }

  private header(): string {
    return `Skills you can activate with the \`${this.name}\` tool (pass the id as \`name\`; the result is the skill's instructions):`;
  }

  private lineFor(s: SkillDefinition): string {
    const tags = (s.tags ?? [])
      .filter((x): x is string => typeof x === "string")
      .slice(0, MAX_INDEX_TAGS)
      .map((x) => firstLineOf(x.trim(), MAX_INDEX_TAG_CHARS))
      .filter((x) => x !== "");
    return `- ${s.id}: ${firstLineOf(String(s.description), MAX_INDEX_DESCRIPTION)}${tags.length > 0 ? ` [${tags.join(", ")}]` : ""}`;
  }

  /** The index, as appended to the turn-0 system prompt. Deterministic: id order, bounded in bytes. */
  indexText(): string {
    const more = this.omitted > 0 ? [`- (+${this.omitted} more skills not listed)`] : [];
    return [this.header(), ...this.lines, ...more].join("\n");
  }

  /**
   * Run one `activate_skill` call. Returns the tool_result `output`, whether it is an error, and the
   * skill's tools (the caller appends them to the menu, deduped). A refusal on the skill's instructions
   * records its verdict; the other refusals (unknown, over the cap) record nothing.
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
      return error("unknown_skill", `"${cap(name)}" is not a skill you can activate.`);
    }
    if (this.active.has(name)) {
      // Re-delivery, not re-activation: the instructions are returned AGAIN (after compaction folded
      // the first result into a summary they would otherwise be unrecoverable). Nothing is recorded,
      // no tools are added and it does not count against `maxActive`.
      const again = await this.deliverable(skill);
      if (!again.ok) return error(again.code, again.message);
      return {
        output: {
          skill: name,
          instructions: again.text,
          note: "Already active; instructions repeated.",
        },
        isError: false,
        newlyLoaded: [],
      };
    }
    if (this.active.size >= this.maxActive) {
      return error(
        "skill_limit_reached",
        `At most ${this.maxActive} skills can be activated per run.`
      );
    }
    // The instructions verdict is part of the RECORDED decision: a live refusal records
    // `{ skill, refused }`, so a replay reproduces it whatever the registry holds by then; a live
    // acceptance records `{ skill }` and a replay honours it even if the text has since changed.
    const live: { text?: string } = {};
    let recorded: Recorded;
    try {
      recorded = await ctx.decide<Recorded>(
        decisionKey,
        async () => {
          const d = await this.deliverable(skill);
          // A load FAILURE is not a verdict on the text: throw so nothing is recorded (a later
          // attempt can succeed). The throw is caught below; a terminal error never reaches here.
          if (!d.ok && d.code === "instructions_unavailable") throw new InstructionsUnavailable();
          if (!d.ok) return { skill: name, refused: d.code };
          live.text = d.text;
          return { skill: name };
        },
        { source: SOURCE_SKILL_ACTIVATION }
      );
    } catch (err) {
      if (err instanceof InstructionsUnavailable) {
        return error(
          "instructions_unavailable",
          this.refusalMessage("instructions_unavailable", name)
        );
      }
      throw err;
    }
    // Live and replayed alike the record is re-intersected with what THIS run may activate: a stale
    // or tampered record can refuse, and can never activate anything but the offered skill asked for.
    if (recorded === null || typeof recorded !== "object" || recorded.skill !== name) {
      return error("unknown_skill", `"${cap(name)}" is not a skill you can activate.`);
    }
    if (recorded.refused !== undefined) {
      const code = REFUSAL_CODES.has(recorded.refused) ? recorded.refused : "instructions_refused";
      return error(code, this.refusalMessage(code, name));
    }
    // The activation stands. On a replay the text is loaded now; if it no longer passes the checks
    // the tools still join the menu (consistent with the record) and the result says why there are
    // no instructions.
    const d =
      live.text !== undefined
        ? ({ ok: true, text: live.text } as const)
        : await this.deliverable(skill);
    this.active.add(name);
    const tools = skill.tools ?? [];
    if (!d.ok) {
      return {
        output: {
          error: {
            code: "instructions_unavailable",
            message: `Skill "${cap(name)}" was activated, but its instructions can no longer be delivered (they changed since the activation was recorded).`,
          },
          ...(tools.length > 0 && { tools: tools.map((t) => t.id) }),
        },
        isError: true,
        newlyLoaded: tools,
      };
    }
    return {
      output: {
        skill: name,
        instructions: d.text,
        ...(tools.length > 0 && { tools: tools.map((t) => t.id) }),
      },
      isError: false,
      newlyLoaded: tools,
    };
  }

  private refusalMessage(code: string, name: string): string {
    if (code === "instructions_unavailable") {
      return `Skill "${cap(name)}" has instructions that could not be loaded right now.`;
    }
    return code === "instructions_too_large"
      ? `Skill "${cap(name)}" has instructions over the ${this.maxInstructionBytes}-byte limit.`
      : `Skill "${cap(name)}" has instructions that cannot be delivered.`;
  }

  /** Load the skill's instructions and check them: a string, not tainted (ADR 0085), within the byte cap. */
  private async deliverable(
    skill: SkillDefinition
  ): Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }> {
    let text: unknown;
    try {
      text = await loadInstructions(skill.instructions);
    } catch (err) {
      // R10: a failing load is feedback (a fixed reason, never the error text) unless it is terminal
      // (cancellation, kill switch, quota, a park...), which must reach the runtime.
      if (isTerminalToolError(err)) throw err;
      return {
        ok: false,
        code: "instructions_unavailable",
        message: this.refusalMessage("instructions_unavailable", skill.id),
      };
    }
    if (typeof text !== "string" || isTainted(text)) {
      return {
        ok: false,
        code: "instructions_refused",
        message: this.refusalMessage("instructions_refused", skill.id),
      };
    }
    if (UTF8.encode(text).length > this.maxInstructionBytes) {
      return {
        ok: false,
        code: "instructions_too_large",
        message: this.refusalMessage("instructions_too_large", skill.id),
      };
    }
    return { ok: true, text };
  }
}
