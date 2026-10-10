import { isTainted } from "@loom/classify";
import { type SkillDefinition, type ToolDefinition, loadInstructions, sha256Hex } from "@loom/core";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { z } from "zod";
import type { SkillRegistry } from "./SkillRegistry";
import { isTerminalToolError } from "./toolFailure";
import { toolResultContent } from "./toolResultContent";
import { cap, toolSpecFor, validateToolInput } from "./toolSchema";
import {
  type ToolRanker,
  type ToolRankerFactory,
  firstLineOf,
  rankerConfigProblem,
} from "./toolSearch";

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
  /**
   * R22b (ADR 0125 D12) — how the model FINDS a skill. `"index"` (default): the bounded turn-0 index,
   * byte-identical to a run without this option. `"search"`: the index is replaced by one short fixed
   * line; skills are found with `search_tools` (hits under `skills`, never loaded by the search) and
   * loaded with `activate_skill`. `"both"`: the index stays AND search covers skills (so a skill past
   * the index cut is still reachable). `"search"` / `"both"` require `toolSearch`.
   * Searchable skills = the whole catalog minus the upfront-selected ones, NOT limited by
   * `maxIndex` / `maxIndexBytes`. Search is a CONVENIENCE for finding ids, not an authorization step:
   * `activate_skill` accepts ANY catalog skill (minus upfront-selected) by id, whether or not a search
   * returned it; authorization is the catalog. `"both"` with a tiny `maxIndexBytes` is allowed (search
   * covers everything); `"search"` ignores `maxIndexBytes` (there is no index).
   */
  discovery?: "index" | "search" | "both";
  /**
   * R22c (ADR 0125 D13) — rank SKILLS with the host's own ranker. It sees skill docs only: its
   * `rank(query, limit)` returns RAW skill ids (the internal key prefix never reaches it). Needs
   * `discovery: "search" | "both"`. A custom `toolSearch.ranker` ranks tools only and never sees
   * skills; when either custom ranker is present, tools and skills are ranked separately (the skill
   * side defaults to built-in BM25F over skill docs) and a search page interleaves them by rank
   * position, tool first, up to `maxPerSearch` (scores are never mixed). Neither ranker is called on
   * replay. A ranker failure is `search_unavailable` with nothing recorded.
   */
  skillRanker?: ToolRanker | ToolRankerFactory;
}

/** What the activation session needs to know about the loop's `toolSearch` (R22b). */
export interface SearchWiring {
  readonly name: string;
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
  /**
   * ADR 0125 D14 — sha256 (hex) of the instructions the live run delivered. Additive and optional: a
   * record without it (older runs) keeps the old behaviour. A replay (and a re-delivery) compares the
   * current text with it and delivers nothing on a mismatch.
   */
  digest?: string;
  /**
   * ADR 0125 D14 (review round 1) — the UTF-8 length of the delivered instructions AS SERIALIZED (the
   * JSON string, quotes and escapes included: the form they take in the `tool_result`). Additive and
   * optional. When a replay (or re-delivery) cannot deliver the same text, the loop's byte-triggered
   * compaction still MEASURES the activation result at this recorded size, so the trigger fires on
   * the turns the live run's did and the log's `#turn:t:compact` frames keep matching.
   */
  bytes?: number;
  /**
   * ADR 0125 D14 (review round 2) — the UTF-8 length of the WHOLE live activation result as the
   * `tool_result` carried it (envelope, tool-id list and instructions), measured when the live run
   * decided. A replay whose text OR tool list changed measures the result at exactly this size, not
   * at a size rebuilt from the skill as it is now. Additive and optional, bounded on read; a record
   * with `bytes` but without it keeps the round-1 reconstruction (residual: exact only while the
   * tool-id list is unchanged).
   */
  resultBytes?: number;
}

const UTF8 = new TextEncoder();
/** Read-side bound on the tool-id list's share of a recorded `resultBytes` (a sanity cap, not an allocation). */
const MAX_TOOL_LIST_BYTES = 1024 * 1024;
/** UTF-8 length of `text` as the JSON string the `tool_result` carries. */
const wireBytes = (text: string): number => UTF8.encode(JSON.stringify(text)).length;
/** A stand-in string whose JSON form has exactly `bytes` UTF-8 bytes (ASCII, no escapes). */
const standIn = (bytes: number): string => "x".repeat(Math.max(0, bytes - 2));

/** Runtime-neutral (no `node:crypto`: browser bundles include this file); recorded in logs, so the hex must stay byte-identical. */
const sha256 = (text: string): string => sha256Hex(text);

