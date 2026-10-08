import { isTainted, tainted } from "@loom/classify";
import type { SkillDefinition, ToolDefinition } from "@loom/core";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { z } from "zod";
import { isTerminalToolError } from "./toolFailure";
import { WITHHELD_DESCRIPTION, toolSpecFor, validateToolInput } from "./toolSchema";
import { Bm25ToolRanker, type ToolRanker, firstLineOf } from "./toolSearch";

// ── R22 (ADR 0125) — tool search: the loop half ─────────────────────────────────
//
// `ToolSearchSession` owns everything `agentLoop$` needs for the `search_tools` meta-tool except the
// loop's own plumbing: the allowed universe, what is loaded so far, the caps, and one recorded
// decision per search. It is deliberately ignorant of the transcript and of frames.

/** The `DECISION_RECORDED.source` of a search. `@loom/learning` treats it as a recorded fact. */
export const SOURCE_TOOL_SEARCH = "agent-tool-search";

export const DEFAULT_SEARCH_TOOL_NAME = "search_tools";
export const DEFAULT_MAX_PER_SEARCH = 5;
export const DEFAULT_MAX_LOADED = 20;
export const DEFAULT_MAX_SEARCHES = 25;
/** Hard ceilings: a host cannot configure its way into an unbounded menu or result. */
export const MAX_PER_SEARCH_CEILING = 50;
export const MAX_LOADED_CEILING = 200;
export const MAX_SEARCHES_CEILING = 200;
/** Characters of a description shown in a result (first line only). */
const MAX_RESULT_DESCRIPTION = 160;
/** Characters of the query recorded in the decision. */
const MAX_RECORDED_QUERY = 200;
/**
 * A ranker that returns ids this run may not use (a shared ranker over a wider catalog, namespace-hidden
 * tools) can leave a page short after filtering: the ask is widened (doubled) up to this many rounds
 * and this many hits, so one search stays bounded work.
 */
const MAX_RANK_ROUNDS = 4;
const MAX_RANK_ASK = 1000;

/**
 * R22b (ADR 0125 D12) — the index key of a skill. A skill and a tool with the same id must not
 * collide, and tool ids are arbitrary strings (`skill:x` is a legal MCP-style id), so the key starts
 * with a NUL, which no id the model can name carries. A tool whose id starts with it is not indexed.
 */
const SKILL_KEY = "\u0000skill:";

/** What search needs from the skill-activation session (R22b): the discoverable skills and which are active. */
export interface SkillSearchSource {
  discoverable(): readonly SkillDefinition[];
  isActive(id: string): boolean;
  readonly activeCount: number;
  /** The activation meta-tool's name, for the search tool's description. */
  readonly activationName: string;
  /**
   * R22c (ADR 0125 D13) — an optional host ranker over the SKILL docs only (ids are raw skill ids).
   * Present, or a custom `toolSearch.ranker` present: the session ranks tools and skills with two
   * separate rankers and composes the page by rank position, never by mixing scores.
   */
  readonly skillRanker?: ToolRanker | undefined;
}

/** A skill hit as the model reads it. It is NOT loaded: the model calls the activation tool. */
export interface SkillSearchHit {
  kind: "skill";
  id: string;
  description: string;
}

/** Opt-in tool search for `agentLoop$`. Absent: the run is byte-identical to a run without this feature. */
export interface ToolSearchConfig {
  /**
   * The tools the HOST offers for search: the searchable set, and the ONLY set a search can load.
   * The agent's own `definition.tools` and the selected skills' tools are already on the menu from
   * turn 0 (user ruling, ADR 0125 D3), so they are not searched; offering a tool here is the
   * authorization. An id already on the menu is ignored here (the menu's definition wins).
   */
  catalog?: readonly ToolDefinition[];
  /** Catalog ids added to the menu up front, after `definition.tools` and the selected skills' tools. */
  alwaysLoaded?: readonly string[];
  /**
   * An allowlist of searchable id PREFIXES (`"mcp:github:"`). Only matching tools are found;
   * `alwaysLoaded` is the host's explicit choice and is exempt. Absent: every offered tool.
   */
  namespaces?: readonly string[];
  /**
   * HOST-supplied search vocabulary per tool id: `tags` and `aliases` ("bill the customer"). These
   * are trusted (the host wrote them) and apply to ANY tool, including a remote MCP / A2A one,
   * whose own manifest cannot be trusted to declare them. This is the recommended way to close the
   * vocabulary gap between how users phrase a need and how a tool is named, before a semantic
   * ranker. A tool author's own `tool$({ tags, aliases })` is honoured for first-party tools only.
   */
  annotations?: Readonly<Record<string, { tags?: readonly string[]; aliases?: readonly string[] }>>;
  /** Results per search (also the model's `limit` ceiling). Default 5, at most 50. */
  maxPerSearch?: number;
  /** Tools the model can add to the menu over the whole run. Default 20, at most 200. */
  maxLoaded?: number;
  /** Searches per run. Default 25, at most 200. */
  maxSearches?: number;
  /**
   * Cap on the combined JSON size of the loaded tools' model-facing specs (characters). A hit that
   * would exceed it is reported but not loaded. Absent: only `maxLoaded` bounds the menu.
   */
  maxMenuChars?: number;
  /** The meta-tool's name. Default `"search_tools"`; it must not collide with a searchable tool. */
  searchToolName?: string;
  /**
   * The ranking backend. Default: BM25F built over the searchable set (name > tags > description).
   * A prebuilt ranker may be shared across runs (build once for a large catalog); its results are
   * intersected with the allowed set, and RECORDED, so even a non-deterministic ranker (semantic,
   * R18) replays identically.
   *
   * R22c (ADR 0125 D13): a custom ranker ranks TOOLS only. It is never given a skill doc or key; when
   * skill discovery is on, skills are ranked separately (built-in BM25F over skill docs, or
   * `skillActivation.skillRanker`) and the page interleaves the two by rank position.
   */
  ranker?: ToolRanker;
}

const searchInput = z.object({
  query: z.string(),
  limit: z.number().int().min(1).optional(),
});

/** A hit as the model reads it. */
export interface ToolSearchHit {
  name: string;
  description: string;
  /** `false` when the hit was NOT added to the menu (menu full): it cannot be called. */
  loaded: boolean;
}

interface Recorded {
  ranker: string;
  query: string;
  results: string[];
  loaded: string[];
  /** R22b: skill ids found (absent in a record from before skill discovery, or when it is off). */
  skills?: string[];
  /** R22c: the skill ranker's kind, present only when tools and skills were ranked separately. */
  skillRanker?: string;
}

export class ToolSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSearchError";
    Object.setPrototypeOf(this, ToolSearchError.prototype);
  }
}

/**
 * Built from a REMOTE declaration (ADR 0125 D7): the plugin marked it (`origin: "remote"`), or it
 * carries a remote JSON Schema (MCP), or it is an A2A peer. Fails closed: ANY of the three suffices,
 * so a plugin that forgets the marker is still treated as remote.
 */
const isRemote = (t: ToolDefinition): boolean =>
  t.origin === "remote" || t.jsonInputSchema !== undefined || t.kind === "a2a";
/** Its own bytes are not the host's: remote, or a description that arrived tainted (ADR 0085). */
const isThirdParty = (t: ToolDefinition): boolean => isRemote(t) || isTainted(t.description);
/**
 * A description reaches the index / the model only if it is first-party, or a remote one the
 * operator vouched for (`trustJsonSchemaText`). A TAINTED description is never vouched for.
 */
const vouched = (t: ToolDefinition): boolean =>
  !isTainted(t.description) && (!isRemote(t) || t.trustJsonSchemaText === true);
/** The one line a result shows for a tool; an un-vouched description is withheld, never echoed. */
const hitDescription = (t: ToolDefinition): string =>
  vouched(t)
    ? firstLineOf(toolSpecFor(t).description, MAX_RESULT_DESCRIPTION)
    : WITHHELD_DESCRIPTION;