/** Bound for the once-per-skill advisory set (the active set is itself capped by `maxActive`). */
const warnChanged = (id: string, seen: Set<string>): void => {
  if (seen.has(id)) return;
  seen.add(id);
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  proc?.emitWarning?.(
    `Skill "${id.slice(0, 64)}": its instructions changed since the activation was recorded; they were NOT delivered to the model (the recorded activation and its tools stand).`,
    { code: "LOOM_AGENT_SKILL_CHANGED" }
  );
};

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
  /** The offered skills, by id: index-listed (id order) then search-discoverable. Only these can be activated. */
  private readonly offered = new Map<string, SkillDefinition>();
  /** R22b — skills found by search (the catalog minus upfront-selected, id order). Empty in `"index"` mode. */
  private readonly discoverableList: SkillDefinition[] = [];
  readonly discovery: "index" | "search" | "both";
  private readonly searchName: string | undefined;
  /** R22c: the host skill ranker, when configured (the {@link SkillSearchSource} contract). */
  readonly skillRanker: ToolRanker | ToolRankerFactory | undefined;
  private readonly active = new Set<string>();
  /** D14 — the digest each ACTIVE skill's instructions were pinned to (absent: an old record). Bounded by `maxActive`. */
  private readonly digests = new Map<string, string>();
  /** D14 — the recorded wire size of each pinned skill's delivered instructions (absent: an old record). */
  private readonly sizes = new Map<string, number>();
  private readonly warned = new Set<string>();
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
      /** The loop's `toolSearch`, when configured (required by `discovery: "search" | "both"`). */
      search?: SearchWiring;
    }
  ) {
    this.name = cfg.toolName ?? DEFAULT_ACTIVATION_TOOL_NAME;
    const discovery = cfg.discovery ?? "index";
    if (discovery !== "index" && discovery !== "search" && discovery !== "both") {
      throw new SkillActivationError(
        `skillActivation.discovery must be "index", "search" or "both" (got ${String(discovery)})`
      );
    }
    if (discovery !== "index") {
      if (opts.search === undefined) {
        throw new SkillActivationError(
          `skillActivation.discovery "${discovery}" needs \`toolSearch\` (skills are found through search_tools)`
        );
      }
      if (cfg.skillRanker !== undefined) {
        const problem = rankerConfigProblem("skillActivation.skillRanker", cfg.skillRanker);
        if (problem !== undefined) throw new SkillActivationError(problem);
      }
      this.searchName = opts.search.name;
    } else if (cfg.skillRanker !== undefined) {
      throw new SkillActivationError(
        'skillActivation.skillRanker needs discovery "search" or "both"'
      );
    }
    this.skillRanker = cfg.skillRanker;
    this.discovery = discovery;
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
    if (discovery !== "index") {
      // Search-discoverable = every candidate: the index cut does not apply (that is the point).
      this.discoverableList.push(...candidates);
      for (const s of candidates) {
        this.offered.set(s.id, s);
      }
    }
    // The index is bounded three ways: skills (maxIndex), characters per field, total bytes. What
    // does not fit is not offered (so it cannot be activated blind) and is counted in a "+N more" line.
    // In `"search"` mode there is no index (one fixed line), so nothing is listed and nothing is cut.
    const listed = discovery === "search" ? [] : candidates.slice(0, maxIndex);
    let bytes = UTF8.encode(this.header()).length + MORE_RESERVE;
    for (const s of listed) {
      const line = this.lineFor(s);
      const n = UTF8.encode(line).length + 1;
      if (bytes + n > maxIndexBytes) break;
      bytes += n;
      this.offered.set(s.id, s);
      this.lines.push(line);
    }
    this.omitted = discovery === "search" ? 0 : candidates.length - this.lines.length;
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
    const lead =
      discovery === "index"
        ? "Activate one of the listed skills by `name`."
        : `Activate a skill by \`name\` (any catalog skill by id; \`${this.searchName}\` helps find ids but is not required).`;
    this.definition = {
      _tag: "ToolDefinition",
      id: this.name,
      name: this.name,
      description: `${lead} The result is the skill's instructions, and the tools it brings can be called from the next step on. Activating an already-active skill returns its instructions again.`,
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

  /** R22b — the skills search may return, in id order (empty unless `discovery` is `"search"` / `"both"`). */
  discoverable(): readonly SkillDefinition[] {
    return this.discoverableList;
  }

  /** The meta-tool's name (the {@link SkillSearchSource} contract). */
  get activationName(): string {
    return this.name;
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  get activeCount(): number {
    return this.active.size;
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
    if (this.discovery === "search") {
      // One fixed line: no skill text reaches the prompt at all, whatever the registry holds.
      return `Skills (specialised instructions) exist beyond your tools: find them with the \`${this.searchName}\` tool (they come back under \`skills\`) and load one with the \`${this.name}\` tool, passing its id as \`name\`.`;
    }
    const more =
      this.omitted > 0
        ? [
            this.discovery === "both"
              ? `- (+${this.omitted} more skills not listed; find them with \`${this.searchName}\`)`
              : `- (+${this.omitted} more skills not listed)`,
          ]
        : [];
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
  ): Promise<{
    output: unknown;
    isError: boolean;
    newlyLoaded: ToolDefinition[];
    /**
     * The size compaction's byte trigger counts for this result when it is NOT the result the live
     * run saw (D14: a replay / re-delivery whose text changed). Absent: measure the result itself.
     */
    virtualBytes?: number;
  }> {
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
      const pinned = this.digests.get(name);
      // The size the successful re-delivery would have had (known only for a pinned record that
      // carries `bytes`): an error here still counts as that for the compaction trigger.
      const recordedSize = this.sizes.get(name);
      const virtualBytes =
        recordedSize === undefined
          ? undefined
          : UTF8.encode(
              toolResultContent(this.name, {
                skill: name,
                instructions: standIn(recordedSize),
                note: "Already active; instructions repeated.",
              }) as string
            ).length;
      if (!again.ok) {
        return {
          ...error(again.code, again.message),
          ...(virtualBytes !== undefined && { virtualBytes }),
        };
      }
      if (pinned !== undefined && sha256(again.text) !== pinned) {
        warnChanged(name, this.warned);
        return {
          ...error("instructions_changed", this.refusalMessage("instructions_changed", name)),
          ...(virtualBytes !== undefined && { virtualBytes }),
        };
      }
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
          const liveTools = skill.tools ?? [];
          const resultBytes = UTF8.encode(
            toolResultContent(this.name, {
              skill: name,
              instructions: d.text,
              ...(liveTools.length > 0 && { tools: liveTools.map((t) => t.id) }),
            }) as string
          ).length;
          return { skill: name, digest: sha256(d.text), bytes: wireBytes(d.text), resultBytes };
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
    // The digest the instructions are pinned to: only a STRING is honoured (a record without one, or
    // with junk, is an old record: today's behaviour, byte for byte).
    const pinned = typeof recorded.digest === "string" ? recorded.digest : undefined;
    if (pinned !== undefined) this.digests.set(name, pinned);
    const recordedBytes =
      typeof recorded.bytes === "number" &&
      Number.isSafeInteger(recorded.bytes) &&
      recorded.bytes >= 2 &&
      recorded.bytes <= 6 * this.maxInstructionBytes + 2
        ? recorded.bytes
        : undefined;
    if (pinned !== undefined && recordedBytes !== undefined) this.sizes.set(name, recordedBytes);
    const tools = skill.tools ?? [];
    // What the live run's result weighed, when this replay cannot reproduce it (see `Recorded.bytes`).
    // The whole live result's size, when recorded: exact whatever changed since (text, tool ids).
    const recordedResult =
      typeof recorded.resultBytes === "number" &&
      Number.isSafeInteger(recorded.resultBytes) &&
      recorded.resultBytes >= (recordedBytes ?? 2) &&
      recorded.resultBytes <= 6 * this.maxInstructionBytes + 2 + MAX_TOOL_LIST_BYTES
        ? recorded.resultBytes
        : undefined;
    const virtualBytes =
      pinned !== undefined && recordedResult !== undefined
        ? recordedResult
        : pinned !== undefined && recordedBytes !== undefined
          ? UTF8.encode(
              toolResultContent(this.name, {
                skill: name,
                instructions: standIn(recordedBytes),
                ...(tools.length > 0 && { tools: tools.map((t) => t.id) }),
              }) as string
            ).length
          : undefined;
    if (d.ok && live.text === undefined && pinned !== undefined && sha256(d.text) !== pinned) {
      // A replay whose current text is not what the recorded run delivered: deliver nothing new.
      warnChanged(name, this.warned);
      return {
        output: {
          error: {
            code: "instructions_changed",
            message: this.refusalMessage("instructions_changed", name),
          },
          ...(tools.length > 0 && { tools: tools.map((t) => t.id) }),
        },
        isError: true,
        newlyLoaded: tools,
        ...(virtualBytes !== undefined && { virtualBytes }),
      };
    }
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
        ...(virtualBytes !== undefined && { virtualBytes }),
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
      // A replay delivering the same text under a CHANGED tool list weighs differently from the live
      // result; the recorded whole-result size keeps the trigger where the live run's was.
      ...(live.text === undefined &&
        recordedResult !== undefined &&
        virtualBytes !== undefined && { virtualBytes }),
    };
  }

  private refusalMessage(code: string, name: string): string {
    if (code === "instructions_unavailable") {
      return `Skill "${cap(name)}" has instructions that could not be loaded right now.`;
    }
    if (code === "instructions_changed") {
      return `Skill "${cap(name)}" is active, but its instructions changed since they were first delivered, so they are not delivered again.`;
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