function positiveInt(name: string, v: number | undefined, def: number, ceiling: number): number {
  const n = v ?? def;
  if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) {
    throw new ToolSearchError(
      `toolSearch.${name} must be an integer in [1, ${ceiling}] (got ${String(v)})`
    );
  }
  return n;
}

export class ToolSearchSession {
  readonly name: string;
  /** The meta-tool's definition, as the model is offered it. */
  definition: ToolDefinition;
  private skillSource: SkillSearchSource | undefined;
  /**
   * R22c: tools and skills are ranked by TWO rankers (a custom tool ranker and/or a skill ranker);
   * false = the R22b single combined BM25F index (byte-identical to before).
   */
  private dual = false;
  private skillRanker: ToolRanker | undefined;
  /** Discoverable skills by id (R22b); empty unless skill discovery is attached. */
  private readonly skillById = new Map<string, SkillDefinition>();
  private readonly byId = new Map<string, ToolDefinition>();
  private readonly searchable = new Set<string>();
  private readonly loadedIds = new Set<string>();
  private readonly ranker: ToolRanker;
  private readonly maxPerSearch: number;
  private readonly maxLoaded: number;
  private readonly maxSearches: number;
  private readonly maxMenuChars: number | undefined;
  private searches = 0;
  private searchLoaded = 0;
  private menuChars = 0;
  /** Tools in menu order after the meta-tool: `alwaysLoaded`, then search order. Append-only. */
  readonly initial: ToolDefinition[] = [];

  constructor(
    cfg: ToolSearchConfig,
    /** Tools already on the menu (definition.tools + selected skills' tools), in menu order. */
    preloaded: readonly ToolDefinition[]
  ) {
    this.name = cfg.searchToolName ?? DEFAULT_SEARCH_TOOL_NAME;
    this.maxPerSearch = positiveInt(
      "maxPerSearch",
      cfg.maxPerSearch,
      DEFAULT_MAX_PER_SEARCH,
      MAX_PER_SEARCH_CEILING
    );
    this.maxLoaded = positiveInt(
      "maxLoaded",
      cfg.maxLoaded,
      DEFAULT_MAX_LOADED,
      MAX_LOADED_CEILING
    );
    this.maxSearches = positiveInt(
      "maxSearches",
      cfg.maxSearches,
      DEFAULT_MAX_SEARCHES,
      MAX_SEARCHES_CEILING
    );
    if (
      cfg.maxMenuChars !== undefined &&
      (!Number.isSafeInteger(cfg.maxMenuChars) || cfg.maxMenuChars < 1)
    ) {
      throw new ToolSearchError("toolSearch.maxMenuChars must be a positive integer");
    }
    this.maxMenuChars = cfg.maxMenuChars;
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(this.name)) {
      throw new ToolSearchError("toolSearch.searchToolName must match [A-Za-z0-9_.:-]{1,64}");
    }
    for (const t of preloaded) this.loadedIds.add(t.id);
    for (const t of cfg.catalog ?? []) {
      if (!this.loadedIds.has(t.id) && !this.byId.has(t.id)) this.byId.set(t.id, t);
    }
    if (this.byId.has(this.name) || this.loadedIds.has(this.name)) {
      throw new ToolSearchError(
        `toolSearch.searchToolName "${this.name}" collides with a searchable tool`
      );
    }
    const prefixes = cfg.namespaces;
    for (const t of this.byId.values()) {
      if (prefixes === undefined || prefixes.some((p) => t.id.startsWith(p)))
        this.searchable.add(t.id);
    }
    for (const id of cfg.alwaysLoaded ?? []) {
      const t = this.byId.get(id);
      if (t === undefined) {
        throw new ToolSearchError(
          `toolSearch.alwaysLoaded names "${id}", which is not a \`catalog\` tool`
        );
      }
      if (!this.loadedIds.has(id)) {
        this.loadedIds.add(id);
        this.initial.push(t);
      }
    }
    this.customRanker = cfg.ranker !== undefined;
    this.ranker = cfg.ranker ?? this.lazyBm25(cfg);
    this.definition = {
      _tag: "ToolDefinition",
      id: this.name,
      name: this.name,
      description:
        "Search the available tools by what you need to do and add the best matches to your tool list. " +
        "Call it with a short natural-language `query`; the tools it returns are on your tool list as soon as the result comes back.",
      kind: "tool",
      inputSchema: searchInput.describe("search_tools input"),
      outputSchema: z.unknown(),
    } as unknown as ToolDefinition;
  }

  /** Whether the host supplied its own (tool-only) ranker. */
  readonly customRanker: boolean;

  /**
   * R22b — make the activation catalog's skills searchable. Called once, right after construction,
   * before any search; the (lazy) index then covers tools AND skills. The meta-tool's description
   * gains one sentence; without this call nothing about the session changes.
   */
  attachSkills(src: SkillSearchSource): void {
    // A catalog tool whose id starts with the skill key prefix would be silently unsearchable; refuse
    // it loudly, like a toolName collision.
    for (const id of [...this.byId.keys(), ...this.loadedIds]) {
      if (id.startsWith(SKILL_KEY)) {
        throw new ToolSearchError(
          `toolSearch tool id ${JSON.stringify(id)} collides with the reserved skill-search key prefix while skill discovery is on`
        );
      }
    }
    this.skillSource = src;
    for (const s of src.discoverable()) this.skillById.set(s.id, s);
    this.dual = this.customRanker || src.skillRanker !== undefined;
    if (this.dual) this.skillRanker = src.skillRanker ?? this.lazySkillBm25();
    this.definition = {
      ...this.definition,
      description: `${this.definition.description} It also finds skills (returned under \`skills\`): a skill hit loads nothing by itself; pass its id to \`${src.activationName}\` to get its instructions (search only helps find ids; activation is not gated on it).`,
    } as ToolDefinition;
  }

  /** The default ranker: BM25F over the searchable set, BUILT on the first search (an unused tool costs nothing). */
  private lazyBm25(cfg: ToolSearchConfig): ToolRanker {
    let built: Bm25ToolRanker | undefined;
    const build = (): Bm25ToolRanker =>
      new Bm25ToolRanker([
        ...[...this.searchable]
          .filter((id) => !this.combined || !id.startsWith(SKILL_KEY))
          .map((id) => {
            const t = this.byId.get(id) as ToolDefinition;
            const host = cfg.annotations?.[id];
            // Trusted vocabulary: the host's annotations and the tool author's own — the last ONLY for
            // a first-party tool. A remote tool's self-declared tags/aliases are the server's claims:
            // they count as description-level text, and only if the operator vouched for that text
            // (`trustJsonSchemaText`). An un-vouched tool contributes its id and the host's annotations.
            const own = isThirdParty(t) ? undefined : t;
            const remote =
              isThirdParty(t) && vouched(t) ? [...(t.tags ?? []), ...(t.aliases ?? [])] : [];
            return {
              id,
              // An un-vouched description is not ranked on: it is attacker text.
              ...(vouched(t) && { description: [t.description, ...remote].join(" ") }),
              tags: [...(host?.tags ?? []), ...(own?.tags ?? [])],
              aliases: [...(host?.aliases ?? []), ...(own?.aliases ?? [])],
            };
          }),
        // Skills: host-registry author text, so vouched by construction; ranked with the same fields.
        // Only in the combined (single-index) mode: with two rankers the tool index has no skills.
        ...(this.combined
          ? [...this.skillById.values()].map((s) => ({
              id: SKILL_KEY + s.id,
              description: String(s.description),
              tags: s.tags ?? [],
              aliases: s.aliases ?? [],
            }))
          : []),
      ]);
    return {
      kind: "bm25f",
      rank: (query, limit) => {
        built = built ?? build();
        return built.rank(query, limit);
      },
    };
  }

  /** Skills share the tool index (R22b single-ranker mode). */
  private get combined(): boolean {
    return this.skillById.size > 0 && !this.dual;
  }

  /** R22c: the default skill ranker, BM25F over the skill docs ONLY (raw skill ids), built on first use. */
  private lazySkillBm25(): ToolRanker {
    let built: Bm25ToolRanker | undefined;
    return {
      kind: "bm25f",
      rank: (query, limit) => {
        built =
          built ??
          new Bm25ToolRanker(
            [...this.skillById.values()].map((s) => ({
              id: s.id,
              description: String(s.description),
              tags: s.tags ?? [],
              aliases: s.aliases ?? [],
            }))
          );
        return built.rank(query, limit);
      },
    };
  }

  get metaSpec(): ReturnType<typeof toolSpecFor> {
    return toolSpecFor(this.definition);
  }

  isSearchCall(toolName: string): boolean {
    return toolName === this.name;
  }

  /** Whether `id` is a tool the model may currently call (loaded). */
  isLoaded(id: string): boolean {
    return this.loadedIds.has(id);
  }

  /** Tools put on the menu by something else (a skill activation): search never offers them again. */
  noteLoaded(tools: readonly ToolDefinition[]): void {
    for (const t of tools) this.loadedIds.add(t.id);
  }

  /** Size of a tool's model-facing spec, counted against `maxMenuChars` (always-loaded tools are NOT counted). */
  private specChars(t: ToolDefinition): number {
    return JSON.stringify(toolSpecFor(t)).length;
  }

  /**
   * Run one `search_tools` call. Returns the tool_result `output`, whether it is an error, and the
   * tools newly added to the menu (the caller appends them, in this order).
   */
  async run(
    ctx: Pick<ExecutionContext, "decide">,
    decisionKey: string,
    input: unknown
  ): Promise<{ output: unknown; isError: boolean; newlyLoaded: ToolDefinition[] }> {
    const v = validateToolInput(searchInput, input);
    if (!v.ok) {
      return {
        output: {
          error: {
            code: "invalid_tool_input",
            message: `Input for tool "${this.name}" must be { query: string, limit?: positive integer }.`,
          },
        },
        isError: true,
        newlyLoaded: [],
      };
    }
    if (this.searches >= this.maxSearches) {
      return {
        output: {
          error: {
            code: "search_limit_reached",
            message: `At most ${this.maxSearches} searches per run.`,
          },
        },
        isError: true,
        newlyLoaded: [],
      };
    }
    this.searches++;
    const { query, limit } = input as z.infer<typeof searchInput>;
    const want = Math.min(limit ?? this.maxPerSearch, this.maxPerSearch);

    let recorded: Recorded;
    try {
      recorded = await ctx.decide<Recorded>(
        decisionKey,
        async () => {
          // Over-ask by what cannot be shown (already loaded, namespace-hidden, active skills) so
          // filtering does not starve the page; if a shared ranker over a WIDER catalog still leaves
          // it short, widen (bounded rounds / hits) while the ranker has more to give.
          if (this.dual) return this.searchDual(query, want);
          let ask = Math.min(
            want +
              this.loadedIds.size +
              (this.byId.size - this.searchable.size) +
              (this.skillSource?.activeCount ?? 0),
            MAX_RANK_ASK
          );
          let adm: { tools: string[]; skills: string[] } = { tools: [], skills: [] };
          for (let round = 0; round < MAX_RANK_ROUNDS; round++) {
            const ranked = await this.ranker.rank(query, ask);
            adm = this.admitRanked(
              ranked.map((h) => h.id),
              want
            );
            if (
              adm.tools.length + adm.skills.length >= want ||
              ranked.length < ask ||
              ask >= MAX_RANK_ASK
            )
              break;
            ask = Math.min(ask * 2, MAX_RANK_ASK);
          }
          return {
            ranker: this.ranker.kind,
            query: query.slice(0, MAX_RECORDED_QUERY),
            results: adm.tools,
            loaded: this.plan(adm.tools),
            ...(this.skillSource !== undefined && { skills: adm.skills }),
          };
        },
        { source: SOURCE_TOOL_SEARCH }
      );
    } catch (err) {
      // R10: a failing ranker is feedback, not a dead run. The decider threw, so NOTHING was
      // recorded; the reason is fixed (the error text is host/ranker bytes, never shown to the model).
      // A terminal error (cancellation, kill switch, quota, a park...) still reaches the runtime.
      if (isTerminalToolError(err)) throw err;
      return {
        output: {
          error: {
            code: "search_unavailable",
            message: "Tool search is unavailable right now.",
          },
        },
        isError: true,
        newlyLoaded: [],
      };
    }

    // Live and replayed alike: the record is re-intersected with what THIS run may use, so a stale,
    // garbage or tampered record can narrow the menu and can never widen it (or exceed the caps).
    // A record that is not the expected shape is an empty (refused) one.
    const rec = recorded !== null && typeof recorded === "object" ? recorded : undefined;
    const results = this.admit(Array.isArray(rec?.results) ? rec.results : [], want);
    // R22b: skill hits share the page budget with tool hits (tools first on a replay), and are
    // re-admitted against the LIVE discoverable set (a forged id, an upfront-selected or an already
    // active skill is dropped). They load nothing.
    const skillIds = this.admitSkills(
      this.skillSource !== undefined && Array.isArray(rec?.skills) ? rec.skills : [],
      want - results.length
    );
    const planned = this.plan(results);
    const recordedLoaded = new Set<unknown>(Array.isArray(rec?.loaded) ? rec.loaded : []);
    const toLoad = planned.filter((id) => recordedLoaded.has(id));
    const newlyLoaded: ToolDefinition[] = [];
    for (const id of toLoad) {
      const t = this.byId.get(id) as ToolDefinition;
      this.loadedIds.add(id);
      this.searchLoaded++;
      this.menuChars += this.specChars(t);
      newlyLoaded.push(t);
    }
    const loadedNow = new Set(toLoad);
    const hits: ToolSearchHit[] = results.map((id) => {
      const t = this.byId.get(id) as ToolDefinition;
      return {
        name: id,
        description: hitDescription(t),
        loaded: loadedNow.has(id),
      };
    });
    const output: Record<string, unknown> = { tools: hits };
    if (this.skillSource !== undefined) {
      output.skills = skillIds.map(
        (id): SkillSearchHit => ({
          kind: "skill",
          id,
          description: firstLineOf(
            String((this.skillById.get(id) as SkillDefinition).description),
            MAX_RESULT_DESCRIPTION
          ),
        })
      );
    }
    if (hits.some((h) => !h.loaded)) {
      output.note = "The tool list is full: matches with loaded=false cannot be called.";
    }
    if (hits.length === 0) {
      output.note =
        this.skillSource !== undefined && skillIds.length > 0
          ? `Only skills matched: pass an id to \`${this.skillSource.activationName}\` to load it.`
          : this.skillSource !== undefined
            ? "No matching tools or skills."
            : "No matching tools.";
    }
    // Any third-party tool in the result puts attacker-influenced bytes (its name, its vouched text)
    // in front of the model: fence the whole result as data (ADR 0085), same as an MCP tool's own output.
    const third = results.find((id) => isThirdParty(this.byId.get(id) as ToolDefinition));
    return {
      output: third === undefined ? output : tainted(output, `tool-search:${third}`),
      isError: false,
      newlyLoaded,
    };
  }

  private isSkillKey(k: string): boolean {
    return this.combined && k.startsWith(SKILL_KEY);
  }

  /**
   * R22c (ADR 0125 D13) — one search with two rankers. The tool ranker sees tool docs only, the skill
   * ranker skill docs only (raw ids); each is over-asked and widened on its OWN, bounded, and a
   * ranker's output is admitted as its own kind only (a skill-looking key from the tool ranker is not
   * a tool id and is dropped). The page is composed by rank POSITION, tool first (t1, s1, t2, s2, ...)
   * up to `want`; a kind that runs out hands its unused share to the other. Scores are never compared.
   */
  private async searchDual(query: string, want: number): Promise<Recorded> {
    const tools = await this.rankKind(
      this.ranker,
      query,
      want + this.loadedIds.size + (this.byId.size - this.searchable.size),
      want,
      (ids) => this.admit(ids, want)
    );
    const skills = await this.rankKind(
      this.skillRanker as ToolRanker,
      query,
      want + (this.skillSource?.activeCount ?? 0),
      want,
      (ids) => this.admitSkills(ids, want)
    );
    const page = interleave(tools, skills, want);
    return {
      ranker: this.ranker.kind,
      query: query.slice(0, MAX_RECORDED_QUERY),
      results: page.first,
      loaded: this.plan(page.first),
      skills: page.second,
      skillRanker: (this.skillRanker as ToolRanker).kind,
    };
  }

  /** Rank with `ranker`, over-asking `ask0` and widening (doubling) while the admitted list is short and the ranker has more. */
  private async rankKind(
    ranker: ToolRanker,
    query: string,
    ask0: number,
    want: number,
    admitIds: (ids: string[]) => string[]
  ): Promise<string[]> {
    let ask = Math.min(ask0, MAX_RANK_ASK);
    let out: string[] = [];
    for (let round = 0; round < MAX_RANK_ROUNDS; round++) {
      const ranked = await ranker.rank(query, ask);
      out = admitIds(ranked.map((h) => h.id));
      if (out.length >= want || ranked.length < ask || ask >= MAX_RANK_ASK) break;
      ask = Math.min(ask * 2, MAX_RANK_ASK);
    }
    return out;
  }

  /** Ranked index keys -> tool ids and skill ids, in ranked order, at most `want` in total. */
  private admitRanked(
    keys: readonly string[],
    want: number
  ): { tools: string[]; skills: string[] } {
    const tools: string[] = [];
    const skills: string[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      if (typeof k !== "string" || seen.has(k)) continue;
      seen.add(k);
      if (this.isSkillKey(k)) {
        const id = k.slice(SKILL_KEY.length);
        if (!this.skillAllowed(id)) continue;
        skills.push(id);
      } else {
        if (!this.searchable.has(k) || this.loadedIds.has(k)) continue;
        tools.push(k);
      }
      if (tools.length + skills.length >= want) break;
    }
    return { tools, skills };
  }

  /** Discoverable and not already active. */
  private skillAllowed(id: string): boolean {
    return this.skillById.has(id) && this.skillSource?.isActive(id) !== true;
  }

  /** Candidate skill ids -> the ones this run may be shown: discoverable, inactive, deduped, <= `max`. */
  private admitSkills(ids: readonly unknown[], max: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (out.length >= max) break;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      if (this.skillAllowed(id)) out.push(id);
    }
    return out;
  }

  /** Candidate ids -> the ones this run may be shown: offered, searchable, not loaded, deduped, <= `want`. */
  private admit(ids: readonly string[], want: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      if (this.isSkillKey(id) || !this.searchable.has(id) || this.loadedIds.has(id)) continue;
      out.push(id);
      if (out.length >= want) break;
    }
    return out;
  }

  /** Which of `results` fit in the menu (count and size caps), in order, stopping at the first that does not. */
  private plan(results: readonly string[]): string[] {
    const out: string[] = [];
    let count = this.searchLoaded;
    let chars = this.menuChars;
    for (const id of results) {
      if (count >= this.maxLoaded) break;
      // A tainted description can never be shown to the model (guardRequest refuses it in the tool
      // spec): the hit is LISTED (withheld, loaded=false) but the tool is not put on the menu.
      if (isTainted((this.byId.get(id) as ToolDefinition).description)) continue;
      if (this.maxMenuChars !== undefined) {
        const c = this.specChars(this.byId.get(id) as ToolDefinition);
        if (chars + c > this.maxMenuChars) break;
        chars += c;
      }
      count++;
      out.push(id);
    }
    return out;
  }
}

/**
 * R22c — the page rule for two independently ranked lists: alternate by rank position, `first` leading
 * (a1, b1, a2, b2, ...), until `want` are taken; when one list is exhausted the other fills the rest.
 * Positions are integers, so there are no ties and no score is ever compared.
 */
export function interleave(
  first: readonly string[],
  second: readonly string[],
  want: number
): { first: string[]; second: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  let i = 0;
  let j = 0;
  while (a.length + b.length < want && (i < first.length || j < second.length)) {
    if (i < first.length && (a.length <= b.length || j >= second.length))
      a.push(first[i++] as string);
    else b.push(second[j++] as string);
  }
  return { first: a, second: b };
}
